import axios from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import logger from '../../utils/logger.js';
import { atomicWriteFile } from '../../utils/file-lock.js';
import { configureTLSSidecar } from '../../utils/proxy-utils.js';
import {
    MODEL_PROVIDER,
    getRetryAfterMs,
    isRetryableNetworkError,
} from '../../utils/common.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { getProviderModels } from '../provider-models.js';

const OB1_DEFAULT_API_BASE = 'https://dashboard.openblocklabs.com/api/v1';
const OB1_DEFAULT_WORKOS_AUTH_URL = 'https://api.workos.com/user_management/authenticate';
const OB1_DEFAULT_WORKOS_CLIENT_ID = 'client_01K8YDZSSKDMK8GYTEHBAW4N4S';
const OB1_ORG_API_PATH = '/auth/organizations';
const OB1_DEFAULT_MODEL = 'anthropic/claude-opus-4.6';
const OB1_REFRESH_BUFFER_MS = 600 * 1000;
const OB1_API_HEADERS = {
    'HTTP-Referer': 'https://github.com/delta-hq/ob1',
    'X-Title': 'OB1 CLI',
};

function parseExpirySeconds(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
        return value < 1_000_000_000_000 ? value : Math.floor(value / 1000);
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        return numeric < 1_000_000_000_000 ? numeric : Math.floor(numeric / 1000);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
        return Math.floor(parsed / 1000);
    }
    return null;
}

function sanitizeCredentialFilenamePart(value) {
    const sanitized = String(value || 'default')
        .trim()
        .replace(/[^a-zA-Z0-9@._+-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120);
    return sanitized || 'default';
}

function normalizeOb1BaseUrl(baseUrl) {
    const value = String(baseUrl || OB1_DEFAULT_API_BASE).trim().replace(/\/+$/, '');
    return value || OB1_DEFAULT_API_BASE;
}

function normalizeCredentialData(raw = {}) {
    const oauth = raw.oauth && typeof raw.oauth === 'object' ? raw.oauth : null;
    const user = oauth?.user || raw.user_data || raw.user || {};
    const expiresAt = parseExpirySeconds(
        raw.expires_at ?? raw.expiresAt ?? oauth?.expires_at ?? oauth?.expiresAt
    );

    return {
        email: raw.email || user.email || '',
        access_token: raw.access_token || oauth?.access_token || '',
        refresh_token: raw.refresh_token || oauth?.refresh_token || '',
        expires_at: expiresAt || 0,
        org_id: raw.org_id || oauth?.organization_id || '',
        org_name: raw.org_name || '',
        user_id: raw.user_id || user.id || '',
        user_data: raw.user_data || user || {},
    };
}

async function refreshOb1Tokens(refreshToken, config = {}) {
    const workosAuthUrl = config.OB1_WORKOS_AUTH_URL || OB1_DEFAULT_WORKOS_AUTH_URL;
    const clientId = config.OB1_WORKOS_CLIENT_ID || OB1_DEFAULT_WORKOS_CLIENT_ID;

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);
    params.append('client_id', clientId);

    const axiosConfig = {
        method: 'POST',
        url: workosAuthUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: params.toString(),
        timeout: 30000,
    };

    const response = await axios.request(axiosConfig);
    const result = response.data || {};
    if (!result.access_token) {
        throw new Error('[OB1] Missing access_token in refresh response');
    }

    const expiresIn = Number(result.expires_in) || 3600;
    return {
        access_token: result.access_token,
        refresh_token: result.refresh_token || refreshToken,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    };
}

async function fetchOb1Organization(accessToken, userId, config = {}) {
    if (!userId) return { org_id: '', org_name: '' };

    const baseUrl = normalizeOb1BaseUrl(config.OB1_API_BASE);
    const axiosConfig = {
        method: 'GET',
        url: `${baseUrl}${OB1_ORG_API_PATH}`,
        params: { user_id: userId },
        headers: {
            ...OB1_API_HEADERS,
            Authorization: `Bearer ${accessToken}`,
        },
        timeout: 15000,
    };

    try {
        const response = await axios.request(axiosConfig);
        const orgs = response.data?.data || [];
        if (!orgs.length) return { org_id: '', org_name: '' };
        return {
            org_id: orgs[0].organizationId || '',
            org_name: orgs[0].organizationName || '',
        };
    } catch (error) {
        logger.warn(`[OB1] Failed to fetch organization: ${error.message}`);
        return { org_id: '', org_name: '' };
    }
}

