/**
 * 使用 MCP SDK + 与 mcporter 一致的 vault/tokenCache/oauth 会话，完成 Consensus MCP OAuth（不 spawn mcporter）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createOAuthSession } from './mcporter-oauth/oauth-session.js';
import { connectWithAuth, DEFAULT_OAUTH_CODE_TIMEOUT_MS } from './mcporter-oauth/mcp-connect-oauth.js';
import { readCachedAccessToken } from './mcporter-oauth/oauth-persistence.js';

/** @type {{ session: any, transport: any } | null} */
let activeNativeHandle = null;

/** @type {((v: string) => void) | null} */
let pendingAuthUrlResolve = null;

/** @type {((e: Error) => void) | null} */
let pendingAuthUrlReject = null;

/**
 * @param {string} serverName
 * @param {string} mcpUrl
 * @param {string} [oauthRedirectUrl]
 * @param {string|null} [tokenCacheDirAbs]
 */
export function buildConsensusServerDefinition(serverName, mcpUrl, oauthRedirectUrl, tokenCacheDirAbs) {
    const def = {
        name: serverName,
        command: { kind: 'http', url: new URL(mcpUrl), headers: {} },
        auth: 'oauth',
    };
    if (oauthRedirectUrl) {
        def.oauthRedirectUrl = oauthRedirectUrl;
    }
    if (tokenCacheDirAbs) {
        def.tokenCacheDir = tokenCacheDirAbs;
    }
    return def;
}

/**
 * 取消进行中的原生 OAuth：关闭回调 HTTP（释放监听端口）、关闭 transport，使 waitForAuthorizationCode 失败。
 * 注意：正常 OAuth 流程结束（成功/超时）时不再自动关闭回调 HTTP，须由本函数或前端 cancel-auth 显式关闭。
 * @param {{ info?: (m: string) => void }} [log]
 */
/** 是否存在本会话尚未结束的 OAuth 回调监听（与 mcporter 并跑时仍可能占用同端口，生成授权前会先关闭） */
export function hasActiveConsensusOAuthSession() {
    return activeNativeHandle !== null;
}

/**
 * @param {{ info?: (m: string) => void, warn?: (m: string) => void }} [log]
 * @param {{ restartPlaceholder?: boolean }} [options] - restartPlaceholder 已废弃（Hub 常驻，无需重启）
 */
export async function cancelConsensusNativeOAuthSession(log, options = {}) {
    void options;
    if (pendingAuthUrlReject) {
        try {
            pendingAuthUrlReject(new Error('OAuth cancelled'));
        } catch {
            /* ignore */
        }
        pendingAuthUrlReject = null;
        pendingAuthUrlResolve = null;
    }
    const h = activeNativeHandle;
    activeNativeHandle = null;
    if (h?.session) {
        await h.session.close().catch(() => {});
    }
    if (h?.transport) {
        await h.transport.close().catch(() => {});
    }
    log?.info?.('[Consensus Native OAuth] cancel: OAuth handler cleared (shared callback hub keeps listening)');
}

/**
 * @param {object} opts
 * @param {{ info: Function, warn: Function, error: Function, debug?: Function }} opts.appLogger
 * @param {string} opts.serverName
 * @param {string} opts.mcpUrl
 * @param {string} [opts.oauthRedirectUrl]
 * @param {string|null} [opts.tokenCacheDirAbs]
 * @param {number} [opts.oauthTimeoutMs]
 * @param {number} [opts.urlCaptureTimeoutMs]
 * @param {(ctx: { definition: object }) => Promise<void>} [opts.onOAuthComplete]
 *        在 `connectWithAuth` 成功且 `readCachedAccessToken` 确认已落盘 access_token 后调用（回调换 token 完成并写入 vault/tokenCache 之后）。
 */
