import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { atomicWriteFile } from '../utils/file-lock.js';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { getProxyConfigForProvider } from '../utils/proxy-utils.js';
import {
    fetchOb1Organization,
    normalizeCredentialData,
    finalizeOb1ImportedCredentials,
    refreshOb1Tokens,
    OB1_DEFAULT_WORKOS_AUTH_URL,
    OB1_DEFAULT_WORKOS_CLIENT_ID,
} from '../providers/openblocklabs/ob1-core.js';

const OB1_PROVIDER = 'openblocklabs-oauth';
const OB1_DEVICE_AUTH_URL = 'https://api.workos.com/user_management/authorize/device';

const OB1_OAUTH_CONFIG = {
    deviceAuthUrl: OB1_DEVICE_AUTH_URL,
    workosAuthUrl: OB1_DEFAULT_WORKOS_AUTH_URL,
    clientId: OB1_DEFAULT_WORKOS_CLIENT_ID,
    credentialsDir: 'configs/ob1',
    logPrefix: '[OB1 Auth]',
};

const activePollingTasks = new Map();

async function axiosWithProxy(url, options = {}, providerType = OB1_PROVIDER) {
    const proxyConfig = getProxyConfigForProvider(CONFIG, providerType);
    const axiosConfig = {
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 30000,
        data: options.body,
    };

    if (proxyConfig) {
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        axiosConfig.proxy = false;
    }

    try {
        const response = await axios(axiosConfig);
        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            json: async () => response.data,
            text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        };
    } catch (error) {
        if (error.response) {
            return {
                ok: false,
                status: error.response.status,
                json: async () => error.response.data,
                text: async () => typeof error.response.data === 'string'
                    ? error.response.data
                    : JSON.stringify(error.response.data),
            };
        }
        throw error;
    }
}

function sanitizeCredentialFilenamePart(value) {
    const sanitized = String(value || 'default')
        .trim()
        .replace(/[^a-zA-Z0-9@._+-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120);
    return sanitized || 'default';
}

async function linkOb1CredentialToProviderPool(relativePath) {
    if (!relativePath) return;
    await autoLinkProviderConfigs(CONFIG, {
        onlyCurrentCred: true,
        credPath: relativePath,
    });
}

function resolveOb1CredentialsDir(options = {}) {
    if (options.providerDir) {
        const providerDir = String(options.providerDir).replace(/^[\\/]+/, '');
        if (providerDir.startsWith('configs')) {
            return path.join(process.cwd(), providerDir);
        }
        return path.join(process.cwd(), 'configs', providerDir);
    }
    return path.join(process.cwd(), OB1_OAUTH_CONFIG.credentialsDir);
}

function buildCredentialPath(email, options = {}) {
    const targetDir = resolveOb1CredentialsDir(options);
    const safeEmail = sanitizeCredentialFilenamePart(email || 'default');
    const timestamp = Date.now();
    return path.join(targetDir, `ob1-${safeEmail}-${timestamp}.json`);
}

async function saveOb1Credentials(credentials, options = {}) {
    const credPath = buildCredentialPath(credentials.email, options);
    await fs.promises.mkdir(path.dirname(credPath), { recursive: true });
    await atomicWriteFile(credPath, JSON.stringify(credentials, null, 2), { encoding: 'utf-8', mode: 0o600 });
    return credPath;
}

function stopPollingTask(taskId) {
    const task = activePollingTasks.get(taskId);
    if (task?.cancelled !== undefined) {
        task.cancelled = true;
    }
    activePollingTasks.delete(taskId);
}

async function pollOb1DeviceAuth(deviceCode, interval = 5, expiresIn = 600, taskId = 'default', options = {}) {
    const maxAttempts = Math.max(1, Math.floor(expiresIn / interval));
    let attempts = 0;

    const poll = async () => {
        if (activePollingTasks.get(taskId)?.cancelled) {
            throw new Error('OB1 device auth polling cancelled');
        }

        attempts += 1;
        if (attempts > maxAttempts) {
            activePollingTasks.delete(taskId);
            throw new Error('OB1 device auth expired, please restart authorization');
        }

        const params = new URLSearchParams();
        params.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
        params.append('device_code', deviceCode);
        params.append('client_id', options.clientId || OB1_OAUTH_CONFIG.clientId);

        const response = await axiosWithProxy(
            options.workosAuthUrl || OB1_OAUTH_CONFIG.workosAuthUrl,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
            },
            OB1_PROVIDER
        );

        const data = await response.json();

        if (response.ok && data.access_token) {
            const user = data.user || {};
            const expiresInSeconds = Number(data.expires_in) || 3600;
            const credentials = finalizeOb1ImportedCredentials(normalizeCredentialData({
                email: user.email || '',
                access_token: data.access_token,
                refresh_token: data.refresh_token || '',
                expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
                user_id: user.id || '',
                user_data: user,
            }));

            const org = await fetchOb1Organization(
                credentials.access_token,
                credentials.user_id,
                {
                    OB1_API_BASE: options.apiBase,
                    OB1_WORKOS_AUTH_URL: options.workosAuthUrl,
                    OB1_WORKOS_CLIENT_ID: options.clientId,
                }
            );
            credentials.org_id = org.org_id || credentials.org_id;
            credentials.org_name = org.org_name || credentials.org_name;

            const credPath = await saveOb1Credentials(credentials, options);
            const relativePath = path.relative(process.cwd(), credPath);
            activePollingTasks.delete(taskId);

            broadcastEvent('oauth_success', {
                provider: OB1_PROVIDER,
                credPath,
                relativePath,
                email: credentials.email,
                timestamp: new Date().toISOString(),
            });

            await linkOb1CredentialToProviderPool(relativePath);

            return credentials;
        }

        const errorCode = data.error || '';
        if (errorCode === 'authorization_pending' || errorCode === 'slow_down') {
            const waitSeconds = errorCode === 'slow_down' ? interval + 5 : interval;
            logger.info(`${OB1_OAUTH_CONFIG.logPrefix} Waiting for user authorization [${taskId}]... (${attempts}/${maxAttempts})`);
            await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
            return poll();
        }

        activePollingTasks.delete(taskId);
        if (errorCode === 'expired_token') {
            throw new Error('OB1 device code expired, please restart authorization');
        }
        if (errorCode === 'access_denied') {
            throw new Error('User denied OB1 authorization request');
        }
        throw new Error(`OB1 authorization failed: ${data.error_description || errorCode || `HTTP ${response.status}`}`);
    };

    return poll();
}