function buildApiKey(credentials) {
    if (!credentials?.access_token) return null;
    if (credentials.org_id) {
        return `${credentials.access_token}:${credentials.org_id}`;
    }
    return credentials.access_token;
}

async function resolveOb1ModelName(requestedModel, availableModels = []) {
    const available = availableModels
        .map(item => (typeof item === 'string' ? item : item?.id))
        .filter(Boolean);

    if (available.includes(requestedModel)) {
        return requestedModel;
    }

    const anthropicPrefixed = `anthropic/${requestedModel}`;
    if (available.includes(anthropicPrefixed)) {
        return anthropicPrefixed;
    }

    if (requestedModel.startsWith('claude-')) {
        const lowered = requestedModel.toLowerCase();
        let family = null;
        for (const candidate of ['haiku', 'sonnet', 'opus']) {
            if (lowered.includes(candidate)) {
                family = candidate;
                break;
            }
        }

        if (family) {
            const familyMatches = available.filter(modelId =>
                modelId.startsWith(`anthropic/claude-${family}`)
            );
            if (familyMatches.length) {
                return familyMatches.sort().at(-1);
            }
        }

        const anthropicModels = available.filter(modelId => modelId.startsWith('anthropic/'));
        const preferredOrder = ['anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.6'];
        for (const modelId of preferredOrder) {
            if (anthropicModels.includes(modelId)) {
                return modelId;
            }
        }
        if (anthropicModels.length) {
            return anthropicModels.sort().at(-1);
        }
    }

    return requestedModel;
}

export class Ob1ApiService {
    constructor(config) {
        this.config = config;
        this.baseUrl = normalizeOb1BaseUrl(config.OB1_API_BASE);
        this.workosAuthUrl = config.OB1_WORKOS_AUTH_URL || OB1_DEFAULT_WORKOS_AUTH_URL;
        this.workosClientId = config.OB1_WORKOS_CLIENT_ID || OB1_DEFAULT_WORKOS_CLIENT_ID;
        this.credentials = null;
        this.credsPath = null;
        this.uuid = config.uuid;
        this.isInitialized = false;
        this._modelsCache = null;
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(
            axiosConfig,
            this.config,
            this.config.MODEL_PROVIDER || MODEL_PROVIDER.OPENBLOCKLABS,
            this.baseUrl
        );
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info('[OB1] Initializing OpenBlockLabs API Service...');
        await this.loadCredentials();
        this.isInitialized = true;
        logger.info(`[OB1] Initialization complete. Account: ${this.credentials?.email || 'unknown'}`);
    }

    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async loadCredentials() {
        const email = this.config.OB1_EMAIL || 'default';

        try {
            let credsPath = this.config.OB1_OAUTH_CREDS_FILE_PATH;
            let rawCreds;

            if (credsPath) {
                const exists = await this.fileExists(credsPath);
                if (!exists) {
                    throw new Error('OB1 credentials not found. Please authenticate first using OAuth.');
                }
                rawCreds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            } else {
                const targetDir = path.join(process.cwd(), 'configs', 'ob1');
                const files = await fs.readdir(targetDir).catch(() => []);
                const safeEmail = sanitizeCredentialFilenamePart(email);
                const matchingFile = files
                    .filter(file => file.endsWith('.json') && (file.includes(`ob1-${safeEmail}`) || file.includes('ob1-')))
                    .sort()
                    .pop();

                if (!matchingFile) {
                    const homeCredPath = path.join(os.homedir(), '.ob1', 'credentials.json');
                    if (await this.fileExists(homeCredPath)) {
                        credsPath = homeCredPath;
                        rawCreds = JSON.parse(await fs.readFile(homeCredPath, 'utf8'));
                    } else {
                        throw new Error('OB1 credentials not found. Please authenticate first using OAuth.');
                    }
                } else {
                    credsPath = path.join(targetDir, matchingFile);
                    rawCreds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
                }
            }

            this.credsPath = credsPath;
            this.credentials = normalizeCredentialData(rawCreds);
            this.baseUrl = normalizeOb1BaseUrl(this.config.OB1_API_BASE || rawCreds.base_url || this.baseUrl);

            if (this.isExpiryDateNear()) {
                this.triggerBackgroundRefresh();
            }
        } catch (error) {
            logger.warn(`[OB1] Failed to load credentials: ${error.message}`);
            throw error;
        }
    }