export async function startConsensusNativeOAuth(opts) {
    const {
        appLogger,
        serverName,
        mcpUrl,
        oauthRedirectUrl,
        tokenCacheDirAbs,
        oauthTimeoutMs = DEFAULT_OAUTH_CODE_TIMEOUT_MS,
        urlCaptureTimeoutMs = 45_000,
        onOAuthComplete,
    } = opts;

    const hadExistingListener = activeNativeHandle !== null;
    await cancelConsensusNativeOAuthSession(appLogger, { restartPlaceholder: false });
    if (hadExistingListener) {
        appLogger.info(
            '[Consensus Native OAuth] 生成授权：已关闭本会话上一轮的回调 HTTP，避免重复占用端口后再启动新监听'
        );
    } else {
        appLogger.info('[Consensus Native OAuth] 生成授权：无未结束的回调监听，将开启新的回调 HTTP');
    }

    const definition = buildConsensusServerDefinition(serverName, mcpUrl, oauthRedirectUrl, tokenCacheDirAbs);

    const oauthLogger = {
        info: (m) => appLogger.info(m),
        warn: (m) => appLogger.warn(m),
        error: (m, e) => {
            if (e !== undefined) {
                appLogger.error(m, e);
            } else {
                appLogger.error(m);
            }
        },
        debug: (m) => appLogger.debug?.(m),
    };

    const authUrlPromise = new Promise((resolve, reject) => {
        pendingAuthUrlResolve = resolve;
        pendingAuthUrlReject = reject;
    });

    let authUrlEmitted = false;
    let useConsensusHub = false;
    if (oauthRedirectUrl) {
        try {
            const u = new URL(oauthRedirectUrl);
            useConsensusHub = !!(u.port && u.port !== '0');
        } catch {
            useConsensusHub = false;
        }
    }
    const session = await createOAuthSession(definition, oauthLogger, {
        skipOpenBrowser: true,
        useConsensusHub,
        onAuthorizationUrl: (url) => {
            if (authUrlEmitted) {
                return;
            }
            authUrlEmitted = true;
            appLogger.info(
                `[Consensus Native OAuth] authorization URL captured for UI len=${url.length} (open in browser; callback must reach this host)`
            );
            if (pendingAuthUrlResolve) {
                pendingAuthUrlResolve(url);
                pendingAuthUrlResolve = null;
                pendingAuthUrlReject = null;
            }
        },
    });

    const client = new Client({ name: 'aiclient-consensus-oauth', version: '1.0.0' });
    let transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: undefined,
        authProvider: session.provider,
    });

    const recreateTransport = () => {
        const next = new StreamableHTTPClientTransport(new URL(mcpUrl), {
            requestInit: undefined,
            authProvider: session.provider,
        });
        if (activeNativeHandle?.session === session) {
            activeNativeHandle = { session, transport: next };
        }
        return next;
    };

    activeNativeHandle = { session, transport };

    appLogger.info(
        `[Consensus Native OAuth] starting connectWithAuth server=${serverName} mcpUrl=${mcpUrl} oauthTimeoutMs=${oauthTimeoutMs} urlCaptureTimeoutMs=${urlCaptureTimeoutMs}`
    );

    const flowPromise = (async () => {
        try {
            transport = await connectWithAuth(client, transport, session, oauthLogger, {
                serverName,
                maxAttempts: 3,
                oauthTimeoutMs,
                recreateTransport,
            });
            if (activeNativeHandle?.session === session) {
                activeNativeHandle = { session, transport };
            }
            appLogger.info('[Consensus Native OAuth] client.connect succeeded (OAuth finished or cached credentials worked)');
            const access = await readCachedAccessToken(definition, oauthLogger);
            if (!access) {
                throw new Error('OAuth 流程已结束但 readCachedAccessToken 为空，请检查 ~/.mcporter/credentials.json 与 tokenCacheDir');
            }
            appLogger.info(
                `[Consensus Native OAuth] 授权判定成功：vault/缓存中已存在 access_token（与 mcporter 落盘一致） tokenLen=${access.length}`
            );
            if (typeof onOAuthComplete === 'function') {
                appLogger.info('[Consensus Native OAuth] 调用 onOAuthComplete（换取 token 并已落盘后的确认）');
                await onOAuthComplete({ definition });
            }
            return { ok: true };
        } finally {
            await transport.close().catch(() => {});
            // 不调用 session.close()：回调 HTTP 保持监听，直至用户在前端点「取消」触发 cancel-auth，
            // 或授权成功关闭弹框时前端在 oauth_success 路径调用 cancel-auth。
            if (activeNativeHandle?.session === session) {
                activeNativeHandle = { session, transport: null };
            }
            appLogger.info(
                '[Consensus Native OAuth] flow finally: transport closed; callback HTTP 仍监听直至 cancel-auth（用户取消或授权成功关弹框）'
            );
        }
    })();

    /** @type {{ kind: 'url', u: string } | { kind: 'done' } | { kind: 'timeout' }} */
    let first;
    try {
        first = await Promise.race([
            authUrlPromise.then((u) => ({ kind: 'url', u })),
            flowPromise.then(() => ({ kind: 'done' })),
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error('timeout waiting for authorization URL or immediate connect')), urlCaptureTimeoutMs)
            ),
        ]);
    } catch (e) {
        await transport.close().catch(() => {});
        await session.close().catch(() => {});
        activeNativeHandle = null;
        if (pendingAuthUrlReject) {
            try {
                pendingAuthUrlReject(e instanceof Error ? e : new Error(String(e)));
            } catch {
                /* ignore */
            }
            pendingAuthUrlReject = null;
            pendingAuthUrlResolve = null;
        }
        throw e;
    }

    if (first.kind === 'done') {
        appLogger.info('[Consensus Native OAuth] 未出现浏览器授权链接：可能已有有效 token，连接直接成功');
        const access = await readCachedAccessToken(definition, oauthLogger);
        if (!access) {
            throw new Error('连接成功但无法读取 access_token');
        }
        return {
            authUrl: null,
            alreadyAuthed: true,
            flowPromise,
            definition,
        };
    }

    if (first.kind === 'url') {
        return {
            authUrl: first.u,
            alreadyAuthed: false,
            flowPromise,
            definition,
        };
    }

}
