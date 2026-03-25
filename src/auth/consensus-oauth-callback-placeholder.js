/**
 * Consensus OAuth：固定 CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL 时，进程内长期占用回调端口（Hub）。
 * 空闲时返回就绪页；发起授权时 oauth-session 仅注册/注销请求处理函数，不关闭 HTTP 监听。
 */
import http from 'node:http';
import { URL } from 'node:url';
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
    if (hubServer) {
        return true;
    }
    const raw = getConsensusOAuthRedirectUrlFromEnv();
    if (!raw) {
        log?.info?.('[Consensus OAuth Hub] skip: CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL empty');
        return false;
    }
    let u;
    try {
        u = new URL(raw);
    } catch {
        log?.warn?.('[Consensus OAuth Hub] skip: invalid redirect URL');
        return false;
    }
    const portStr = u.port;
    const port = portStr ? Number.parseInt(portStr, 10) : NaN;
    if (!Number.isFinite(port) || port <= 0) {
        log?.info?.(
            '[Consensus OAuth Hub] skip: need explicit port in redirect URL (e.g. http://127.0.0.1:19876/callback)'
        );
        return false;
    }
    const listenHost = u.hostname || '127.0.0.1';
    const bindHost = bindHostForOAuthListen(listenHost);
    const callbackPath = u.pathname && u.pathname !== '/' ? u.pathname : '/callback';
    hubCallbackPath = callbackPath;

    const free = await probeTcpPortAvailable(bindHost, port);
    if (!free) {
        log?.info?.(`[Consensus OAuth Hub] skip: port ${port} already in use`);
        return false;
    }

    const server = http.createServer((req, res) => {
        void dispatch(req, res);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bindHost, () => {
            server.removeListener('error', reject);
            resolve(undefined);
        });
    });
    hubServer = server;
    log?.info?.(
        `[Consensus OAuth Hub] persistent listen bindHost=${bindHost} port=${port} path=${callbackPath}`
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