    triggerBackgroundRefresh() {
        const poolManager = getProviderPoolManager();
        if (!poolManager) return;
        poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.OPENBLOCKLABS, {
            uuid: this.uuid,
            reason: 'token_near_expiry',
        });
    }

    isExpiryDateNear() {
        const expiresAt = this.credentials?.expires_at;
        if (!expiresAt) return true;
        const nowSeconds = Math.floor(Date.now() / 1000);
        return expiresAt - nowSeconds < OB1_REFRESH_BUFFER_MS / 1000;
    }

    async initializeAuth(force = false) {
        if (!this.credentials?.refresh_token) {
            throw new Error('[OB1] refresh_token is missing');
        }
        if (!force && !this.isExpiryDateNear()) {
            return false;
        }

        logger.info(`[OB1] Refreshing token... expires_at=${this.credentials.expires_at}`);
        const refreshed = await refreshOb1Tokens(this.credentials.refresh_token, this.config);
        this.credentials.access_token = refreshed.access_token;
        this.credentials.refresh_token = refreshed.refresh_token;
        this.credentials.expires_at = refreshed.expires_at;

        if (this.credsPath) {
            await atomicWriteFile(
                this.credsPath,
                JSON.stringify(this.credentials, null, 2),
                { encoding: 'utf-8', mode: 0o600 }
            );
        }
        return true;
    }

    async refreshToken() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        if (!this.isExpiryDateNear()) return false;
        return this.initializeAuth(false);
    }

    async forceRefreshToken() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        return this.initializeAuth(true);
    }

    getApiKey() {
        return buildApiKey(this.credentials);
    }

    async _ensureValidApiKey() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        if (this.isExpiryDateNear()) {
            await this.initializeAuth(false);
        }
        const apiKey = this.getApiKey();
        if (!apiKey) {
            throw new Error('[OB1] No valid API key available. Please authenticate first.');
        }
        return apiKey;
    }

    async fetchModels(force = false) {
        if (!force && this._modelsCache) {
            return this._modelsCache;
        }

        const apiKey = await this._ensureValidApiKey();
        const axiosConfig = {
            method: 'GET',
            url: `${this.baseUrl}/models`,
            headers: {
                ...OB1_API_HEADERS,
                Authorization: `Bearer ${apiKey}`,
            },
            timeout: 15000,
        };
        this._applySidecar(axiosConfig);

        try {
            const response = await axios.request(axiosConfig);
            const models = response.data?.data || [];
            this._modelsCache = models;
            return models;
        } catch (error) {
            logger.error(`[OB1] Models fetch failed: ${error.message}`);
            return [];
        }
    }

    async listModels() {
        const models = await this.fetchModels();
        const fallbackModels = getProviderModels(MODEL_PROVIDER.OPENBLOCKLABS);
        const modelIds = models.length
            ? models.map(item => item.id).filter(Boolean)
            : fallbackModels;

        return {
            object: 'list',
            data: modelIds.map(id => ({
                id,
                object: 'model',
                created: 0,
                owned_by: id.includes('/') ? id.split('/')[0] : 'ob1',
            })),
        };
    }

    async _resolveModel(model) {
        const models = await this.fetchModels();
        return resolveOb1ModelName(model, models);
    }

    async _chatRequest(model, requestBody, stream = false) {
        const apiKey = await this._ensureValidApiKey();
        const resolvedModel = await this._resolveModel(model);
        const payload = {
            ...requestBody,
            model: resolvedModel,
            stream,
        };

        if (stream) {
            payload.stream_options = { include_usage: true };
        }

        delete payload._monitorRequestId;
        delete payload._requestBaseUrl;

        const axiosConfig = {
            method: 'POST',
            url: `${this.baseUrl}/chat/completions`,
            headers: {
                ...OB1_API_HEADERS,
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            data: payload,
            timeout: 300000,
            responseType: stream ? 'stream' : 'json',
            validateStatus: () => true,
        };
        this._applySidecar(axiosConfig);

        let response = await axios.request(axiosConfig);

        if (response.status === 401) {
            logger.warn('[OB1] Token rejected (401), refreshing...');
            await this.initializeAuth(true);
            const refreshedApiKey = await this._ensureValidApiKey();
            axiosConfig.headers.Authorization = `Bearer ${refreshedApiKey}`;
            response = await axios.request(axiosConfig);
        }

        if (response.status !== 200) {
            const errorBody = stream
                ? await new Promise((resolve) => {
                    let body = '';
                    response.data.on('data', chunk => { body += chunk.toString(); });
                    response.data.on('end', () => resolve(body));
                })
                : JSON.stringify(response.data || {});
            const error = new Error(`[OB1] Backend returned ${response.status}: ${String(errorBody).slice(0, 500)}`);
            error.status = response.status;
            error.response = { status: response.status, data: response.data };
            throw error;
        }

        return response;
    }

    async generateContent(model, requestBody) {
        const response = await this._chatRequest(model, requestBody, false);
        return response.data;
    }

    async *generateContentStream(model, requestBody) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;
        let retryCount = 0;

        while (true) {
            try {
                const response = await this._chatRequest(model, requestBody, true);
                const stream = response.data;
                let buffer = '';

                for await (const chunk of stream) {
                    buffer += chunk.toString();
                    let newlineIndex;
                    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.substring(0, newlineIndex).trim();
                        buffer = buffer.substring(newlineIndex + 1);
                        if (!line.startsWith('data: ')) continue;

                        const jsonData = line.substring(6).trim();
                        if (jsonData === '[DONE]') return;
                        try {
                            yield JSON.parse(jsonData);
                        } catch (error) {
                            logger.warn(`[OB1] Failed to parse stream chunk: ${error.message}`);
                        }
                    }
                }
                return;
            } catch (error) {
                const status = error.response?.status;
                const isNetworkError = isRetryableNetworkError(error);

                if (status === 429) {
                    const retryAfter = getRetryAfterMs(error);
                    if (retryAfter !== null) throw error;
                }

                if (((status >= 500 && status < 600) || isNetworkError) && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    retryCount += 1;
                    logger.info(`[OB1] Stream error ${status || error.code}. Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw error;
            }
        }
    }

    async getUsageLimits() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        const expiresAt = this.credentials?.expires_at;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const remainingSeconds = expiresAt ? Math.max(0, expiresAt - nowSeconds) : null;

        return {
            provider: MODEL_PROVIDER.OPENBLOCKLABS,
            email: this.credentials?.email || '',
            org_id: this.credentials?.org_id || '',
            org_name: this.credentials?.org_name || '',
            expires_at: expiresAt ? expiresAt * 1000 : null,
            remaining_seconds: remainingSeconds,
            active: Boolean(this.credentials?.access_token) && (!expiresAt || expiresAt > nowSeconds),
        };
    }
}

export {
    refreshOb1Tokens,
    fetchOb1Organization,
    normalizeCredentialData,
    resolveOb1ModelName,
    OB1_DEFAULT_API_BASE,
    OB1_DEFAULT_WORKOS_AUTH_URL,
    OB1_DEFAULT_WORKOS_CLIENT_ID,
};
