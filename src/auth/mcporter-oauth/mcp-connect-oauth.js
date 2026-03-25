/**
 * 与 mcporter `src/runtime/oauth.ts` + `runtime-oauth-support.ts` + `error-classifier.ts` 对齐。
 */
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

export const DEFAULT_OAUTH_CODE_TIMEOUT_MS = 60_000;

export class OAuthTimeoutError extends Error {
    /**
     * @param {string} serverName
     * @param {number} timeoutMs
     */
    constructor(serverName, timeoutMs) {
        const seconds = Math.round(timeoutMs / 1000);
        super(`OAuth authorization for '${serverName}' timed out after ${seconds}s; aborting.`);
        this.name = 'OAuthTimeoutError';
        this.timeoutMs = timeoutMs;
        this.serverName = serverName;
    }
}

/** @param {unknown} error */
function extractMessage(error) {
    if (error instanceof Error) {
        return error.message ?? '';
    }
    if (typeof error === 'string') {
        return error;
    }
    if (error === undefined || error === null) {
        return '';
    }
    try {
        return JSON.stringify(error);
    } catch {
        return '';
    }
}

const AUTH_STATUSES = new Set([401, 403]);
const STATUS_DIRECT_PATTERN = /\b(?:status(?:\s+code)?|http(?:\s+(?:status|code|error))?)[:\s]*(\d{3})\b/i;
const HTTP_STATUS_FALLBACK = /\bhttps?:\/\/[^\s]+(?:\s+returned\s+)?(?:status|code)?\s*(\d{3})\b/i;

/** @param {string} message */
function extractStatusCode(message) {
    const candidates = [
        message.match(/status code\s*\((\d{3})\)/i)?.[1],
        message.match(STATUS_DIRECT_PATTERN)?.[1],
        message.match(HTTP_STATUS_FALLBACK)?.[1],
    ].filter(Boolean);
    for (const candidate of candidates) {
        const parsed = Number.parseInt(/** @type {string} */ (candidate), 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}

/** @param {string} normalizedMessage */
function containsAuthToken(normalizedMessage) {
    return (
        normalizedMessage.includes('401') ||
        normalizedMessage.includes('unauthorized') ||
        normalizedMessage.includes('invalid_token') ||
        normalizedMessage.includes('forbidden')
    );
}

/** @param {unknown} error */
function analyzeConnectionError(error) {
    const rawMessage = extractMessage(error);
    if (error instanceof UnauthorizedError) {
        return { kind: 'auth', rawMessage };
    }
    const statusCode = extractStatusCode(rawMessage);
    const normalized = rawMessage.toLowerCase();
    if (AUTH_STATUSES.has(statusCode ?? -1) || containsAuthToken(normalized)) {
        return { kind: 'auth', rawMessage, statusCode };
    }
    return { kind: 'other', rawMessage };
}

/** @param {unknown} error */
export function isUnauthorizedError(error) {
    return analyzeConnectionError(error).kind === 'auth';
}

/**
 * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} client
 * @param {import('@modelcontextprotocol/sdk/shared/transport.js').Transport & { close(): Promise<void>, finishAuth?: (c: string) => Promise<void> }} transport
 * @param {{ waitForAuthorizationCode: () => Promise<string>, close?: () => Promise<void>, provider?: unknown } | undefined} session
 * @param {{ info?: Function, warn?: Function, error?: Function }} logger
 * @param {{
 *   serverName?: string,
 *   maxAttempts?: number,
 *   oauthTimeoutMs?: number,
 *   recreateTransport?: () => import('@modelcontextprotocol/sdk/shared/transport.js').Transport & { close(): Promise<void>, finishAuth?: (c: string) => Promise<void> },
 * }} [options] finishAuth 后需 recreateTransport：SDK 的 StreamableHTTP close 后仍无法再次 start（与官方 simpleOAuthClient 一致）。
 * @returns {Promise<typeof transport>} 成功连接后使用的 transport（若发生过 OAuth，可能是 `recreateTransport()` 的新实例）
 */
export async function connectWithAuth(client, transport, session, logger, options = {}) {
    const {
        serverName,
        maxAttempts = 3,
        oauthTimeoutMs = DEFAULT_OAUTH_CODE_TIMEOUT_MS,
        recreateTransport,
    } = options;
    let attempt = 0;
    /** @type {typeof transport} */
    let t = transport;
    while (true) {
        try {
            await client.connect(t);
            return t;
        } catch (error) {
            if (!isUnauthorizedError(error) || !session) {
                throw error;
            }
            attempt += 1;
            if (attempt > maxAttempts) {
                throw error;
            }
            logger.warn?.(
                `OAuth authorization required for '${serverName ?? 'unknown'}'. Waiting for browser approval...`
            );
            try {
                const code = await waitForAuthorizationCodeWithTimeout(session, logger, serverName, oauthTimeoutMs);
                if (typeof t.finishAuth === 'function') {
                    await t.finishAuth(code);
                    logger.info?.('Authorization code accepted. Retrying connection...');
                    if (typeof recreateTransport === 'function') {
                        await t.close().catch(() => {});
                        await client.close().catch(() => {});
                        t = /** @type {typeof t} */ (recreateTransport());
                    } else {
                        logger.warn?.(
                            'OAuth: finishAuth 后未提供 recreateTransport；同一 StreamableHTTP 实例无法再次 connect（SDK 限制）。'
                        );
                        throw error;
                    }
                } else {
                    logger.warn?.('Transport does not support finishAuth; cannot complete OAuth flow automatically.');
                    throw error;
                }
            } catch (authError) {
                logger.error?.('OAuth authorization failed while waiting for callback.', authError);
                throw authError;
            }
        }
    }
}

/**
 * @param {import('./oauth-session.js').OAuthSession} session
 * @param {{ info?: Function, warn?: Function }} logger
 */
export function waitForAuthorizationCodeWithTimeout(session, logger, serverName, timeoutMs = DEFAULT_OAUTH_CODE_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return session.waitForAuthorizationCode();
    }
    const displayName = serverName ?? 'unknown';
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const error = new OAuthTimeoutError(displayName, timeoutMs);
            logger.warn?.(error.message);
            reject(error);
        }, timeoutMs);
        session.waitForAuthorizationCode().then(
            (code) => {
                clearTimeout(timer);
                resolve(code);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}
