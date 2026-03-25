/**
 * MCP OAuth access_token 刷新：与 mcporter / `@modelcontextprotocol/sdk` 的 `auth()` 内分支一致
 *（refresh_token + token endpoint + saveTokens 写回 vault 与 tokenCacheDir）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    discoverOAuthServerInfo,
    refreshAuthorization,
    selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { buildOAuthPersistence } from './oauth-persistence.js';

const DEFAULT_OPAQUE_ACCESS_TTL_SEC = 3600;
const MCP_VAULT_PATH = path.join(os.homedir(), '.mcporter', 'credentials.json');

/**
 * @param {string | undefined} accessToken
 * @returns {number | null} access_token 过期时刻（ms），非 JWT 则 null
 */
export function jwtExpiresAtMs(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken.includes('.')) {
        return null;
    }
    const parts = accessToken.split('.');
    if (parts.length < 2) {
        return null;
    }
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
        const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
        const payload = JSON.parse(json);
        if (typeof payload.exp === 'number') {
            return payload.exp * 1000;
        }
    } catch {
        /* ignore */
    }
    return null;
}

/**
 * 估算 access_token 过期时间（ms），供号池 isExpiryDateNear 使用。
 * 顺序：JWT exp → tokens.json mtime + expires_in → vault mtime + expires_in（或默认 TTL）。
 *
 * @param {Record<string, unknown> | null | undefined} tokens
 * @param {string | null} tokensJsonAbsPath - tokenCacheDir/tokens.json
 * @param {string} [vaultAbsPath]
 * @returns {number | null}
 */
export function computeMcpAccessTokenExpiryMs(tokens, tokensJsonAbsPath, vaultAbsPath = MCP_VAULT_PATH) {
    const jwt = jwtExpiresAtMs(typeof tokens?.access_token === 'string' ? tokens.access_token : undefined);
    if (jwt != null) {
        return jwt;
    }
    const expIn = Number(tokens?.expires_in);
    const ttlSec = Number.isFinite(expIn) && expIn > 0 ? expIn : DEFAULT_OPAQUE_ACCESS_TTL_SEC;

    if (tokensJsonAbsPath && fs.existsSync(tokensJsonAbsPath)) {
        try {
            const st = fs.statSync(tokensJsonAbsPath);
            if (Number.isFinite(expIn) && expIn > 0) {
                return st.mtimeMs + expIn * 1000;
            }
            return st.mtimeMs + DEFAULT_OPAQUE_ACCESS_TTL_SEC * 1000;
        } catch {
            /* ignore */
        }
    }

    if (vaultAbsPath && fs.existsSync(vaultAbsPath)) {
        try {
            const st = fs.statSync(vaultAbsPath);
            return st.mtimeMs + ttlSec * 1000;
        } catch {
            /* ignore */
        }
    }

    return null;
}

/**
 * 使用 refresh_token 换新的 access_token，并经由 CompositePersistence 写回（与 mcporter 落盘一致）。
 *
 * @param {{ name: string, command: { kind: string, url?: URL }, tokenCacheDir?: string, oauthRedirectUrl?: string }} definition
 * @param {{ info?: Function, warn?: Function, error?: Function }} logger
 * @param {{ fetchFn?: typeof fetch }} [opts]
 */
/** @param {number} ms */
function iso(ms) {
    try {
        return new Date(ms).toISOString();
    } catch {
        return String(ms);
    }
}