export async function handleOb1OAuth(currentConfig, options = {}) {
    const clientId = options.clientId || currentConfig?.OB1_WORKOS_CLIENT_ID || OB1_OAUTH_CONFIG.clientId;
    const params = new URLSearchParams();
    params.append('client_id', clientId);

    const response = await axiosWithProxy(
        options.deviceAuthUrl || OB1_OAUTH_CONFIG.deviceAuthUrl,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        },
        OB1_PROVIDER
    );

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`OB1 device auth request failed: ${response.status} ${body}`);
    }

    const deviceAuth = await response.json();
    if (!deviceAuth.device_code) {
        throw new Error('OB1 device auth response missing device_code');
    }

    const interval = Number(deviceAuth.interval) || 5;
    const expiresIn = Number(deviceAuth.expires_in) || 600;
    const taskId = `ob1-${deviceAuth.device_code.substring(0, 8)}-${Date.now()}`;

    for (const [existingTaskId] of activePollingTasks.entries()) {
        if (existingTaskId.startsWith('ob1-')) {
            stopPollingTask(existingTaskId);
        }
    }
    activePollingTasks.set(taskId, { cancelled: false });

    pollOb1DeviceAuth(deviceAuth.device_code, interval, expiresIn, taskId, {
        ...options,
        clientId,
        workosAuthUrl: options.workosAuthUrl || currentConfig?.OB1_WORKOS_AUTH_URL,
        apiBase: options.apiBase || currentConfig?.OB1_API_BASE,
        providerDir: options.providerDir,
    }).catch(error => {
        logger.error(`${OB1_OAUTH_CONFIG.logPrefix} Polling failed [${taskId}]:`, error);
        broadcastEvent('oauth_error', {
            provider: OB1_PROVIDER,
            error: error.message,
            timestamp: new Date().toISOString(),
        });
    });

    const authUrl = deviceAuth.verification_uri_complete
        || deviceAuth.verification_uri
        || deviceAuth.user_code;

    return {
        authUrl,
        authInfo: {
            provider: OB1_PROVIDER,
            deviceCode: deviceAuth.device_code,
            userCode: deviceAuth.user_code,
            verificationUri: deviceAuth.verification_uri,
            verificationUriComplete: deviceAuth.verification_uri_complete,
            expiresIn,
            interval,
        },
    };
}

