/**
 * 与 mcporter `src/oauth.ts` 对齐：PersistentOAuthClientProvider、回调 HTTP、落盘逻辑；
 * 额外支持 skipOpenBrowser + onAuthorizationUrl（供 UI 返回链接而不自动打开浏览器）。
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { URL } from 'node:url';
import { buildOAuthPersistence } from './oauth-persistence.js';
import { probeTcpPortAvailable } from './oauth-callback-port.js';

/**
 * @typedef {{ info: (m: string) => void, warn: (m: string) => void, error: (m: string, e?: unknown) => void }} OAuthLogger
 */

const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';

/** 供 HTTP 实际 bind：Docker 端口映射会把流量打到容器 eth0，只监听 127.0.0.1/localhost 时宿主机浏览器访问不到 */
export function bindHostForOAuthListen(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') {
        return '0.0.0.0';
    }
    return hostname;
}

/** @template T @returns {{ promise: Promise<T>, resolve: (v: T) => void, reject: (r?: unknown) => void }} */
function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function openExternal(url, platform = process.platform, launch = spawn) {
    const stdio = 'ignore';
    const swallowSpawnError = (child) => {
        child.on('error', () => {});
        child.unref();
    };
    try {
        if (platform === 'darwin') {
            const child = launch('open', [url], { stdio, detached: true });
            swallowSpawnError(child);
        } else if (platform === 'win32') {
            const cmdPath =
                process.env.ComSpec?.trim() || path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
            const child = launch(cmdPath, ['/c', 'start', '""', url], { stdio, detached: true });
            child.on('error', () => {
                try {
                    const fallback = launch('rundll32', ['url.dll,FileProtocolHandler', url], { stdio, detached: true });
                    swallowSpawnError(fallback);
                } catch {
                    /* best-effort */
                }
            });
            swallowSpawnError(child);
        } else {
            try {
                const child = launch('xdg-open', [url], { stdio, detached: true });
                child.on('error', () => {});
                child.unref();
            } catch {
                /* headless */
            }
        }
    } catch {
        /* best-effort */
    }
}

class PersistentOAuthClientProvider {
    /**
     * @param {any} definition
     * @param {any} persistence
     * @param {URL} redirectUrl
     * @param {OAuthLogger} logger
     * @param {{ skipOpenBrowser?: boolean, onAuthorizationUrl?: (u: string) => void, useConsensusHub?: boolean }} [hooks]
     */
    constructor(definition, persistence, redirectUrl, logger, hooks = {}) {
        this.definition = definition;
        this.persistence = persistence;
        this.redirectUrlValue = redirectUrl;
        this.logger = logger;
        this.hooks = hooks;
        /** @type {(() => void) | undefined} */
        this._hubUnregister = undefined;
        /** @type {ReturnType<typeof createDeferred<string>> | null} */
        this.authorizationDeferred = null;
        /** @type {http.Server | undefined} */
        this.server = undefined;
        this.metadata = {
            client_name: definition.clientName ?? `mcporter (${definition.name})`,
            redirect_uris: [this.redirectUrlValue.toString()],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            ...(definition.oauthScope !== undefined ? { scope: definition.oauthScope || undefined } : {}),
        };
    }