export async function refreshMcpOAuthAccessToken(definition, logger, opts = {}) {
    const fetchFn = opts.fetchFn ?? fetch;
    const persistence = await buildOAuthPersistence(definition, logger);
    const tokens = await persistence.readTokens();
    logger.info?.(
        `[Consensus MCP OAuth] refresh[1/6] 开始 | server=${definition.name} persistence=${persistence.describe()} oauthRedirectUrl=${definition.oauthRedirectUrl ?? '(none)'} tokenCacheDir=${definition.tokenCacheDir ?? '(vault only)'}`
    );

    if (!tokens?.refresh_token || typeof tokens.refresh_token !== 'string') {
        throw new Error('MCP OAuth refresh: missing refresh_token in vault/token cache');
    }
    const clientInformation = await persistence.readClientInfo();
    if (!clientInformation || typeof clientInformation !== 'object') {
        throw new Error('MCP OAuth refresh: missing client registration (clientInfo)');
    }

    const rtLen = tokens.refresh_token.length;
    const atLen = typeof tokens.access_token === 'string' ? tokens.access_token.length : 0;
    const expInPrev = Number(tokens.expires_in);
    const prevExpHint = computeMcpAccessTokenExpiryMs(tokens, definition.tokenCacheDir ? path.join(definition.tokenCacheDir, 'tokens.json') : null);
    logger.info?.(
        `[Consensus MCP OAuth] refresh[2/6] 当前凭据 | refresh_token_len=${rtLen} access_token_len=${atLen} expires_in=${Number.isFinite(expInPrev) ? expInPrev : 'n/a'} 推断过期(UTC)=${prevExpHint != null ? iso(prevExpHint) : 'unknown'}`
    );

    const cid =
        clientInformation && typeof clientInformation === 'object' && 'client_id' in clientInformation
            ? String(/** @type {{ client_id?: string }} */ (clientInformation).client_id ?? '')
            : '';
    logger.info?.(
        `[Consensus MCP OAuth] refresh[3/6] 动态注册客户端 | client_id_prefix=${cid ? `${cid.slice(0, 12)}…` : 'empty'} client_id_len=${cid.length}`
    );

    const serverUrl = definition.command?.url;
    if (!serverUrl || !(serverUrl instanceof URL)) {
        throw new Error('MCP OAuth refresh: definition.command.url must be a URL');
    }

    logger.info?.(`[Consensus MCP OAuth] refresh[4/6] 发现授权服务 | MCP resource URL=${serverUrl.href}`);
    const tDiscover = Date.now();
    const serverInfo = await discoverOAuthServerInfo(serverUrl, { fetchFn });
    const authBase =
        typeof serverInfo.authorizationServerUrl === 'string'
            ? serverInfo.authorizationServerUrl
            : String(serverInfo.authorizationServerUrl);
    const meta = serverInfo.authorizationServerMetadata;
    const tokenEp = meta && typeof meta === 'object' && 'token_endpoint' in meta ? String(/** @type {{ token_endpoint?: string }} */ (meta).token_endpoint ?? '') : '';
    logger.info?.(
        `[Consensus MCP OAuth] refresh[4/6] 发现完成 | durationMs=${Date.now() - tDiscover} authorization_server=${authBase} token_endpoint=${tokenEp || 'n/a'} has_protected_resource_metadata=${serverInfo.resourceMetadata ? 'yes' : 'no'}`
    );

    const resource = await selectResourceURL(serverUrl, {}, serverInfo.resourceMetadata);
    logger.info?.(
        `[Consensus MCP OAuth] refresh[5/6] 请求 refresh_token 换发 | OAuth2 grant_type=refresh_token resource=${resource ? resource.href : '(none)'}`
    );

    const tReq = Date.now();
    const newTokens = await refreshAuthorization(serverInfo.authorizationServerUrl, {
        metadata: serverInfo.authorizationServerMetadata,
        clientInformation,
        refreshToken: tokens.refresh_token,
        resource,
        addClientAuthentication: undefined,
        fetchFn,
    });
    logger.info?.(
        `[Consensus MCP OAuth] refresh[5/6] 授权服务器响应 | durationMs=${Date.now() - tReq} token_type=${typeof newTokens.token_type === 'string' ? newTokens.token_type : 'n/a'} expires_in=${newTokens.expires_in != null ? String(newTokens.expires_in) : 'n/a'} access_token_len=${typeof newTokens.access_token === 'string' ? newTokens.access_token.length : 0} refresh_rotated=${typeof newTokens.refresh_token === 'string' && newTokens.refresh_token !== tokens.refresh_token ? 'yes' : 'no'}`
    );

    await persistence.saveTokens(newTokens);
    const postHint = computeMcpAccessTokenExpiryMs(
        newTokens,
        definition.tokenCacheDir ? path.join(definition.tokenCacheDir, 'tokens.json') : null
    );
    logger.info?.(
        `[Consensus MCP OAuth] refresh[6/6] 已落盘 | targets=${persistence.describe()} 新 access 推断过期(UTC)=${postHint != null ? iso(postHint) : 'unknown'}`
    );
}