/**
 * 将 ob12api 风格的导入数据规范化为批量导入项列表。
 * 支持：
 * - accounts.json：账号对象数组
 * - { "accounts": [...] }：管理面板/API 导入格式
 * - { "refresh_tokens": [...] }：push 接口格式
 * - CSV/TSV：email,password,access_token,refresh_token（refresh_token 可为空）
 * - refresh_token 字符串数组 / 每行一个 token 的纯文本
 * - 单个账号对象：{ email, password?, access_token, refresh_token? }
 */
function parseOb1DelimitedRows(text) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length < 2) return null;

    const delimiter = lines[0].includes('\t')
        ? '\t'
        : (lines[0].includes(',') ? ',' : null);
    if (!delimiter) return null;

    const headers = lines[0].split(delimiter).map(header => header.trim().toLowerCase());
    const emailIdx = headers.findIndex(header => header === 'email' || header === '邮箱');
    const passwordIdx = headers.findIndex(header => header === 'password' || header === '密码');
    const tokenIdx = headers.findIndex(header =>
        ['access_token', 'access token', 'token', 'accesstoken', 'access-token'].includes(header)
    );
    const refreshTokenIdx = headers.findIndex(header =>
        ['refresh_token', 'refresh token', 'refreshtoken', 'refresh-token', 'rt'].includes(header)
    );

    if (emailIdx < 0 && tokenIdx < 0 && refreshTokenIdx < 0) return null;

    return lines.slice(1).map(line => {
        const cols = line.split(delimiter);
        return {
            email: emailIdx >= 0 ? (cols[emailIdx] || '').trim() : '',
            password: passwordIdx >= 0 ? (cols[passwordIdx] || '').trim() : '',
            access_token: tokenIdx >= 0 ? (cols[tokenIdx] || '').trim() : '',
            refresh_token: refreshTokenIdx >= 0 ? (cols[refreshTokenIdx] || '').trim() : '',
        };
    }).filter(row => row.email || row.access_token || row.refresh_token);
}

function looksLikeOb1AccessToken(value) {
    const token = String(value || '').trim();
    if (!token) return false;
    if (token.startsWith('Fe26.')) return true;
    if (token.length > 80 && !token.startsWith('rt_')) return true;
    return false;
}

export function normalizeOb1BatchImportItems(input) {
    let data = input;

    if (typeof data === 'string') {
        const trimmed = data.trim();
        if (!trimmed) return [];

        const csvRows = parseOb1DelimitedRows(trimmed);
        if (csvRows?.length) {
            return csvRows;
        }

        try {
            data = JSON.parse(trimmed);
        } catch {
            return trimmed
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean);
        }
    }

    if (Array.isArray(data)) {
        return data;
    }

    if (data && typeof data === 'object') {
        if (Array.isArray(data.accounts)) {
            return data.accounts;
        }
        if (Array.isArray(data.refresh_tokens)) {
            return data.refresh_tokens;
        }
        if (Array.isArray(data.tokens)) {
            return data.tokens;
        }
        return [data];
    }

    return [];
}