    /**
     * @param {any} definition
     * @param {OAuthLogger} logger
     * @param {{ skipOpenBrowser?: boolean, onAuthorizationUrl?: (u: string) => void, useConsensusHub?: boolean }} [hooks]
     */
    static async create(definition, logger, hooks = {}) {
        const persistence = await buildOAuthPersistence(definition, logger);

        const overrideRedirect = definition.oauthRedirectUrl ? new URL(definition.oauthRedirectUrl) : null;
        const listenHost = overrideRedirect?.hostname ?? CALLBACK_HOST;
        const bindHost = bindHostForOAuthListen(listenHost);
        const overridePort = overrideRedirect?.port ?? '';
        const usesDynamicPort = !overrideRedirect || overridePort === '' || overridePort === '0';
        const desiredPort = usesDynamicPort ? undefined : Number.parseInt(overridePort, 10);
        const callbackPath =
            overrideRedirect?.pathname && overrideRedirect.pathname !== '/' ? overrideRedirect.pathname : CALLBACK_PATH;

        /** Consensus：与进程启动时创建的共享回调 Hub 共用同一端口，不再单独 listen/close */
        if (
            hooks.useConsensusHub &&
            !usesDynamicPort &&
            desiredPort !== undefined &&
            Number.isFinite(desiredPort)
        ) {
            const hubModule = await import('../consensus-oauth-callback-placeholder.js');
            const hubOk = await hubModule.ensureConsensusOAuthCallbackHubStarted(logger);
            if (hubOk) {
                const redirectUrl = new URL(overrideRedirect.toString());
                if (!overrideRedirect || overrideRedirect.pathname === '/' || overrideRedirect.pathname === '') {
                    redirectUrl.pathname = callbackPath;
                }
                const provider = new PersistentOAuthClientProvider(definition, persistence, redirectUrl, logger, hooks);
                const unregister = hubModule.registerConsensusOAuthRequestHandler((req, res) => {
                    void provider.onHttpRequest(req, res);
                });
                provider._hubUnregister = unregister;
                logger.info(
                    `[Native OAuth] using persistent Consensus callback hub path=${redirectUrl.pathname} effectiveRedirectUri=${redirectUrl.toString()}`
                );
                return {
                    provider,
                    close: async () => {
                        await provider.close();
                    },
                };
            }
            logger.warn(
                '[Native OAuth] Consensus hub unavailable (port busy or not configured); falling back to standalone callback listener'
            );
        }

        if (!usesDynamicPort && desiredPort !== undefined && Number.isFinite(desiredPort)) {
            const free = await probeTcpPortAvailable(bindHost, desiredPort);
            if (!free) {
                logger.info(
                    `[Native OAuth] 固定回调端口已被占用，不开启新的回调监听 host=${listenHost} bindHost=${bindHost} port=${desiredPort}（请结束占用进程或更换 oauthRedirectUrl）`
                );
                throw new Error(
                    `OAuth 回调地址端口已被占用：${listenHost}:${desiredPort}。请关闭占用该端口的进程，或修改 CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL / mcporter.json 中的 oauthRedirectUrl。`
                );
            }
            logger.info(
                `[Native OAuth] 固定回调端口探测可用，将绑定回调 HTTP listenHost=${listenHost} bindHost=${bindHost} port=${desiredPort}（Docker 映射时请 bind 0.0.0.0）`
            );
        }

        const server = http.createServer();

        const port = await new Promise((resolve, reject) => {
            server.listen(desiredPort ?? 0, bindHost, () => {
                const address = server.address();
                if (typeof address === 'object' && address && 'port' in address) {
                    resolve(address.port);
                } else {
                    reject(new Error('Failed to determine callback port'));
                }
            });
            server.once('error', (error) => {
                const code = /** @type {NodeJS.ErrnoException} */ (error).code;
                if (code === 'EADDRINUSE') {
                    logger.info(
                        `[Native OAuth] listen 失败 EADDRINUSE bindHost=${bindHost} port=${desiredPort ?? 'dynamic'}`
                    );
                    reject(
                        new Error(
                            `OAuth 回调端口绑定失败（已被占用）：${listenHost}:${desiredPort ?? '?'}. 请更换端口或结束占用进程。`
                        )
                    );
                    return;
                }
                reject(error);
            });
        });

        const redirectUrl = overrideRedirect ? new URL(overrideRedirect.toString()) : new URL(`http://${listenHost}:${port}${callbackPath}`);
        if (usesDynamicPort) {
            redirectUrl.port = String(port);
        }
        if (!overrideRedirect || overrideRedirect.pathname === '/' || overrideRedirect.pathname === '') {
            redirectUrl.pathname = callbackPath;
        }

        if (usesDynamicPort) {
            try {
                const cachedClient = await persistence.readClientInfo();
                const cachedRedirect = firstRedirectUri(cachedClient);
                if (cachedRedirect && cachedRedirect !== redirectUrl.toString()) {
                    logger.info(
                        `Redirect URI changed (${cachedRedirect} → ${redirectUrl.toString()}); clearing stale client registration.`
                    );
                    await persistence.clear('client');
                }
            } catch (error) {
                await new Promise((resolve) => {
                    server.close(() => resolve());
                });
                throw error;
            }
        }

        const provider = new PersistentOAuthClientProvider(definition, persistence, redirectUrl, logger, hooks);
        provider.attachServer(server);
        logger.info(
            `[Native OAuth] Callback server listening bindHost=${bindHost} port=${port} path=${redirectUrl.pathname} effectiveRedirectUri=${redirectUrl.toString()}`
        );
        return {
            provider,
            close: async () => {
                await provider.close();
            },
        };
    }

    /** @param {http.Server} server */
    attachServer(server) {
        this.server = server;
        server.on('request', (req, res) => {
            void this.onHttpRequest(req, res);
        });
    }

