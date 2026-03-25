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
 * @param {{ info?: (m: string) => void }} [log]
 */
export async function cancelConsensusNativeOAuthSession(log) {
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
    log?.info?.('[Consensus Native OAuth] cancel: callback HTTP server closed and transport closed');
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
    } = opts;

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
    const session = await createOAuthSession(definition, oauthLogger, {
        skipOpenBrowser: true,
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
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: undefined,
        authProvider: session.provider,
    });

    activeNativeHandle = { session, transport };

    appLogger.info(
        `[Consensus Native OAuth] starting connectWithAuth server=${serverName} mcpUrl=${mcpUrl} oauthTimeoutMs=${oauthTimeoutMs} urlCaptureTimeoutMs=${urlCaptureTimeoutMs}`
    );

    const flowPromise = (async () => {
        try {
            await connectWithAuth(client, transport, session, oauthLogger, {
                serverName,
                maxAttempts: 3,
                oauthTimeoutMs,
            });
            appLogger.info('[Consensus Native OAuth] client.connect succeeded (OAuth finished or cached credentials worked)');
            const access = await readCachedAccessToken(definition, oauthLogger);
            if (!access) {
                throw new Error('OAuth 流程已结束但 readCachedAccessToken 为空，请检查 ~/.mcporter/credentials.json 与 tokenCacheDir');
            }
            appLogger.info(
                `[Consensus Native OAuth] 授权判定成功：vault/缓存中已存在 access_token（与 mcporter 落盘一致） tokenLen=${access.length}`
            );
            return { ok: true };
        } finally {
            await transport.close().catch(() => {});
            await session.close().catch(() => {});
            if (activeNativeHandle?.session === session) {
                activeNativeHandle = null;
            }
            appLogger.info('[Consensus Native OAuth] flow finally: transport and callback server closed');
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