export async function batchImportOb1TokensStream(tokens, onProgress, skipDuplicateCheck = false) {
    const importItems = normalizeOb1BatchImportItems(tokens);
    const result = {
        total: importItems.length,
        success: 0,
        failed: 0,
        details: [],
    };

    if (!importItems.length) {
        return result;
    }

    const existingRefreshTokens = new Set();
    const existingEmails = new Set();
    if (!skipDuplicateCheck) {
        const targetDir = path.join(process.cwd(), OB1_OAUTH_CONFIG.credentialsDir);
        if (fs.existsSync(targetDir)) {
            const files = fs.readdirSync(targetDir).filter(file => file.endsWith('.json'));
            for (const file of files) {
                try {
                    const content = JSON.parse(fs.readFileSync(path.join(targetDir, file), 'utf8'));
                    const normalized = normalizeCredentialData(content);
                    if (normalized.refresh_token) {
                        existingRefreshTokens.add(normalized.refresh_token);
                    }
                    if (normalized.email) {
                        existingEmails.add(normalized.email.toLowerCase());
                    }
                } catch {
                    // ignore invalid files
                }
            }
        }
    }

    for (let index = 0; index < importItems.length; index += 1) {
        const item = importItems[index];
        const progress = {
            index: index + 1,
            total: importItems.length,
            current: null,
            successCount: result.success,
            failedCount: result.failed,
        };

        try {
            let credentials;
            if (typeof item === 'string') {
                const token = item.trim();
                if (!token) {
                    throw new Error('token is empty');
                }

                if (looksLikeOb1AccessToken(token)) {
                    credentials = finalizeOb1ImportedCredentials(normalizeCredentialData({
                        access_token: token,
                    }));
                } else {
                    if (!skipDuplicateCheck && existingRefreshTokens.has(token)) {
                        throw new Error('duplicate refresh_token');
                    }
                    const refreshed = await refreshOb1Tokens(token, CONFIG);
                    credentials = finalizeOb1ImportedCredentials(normalizeCredentialData({
                        refresh_token: refreshed.refresh_token,
                        access_token: refreshed.access_token,
                        expires_at: refreshed.expires_at,
                    }));
                }
            } else {
                credentials = finalizeOb1ImportedCredentials(normalizeCredentialData(item));
                if (!credentials.access_token && credentials.refresh_token) {
                    const refreshed = await refreshOb1Tokens(credentials.refresh_token, CONFIG);
                    credentials.access_token = refreshed.access_token;
                    credentials.refresh_token = refreshed.refresh_token;
                    credentials.expires_at = refreshed.expires_at;
                    credentials.access_token_only = false;
                }
            }

            if (!credentials.refresh_token && !credentials.access_token) {
                throw new Error('access_token or refresh_token is required');
            }

            if (!skipDuplicateCheck && credentials.email &&
                existingEmails.has(credentials.email.toLowerCase())) {
                throw new Error(`duplicate email: ${credentials.email}`);
            }

            if (!skipDuplicateCheck && credentials.refresh_token &&
                existingRefreshTokens.has(credentials.refresh_token)) {
                throw new Error('duplicate refresh_token');
            }

            if (credentials.access_token && credentials.user_id) {
                const org = await fetchOb1Organization(credentials.access_token, credentials.user_id, CONFIG);
                credentials.org_id = org.org_id || credentials.org_id;
                credentials.org_name = org.org_name || credentials.org_name;
            }

            const credPath = await saveOb1Credentials(credentials);
            const relativePath = path.relative(process.cwd(), credPath);
            await linkOb1CredentialToProviderPool(relativePath);
            if (credentials.refresh_token) {
                existingRefreshTokens.add(credentials.refresh_token);
            }
            if (credentials.email) {
                existingEmails.add(credentials.email.toLowerCase());
            }

            progress.current = {
                index: index + 1,
                success: true,
                path: relativePath,
                email: credentials.email || '',
            };
            result.success += 1;
        } catch (error) {
            progress.current = {
                index: index + 1,
                success: false,
                error: error.message,
            };
            result.failed += 1;
        }

        result.details.push(progress.current);
        if (typeof onProgress === 'function') {
            onProgress(progress);
        }
    }

    if (result.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: OB1_PROVIDER,
            count: result.success,
            timestamp: new Date().toISOString(),
        });
    }

    return result;
}

export async function importOb1CredentialsFromHome() {
    const homeCredPath = path.join(os.homedir(), '.ob1', 'credentials.json');
    if (!fs.existsSync(homeCredPath)) {
        throw new Error(`OB1 credentials not found at ${homeCredPath}`);
    }

    const raw = JSON.parse(fs.readFileSync(homeCredPath, 'utf8'));
    const credentials = normalizeCredentialData(raw);
    if (!credentials.access_token && !credentials.refresh_token) {
        throw new Error('Invalid OB1 credentials file');
    }

    if (!credentials.access_token && credentials.refresh_token) {
        const refreshed = await refreshOb1Tokens(credentials.refresh_token, CONFIG);
        credentials.access_token = refreshed.access_token;
        credentials.refresh_token = refreshed.refresh_token;
        credentials.expires_at = refreshed.expires_at;
    }

    if (credentials.access_token && credentials.user_id) {
        const org = await fetchOb1Organization(credentials.access_token, credentials.user_id, CONFIG);
        credentials.org_id = org.org_id || credentials.org_id;
        credentials.org_name = org.org_name || credentials.org_name;
    }

    const credPath = await saveOb1Credentials(credentials);
    const relativePath = path.relative(process.cwd(), credPath);
    await linkOb1CredentialToProviderPool(relativePath);
    return {
        success: true,
        path: relativePath,
        email: credentials.email || '',
    };
}
