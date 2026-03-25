/**
 * Consensus OAuth：固定 CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL 时，进程内长期占用回调端口（Hub）。
 * 空闲时返回就绪页；发起授权时 oauth-session 仅注册/注销请求处理函数，不关闭 HTTP 监听。
 */
import http from 'node:http';
import { URL } from 'node:url';
import logger from '../utils/logger.js';
import { bindHostForOAuthListen } from './mcporter-oauth/oauth-session.js';
import { probeTcpPortAvailable } from './mcporter-oauth/oauth-callback-port.js';

/** @type {import('node:http').Server | null} */
let hubServer = null;

/** @type {string} */
let hubCallbackPath = '/callback';

/**
 * @type {((req: import('http').IncomingMessage, res: import('http').ServerResponse) => void | Promise<void>) | null}
 */
let activeOAuthHandler = null;

export function getConsensusOAuthRedirectUrlFromEnv() {
    return (process.env.CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL ?? '').trim();
}

/**
 * 注册真实 OAuth 回调处理；返回 unregister，调用后 Hub 回到空闲页。
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void | Promise<void>} handler
 * @returns {() => void}
 */
export function registerConsensusOAuthRequestHandler(handler) {
    const ref = handler;
    activeOAuthHandler = ref;
    return () => {
        if (activeOAuthHandler === ref) {
            activeOAuthHandler = null;
        }
    };
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function dispatch(req, res) {
    if (activeOAuthHandler) {
        await activeOAuthHandler(req, res);
        return;
    }
    try {
        const url = req.url ?? '';
        const parsed = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
        if (parsed.pathname !== hubCallbackPath) {
            res.statusCode = 404;
            res.end('Not found');
            return;
        }
        logger.info(
            `[Consensus OAuth Hub] ${req.method} ${url} (空闲态：尚未注册 OAuth 处理，返回就绪页；与 :3000/health 无关)`
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
            '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>OAuth callback</title></head><body><h1>OAuth 回调就绪</h1><p>请在管理控制台发起 Consensus 授权；授权进行中时由本端口处理回调。</p></body></html>'
        );
    } catch {
        res.statusCode = 500;
        res.end('Error');
    }
}

/**
 * 进程启动时调用一次：在固定端口上长期 listen（与 Docker 映射一致）。
 * @param {{ info?: (m: string) => void, warn?: (m: string) => void }} [log]
 * @returns {Promise<boolean>} 是否已有或成功启动 Hub
 */
export async function ensureConsensusOAuthCallbackHubStarted(log) {
    const L = log ?? { info: () => {}, warn: () => {}, error: () => {} };
    L.info('[Consensus OAuth Hub] ========== OAuth 回调 HTTP（持久监听）启动检查 ==========');

    if (hubServer) {
        const addr = hubServer.address();
        L.info(
            `[Consensus OAuth Hub] already running address=${typeof addr === 'object' && addr ? JSON.stringify(addr) : String(addr)}`
        );
        return true;
    }

    const raw = getConsensusOAuthRedirectUrlFromEnv();
    L.info(
        `[Consensus OAuth Hub] env CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL=${raw ? `"${raw}"` : '(未设置/空，将不启动 Hub)'}`
    );

    if (!raw) {
        L.info('[Consensus OAuth Hub] 结果: 未启动 — 原因: 环境变量未设置。Docker 请在 compose 中设置该变量并映射端口。');
        return false;
    }

    let u;
    try {
        u = new URL(raw);
    } catch {
        L.warn('[Consensus OAuth Hub] 结果: 未启动 — 原因: redirect URL 无法解析');
        return false;
    }

    const portStr = u.port;
    const port = portStr ? Number.parseInt(portStr, 10) : NaN;
    if (!Number.isFinite(port) || port <= 0) {
        L.info(
            '[Consensus OAuth Hub] 结果: 未启动 — 原因: URL 中缺少显式端口（需形如 http://127.0.0.1:19876/callback）'
        );
        return false;
    }

    const listenHost = u.hostname || '127.0.0.1';
    const bindHost = bindHostForOAuthListen(listenHost);
    const callbackPath = u.pathname && u.pathname !== '/' ? u.pathname : '/callback';
    hubCallbackPath = callbackPath;

    L.info(
        `[Consensus OAuth Hub] 将绑定 bindHost=${bindHost} port=${port} path=${callbackPath}（Docker 请映射宿主机端口 -> 容器 ${port}）`
    );

    const free = await probeTcpPortAvailable(bindHost, port);
    if (!free) {
        L.warn(
            `[Consensus OAuth Hub] 结果: 未启动 — 原因: 本机探测端口 ${port} 已被占用（probeTcpPortAvailable=false）。请检查是否有其他进程占用。`
        );
        return false;
    }

    const server = http.createServer((req, res) => {
        void dispatch(req, res);
    });

    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, bindHost, () => {
                server.removeListener('error', reject);
                resolve(undefined);
            });
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        L.error(`[Consensus OAuth Hub] 结果: 未启动 — listen 失败: ${msg}`);
        return false;
    }

    hubServer = server;
    const addr = server.address();
    const addrStr = typeof addr === 'object' && addr && 'port' in addr ? JSON.stringify(addr) : String(addr);
    L.info(`[Consensus OAuth Hub] 结果: 已启动 — Node 监听 address=${addrStr}`);
    L.info(
        `[Consensus OAuth Hub] 容器内自测: curl -s -o /dev/null -w "HTTP %{http_code}\\n" "http://127.0.0.1:${port}${callbackPath}"`
    );
    L.info(
        `[Consensus OAuth Hub] 查看监听(需镜像含 ss): ss -tlnp | grep ${port} 或 netstat -tlnp 2>/dev/null | grep ${port}`
    );
    return true;
}

/**
 * 仅进程退出时关闭 Hub（正常 OAuth 流程不调用）。
 * @param {{ info?: (m: string) => void }} [log]
 */
export async function shutdownConsensusOAuthCallbackHub(log) {
    if (!hubServer) {
        return;
    }
    activeOAuthHandler = null;
    const s = hubServer;
    hubServer = null;
    await new Promise((resolve) => {
        s.close(() => resolve(undefined));
    });
    log?.info?.('[Consensus OAuth Hub] shutdown');
}

/** @deprecated 使用 ensureConsensusOAuthCallbackHubStarted；占位名保留兼容 */
export async function startConsensusOAuthCallbackPlaceholderIfConfigured(log) {
    return ensureConsensusOAuthCallbackHubStarted(log);
}

/** @deprecated 使用 shutdownConsensusOAuthCallbackHub；OAuth 流程不应关闭监听 */
export async function stopConsensusOAuthCallbackPlaceholder(log) {
    return shutdownConsensusOAuthCallbackHub(log);
}

export function isConsensusOAuthCallbackPlaceholderActive() {
    return hubServer !== null;
}