    /**
     * OAuth 回调 HTTP 处理（独立 listen 与 Consensus 共享 Hub 共用）
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     */
    async onHttpRequest(req, res) {
        try {
            const url = req.url ?? '';
            const remote = req.socket?.remoteAddress ?? 'unknown';
            this.logger.info(
                `[Native OAuth] callback request ${req.method} ${url} remote=${remote} host=${req.headers.host ?? ''}`
            );
            const parsed = new URL(url, this.redirectUrlValue);
            const expectedPath = this.redirectUrlValue.pathname || '/callback';
            if (parsed.pathname !== expectedPath) {
                res.statusCode = 404;
                res.end('Not found');
                this.logger.info(`[Native OAuth] callback path mismatch: got ${parsed.pathname} expected ${expectedPath}`);
                return;
            }
            const code = parsed.searchParams.get('code');
            const error = parsed.searchParams.get('error');
            const receivedState = parsed.searchParams.get('state');
            const expectedState = await this.persistence.readState();
            if (expectedState && receivedState && receivedState !== expectedState) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'text/html');
                res.end('<html><body><h1>Authorization failed</h1><p>Invalid OAuth state</p></body></html>');
                this.logger.warn('[Native OAuth] Invalid OAuth state on callback');
                this.authorizationDeferred?.reject(new Error('Invalid OAuth state'));
                this.authorizationDeferred = null;
                return;
            }
            if (code) {
                this.logger.info(`Received OAuth authorization code for ${this.definition.name}`);
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/html');
                res.end('<html><body><h1>Authorization successful</h1><p>You can return to the CLI.</p></body></html>');
                this.authorizationDeferred?.resolve(code);
                this.authorizationDeferred = null;
            } else if (error) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'text/html');
                res.end(`<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`);
                this.logger.warn(`[Native OAuth] OAuth error param: ${error}`);
                this.authorizationDeferred?.reject(new Error(`OAuth error: ${error}`));
                this.authorizationDeferred = null;
            } else {
                res.statusCode = 400;
                res.end('Missing authorization code');
                this.logger.warn('[Native OAuth] callback missing code and error');
                this.authorizationDeferred?.reject(new Error('Missing authorization code'));
                this.authorizationDeferred = null;
            }
        } catch (error) {
            this.logger.error('OAuth callback handler error', error);
            this.authorizationDeferred?.reject(error);
            this.authorizationDeferred = null;
        }
    }

    get redirectUrl() {
        return this.redirectUrlValue;
    }

    get clientMetadata() {
        return this.metadata;
    }

    async state() {
        const existing = await this.persistence.readState();
        if (existing) {
            return existing;
        }
        const state = randomUUID();
        await this.persistence.saveState(state);
        return state;
    }

    async clientInformation() {
        return this.persistence.readClientInfo();
    }

    async saveClientInformation(clientInformation) {
        await this.persistence.saveClientInfo(clientInformation);
    }

    async tokens() {
        return this.persistence.readTokens();
    }

    async saveTokens(tokens) {
        await this.persistence.saveTokens(tokens);
        this.logger.info(`Saved OAuth tokens for ${this.definition.name} (${this.persistence.describe()})`);
    }

    /** @param {URL} authorizationUrl */
    async redirectToAuthorization(authorizationUrl) {
        this.logger.info(`Authorization required for ${this.definition.name}. Opening browser...`);
        this.ensureAuthorizationDeferred();
        const urlStr = authorizationUrl.toString();
        try {
            this.hooks.onAuthorizationUrl?.(urlStr);
        } catch (e) {
            this.logger.warn(`onAuthorizationUrl hook failed: ${e instanceof Error ? e.message : e}`);
        }
        if (!this.hooks.skipOpenBrowser) {
            openExternal(urlStr);
        } else {
            this.logger.info(`[Native OAuth] skipOpenBrowser=true; visit ${urlStr} in your browser to authorize.`);
        }
        this.logger.info(`If the browser did not open, visit ${urlStr} manually.`);
    }

    async saveCodeVerifier(codeVerifier) {
        await this.persistence.saveCodeVerifier(codeVerifier);
    }

    async codeVerifier() {
        const value = await this.persistence.readCodeVerifier();
        if (!value) {
            throw new Error(`Missing PKCE code verifier for ${this.definition.name}`);
        }
        return value.trim();
    }

    async invalidateCredentials(scope) {
        await this.persistence.clear(scope);
    }

    async waitForAuthorizationCode() {
        return this.ensureAuthorizationDeferred().promise;
    }

    async close() {
        if (this._hubUnregister) {
            try {
                this._hubUnregister();
            } catch {
                /* ignore */
            }
            this._hubUnregister = null;
        }
        if (this.authorizationDeferred) {
            this.authorizationDeferred.reject(new Error('OAuth session closed before receiving authorization code.'));
            this.authorizationDeferred = null;
        }
        if (!this.server) {
            this.logger.info(`[Native OAuth] OAuth callback handler cleared for ${this.definition.name} (shared hub keeps listening)`);
            return;
        }
        await new Promise((resolve) => {
            this.server?.close(() => resolve());
        });
        this.server = undefined;
        this.logger.info(`[Native OAuth] Callback server closed for ${this.definition.name}`);
    }

    ensureAuthorizationDeferred() {
        if (!this.authorizationDeferred) {
            this.authorizationDeferred = createDeferred();
        }
        return this.authorizationDeferred;
    }
}

/** @param {any} client */
function firstRedirectUri(client) {
    if (!client || typeof client !== 'object') {
        return undefined;
    }
    const redirectUris = client.redirect_uris;
    if (!Array.isArray(redirectUris)) {
        return undefined;
    }
    const [first] = redirectUris;
    return typeof first === 'string' ? first : undefined;
}

/**
 * @param {any} definition
 * @param {OAuthLogger} logger
 * @param {{ skipOpenBrowser?: boolean, onAuthorizationUrl?: (u: string) => void, useConsensusHub?: boolean }} [sessionHooks]
 */
export async function createOAuthSession(definition, logger, sessionHooks = {}) {
    const { provider, close } = await PersistentOAuthClientProvider.create(definition, logger, sessionHooks);
    const waitForAuthorizationCode = () => provider.waitForAuthorizationCode();
    return {
        provider,
        waitForAuthorizationCode,
        close,
    };
}
