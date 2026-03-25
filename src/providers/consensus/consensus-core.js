import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promises as fsp } from 'fs';
import logger from '../../utils/logger.js';
import { MODEL_PROVIDER, formatExpiryLog } from '../../utils/common.js';
import { getMcporterExecutable, resolveConsensusTokenCacheDir } from './consensus-mcp-utils.js';
import { buildOAuthPersistence } from '../../auth/mcporter-oauth/oauth-persistence.js';
import {
    computeMcpAccessTokenExpiryMs,
    refreshMcpOAuthAccessToken,
} from '../../auth/mcporter-oauth/mcporter-oauth-refresh.js';

const DEFAULT_MCP_URL = 'https://mcp.consensus.app/mcp';
const DEFAULT_SERVER_NAME = 'consensus';

/**
 * 将参数对象转为 mcporter CLI 的 key=value / key:number 片段
 */
function toMcporterArgTokens(args) {
    const out = [];
    if (!args || typeof args !== 'object') return out;
    for (const [k, v] of Object.entries(args)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'boolean') {
            out.push(`${k}=${v}`);
        } else if (typeof v === 'number') {
            out.push(`${k}:${v}`);
        } else {
            const s = String(v);
            out.push(`${k}=${s}`);
        }
    }
    return out;
}

/**
 * 运行 mcporter call，返回解析后的 JSON（若输出非 JSON 则返回原始字符串包装）
 */
export async function runMcporterCall(config) {
    const bin = getMcporterExecutable();
    const configPath = config.CONSENSUS_MCPORTER_CONFIG_PATH;
    if (!configPath) {
        throw new Error('CONSENSUS_MCPORTER_CONFIG_PATH is required');
    }
    const absConfig = path.isAbsolute(configPath)
        ? configPath
        : path.resolve(process.cwd(), configPath);

    const { selector, args = {} } = config._mcpCall || {};
    if (!selector || typeof selector !== 'string') {
        throw new Error('MCP selector is required (e.g. consensus.search)');
    }

    const tokens = toMcporterArgTokens(args);
    const fullArgs = [
        '--config', absConfig,
        '--log-level', 'error',
        'call', selector,
        ...tokens,
        '--output', 'json',
    ];

    const t0 = Date.now();
    logger.info(
        `[Consensus] mcporter call start bin=${bin} selector=${selector} config=${absConfig} argTokenCount=${tokens.length}`
    );

    return new Promise((resolve, reject) => {
        const proc = spawn(bin, fullArgs, {
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        logger.info(`[Consensus] mcporter call spawned pid=${proc.pid ?? 'n/a'}`);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => {
            logger.info(`[Consensus] mcporter call spawn error: ${err.message}`);
            reject(err);
        });
        proc.on('close', (code) => {
            const ms = Date.now() - t0;
            const trimmedOut = stdout.trim();
            if (code !== 0) {
                logger.info(
                    `[Consensus] mcporter call failed code=${code} durationMs=${ms} stderrLen=${stderr.length} stdoutLen=${stdout.length} stderrPreview=${JSON.stringify(stderr.slice(0, 800))}`
                );
                reject(new Error(stderr || trimmedOut || `mcporter exited with code ${code}`));
                return;
            }
            logger.info(
                `[Consensus] mcporter call ok selector=${selector} durationMs=${ms} stdoutLen=${trimmedOut.length}`
            );
            try {
                if (!trimmedOut) {
                    resolve({ ok: true, raw: '' });
                    return;
                }
                resolve(JSON.parse(trimmedOut));
            } catch {
                resolve({ ok: true, raw: trimmedOut });
            }
        });
    });
}

export class ConsensusApiService {
    constructor(config) {
        this.config = config;
        this.isInitialized = false;
        if (!config.CONSENSUS_MCPORTER_CONFIG_PATH) {
            throw new Error('CONSENSUS_MCPORTER_CONFIG_PATH is required for Consensus (mcporter) provider.');
        }
        this.mcpUrl = config.CONSENSUS_MCP_URL || DEFAULT_MCP_URL;
        this.serverName = config.CONSENSUS_MCP_SERVER_NAME || DEFAULT_SERVER_NAME;
        this.uuid = config.uuid;
        /** @type {Record<string, unknown> | null} */
        this._oauthTokens = null;
        /** @type {string | null} */
        this._oauthTokensJsonPath = null;
    }

    /**
     * 与 mcporter / 原生 OAuth 相同的 ServerDefinition，供 persistence 与 refresh 使用。
     */
    getServerDefinition() {
        const rel = this.config.CONSENSUS_MCPORTER_CONFIG_PATH;
        const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
        const tokenCacheDirAbs = resolveConsensusTokenCacheDir(abs, this.config);
        const redirect = String(
            this.config.CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL || process.env.CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL || ''
        ).trim();
        return {
            name: this.serverName,
            command: { kind: 'http', url: new URL(this.mcpUrl), headers: {} },
            auth: 'oauth',
            ...(redirect ? { oauthRedirectUrl: redirect } : {}),
            ...(tokenCacheDirAbs ? { tokenCacheDir: tokenCacheDirAbs } : {}),
        };
    }

    /** 从 vault/tokenCache 重读 token 快照（同步 isExpiryDateNear 用的内存视图） */
    async reloadOAuthSnapshot() {
        const def = this.getServerDefinition();
        const persistence = await buildOAuthPersistence(def, logger);
        this._oauthTokens = (await persistence.readTokens()) ?? null;
        this._oauthTokensJsonPath = def.tokenCacheDir ? path.join(def.tokenCacheDir, 'tokens.json') : null;
    }

    async initialize() {
        if (this.isInitialized) {
            return;
        }
        await this.ensureMcporterJson();
        await this.reloadOAuthSnapshot().catch((e) => {
            logger.warn(`[Consensus] OAuth snapshot load skipped: ${e.message}`);
        });
        this.isInitialized = true;
    }

    /**
     * 确保 mcporter.json 中存在 MCP 服务器条目（Consensus 官方端点）
     */
    async ensureMcporterJson() {
        const rel = this.config.CONSENSUS_MCPORTER_CONFIG_PATH;
        const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
        const dir = path.dirname(abs);
        await fsp.mkdir(dir, { recursive: true });

        let data = {};
        try {
            const raw = await fsp.readFile(abs, 'utf8');
            data = JSON.parse(raw);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }

        // 文件若被误写成单个 JSON 字符串（如仅 UUID），parse 后为非对象，无法挂 mcpServers
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            logger.warn(
                `[Consensus] mcporter config is not a JSON object (got ${data === null ? 'null' : typeof data}); ` +
                    `resetting to {}. Path: ${abs}`
            );
            data = {};
        }

        data.mcpServers =
            data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
                ? data.mcpServers
                : {};
        const redirect = String(
            this.config.CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL || process.env.CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL || ''
        ).trim();
        const tokenCacheDirAbs = resolveConsensusTokenCacheDir(abs, this.config);
        const existing = data.mcpServers[this.serverName];
        const next = {
            ...(existing && typeof existing === 'object' ? existing : {}),
            url: this.mcpUrl,
            auth: 'oauth',
        };
        if (redirect) {
            next.oauthRedirectUrl = redirect;
        }
        if (tokenCacheDirAbs) {
            next.tokenCacheDir = tokenCacheDirAbs;
            await fsp.mkdir(tokenCacheDirAbs, { recursive: true });
        } else {
            delete next.tokenCacheDir;
        }
        const prevJson = JSON.stringify(existing || {});
        const nextJson = JSON.stringify(next);
        if (prevJson !== nextJson || !existing?.url) {
            data.mcpServers[this.serverName] = next;
            await fsp.writeFile(abs, JSON.stringify(data, null, 2), 'utf8');
            logger.info(
                `[Consensus] Wrote MCP server "${this.serverName}" -> ${this.mcpUrl} in ${abs}` +
                    (redirect ? ` oauthRedirectUrl=${redirect}` : '') +
                    (tokenCacheDirAbs ? ` tokenCacheDir=${tokenCacheDirAbs}` : ' (no tokenCacheDir)')
            );
        }
    }

    /**
     * 调用 MCP 工具（mcporter call）
     * @param {string} toolName - 工具名，如 search（会拼成 serverName.toolName）
     * @param {object} args - 工具参数
     */
    async callMcpTool(toolName, args = {}) {
        const selector = toolName.includes('.') ? toolName : `${this.serverName}.${toolName}`;
        const prev = this.config._mcpCall;
        this.config._mcpCall = { selector, args };
        try {
            return await runMcporterCall(this.config);
        } finally {
            if (prev !== undefined) this.config._mcpCall = prev;
            else delete this.config._mcpCall;
        }
    }

    async listModels() {
        return {
            object: 'list',
            data: [
                {
                    id: 'consensus-paper-search',
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: 'consensus',
                },
            ],
        };
    }

    _extractUserText(requestBody) {
        const messages = requestBody.messages || [];
        const last = [...messages].reverse().find((m) => m.role === 'user');
        if (!last) return 'health';
        const c = last.content;
        if (typeof c === 'string') return c || 'health';
        if (Array.isArray(c)) {
            const t = c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
            return t || 'health';
        }
        return 'health';
    }

    async generateContent(model, requestBody) {
        await this.ensureMcporterJson();
        const query = this._extractUserText(requestBody);
        const result = await this.callMcpTool('search', { query: query.slice(0, 2000) });
        const json = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return {
            id: `chatcmpl-consensus-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || 'consensus-paper-search',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: json,
                    },
                    finish_reason: 'stop',
                },
            ],
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            },
        };
    }

    async *generateContentStream(model, requestBody) {
        const unary = await this.generateContent(model, requestBody);
        yield unary;
    }

    /**
     * 使用 refresh_token 刷新 access_token 并写回 ~/.mcporter/credentials.json 与 tokenCacheDir（与 mcporter 一致）。
     * @param {boolean} [force] - true 时跳过临近过期判断
     */
    async runMcpOAuthRefresh(force = false) {
        logger.info(
            `[Consensus MCP OAuth] 刷新流程入口 | force=${force} uuid=${this.uuid ?? 'n/a'} server=${this.serverName} mcpUrl=${this.mcpUrl} config=${this.config.CONSENSUS_MCPORTER_CONFIG_PATH ?? 'n/a'}`
        );
        await this.ensureMcporterJson();
        await this.reloadOAuthSnapshot();
        const snapRt = !!this._oauthTokens?.refresh_token;
        const snapAt = typeof this._oauthTokens?.access_token === 'string' ? this._oauthTokens.access_token.length : 0;
        logger.info(
            `[Consensus MCP OAuth] 快照已加载 | tokensJson=${this._oauthTokensJsonPath ?? '(none)'} has_refresh_token=${snapRt} access_token_len=${snapAt}`
        );
        if (!force && this.isExpiryDateNear() !== true) {
            logger.info(
                '[Consensus MCP OAuth] 本次不执行 HTTP 刷新：force=false 且 access 未临近过期（由 isExpiryDateNear 判定）'
            );
            return;
        }
        if (!this._oauthTokens?.refresh_token) {
            logger.warn('[Consensus MCP OAuth] 无 refresh_token，跳过刷新（需重新 OAuth）');
            return;
        }
        const def = this.getServerDefinition();
        const t0 = Date.now();
        logger.info(
            `[Consensus MCP OAuth] 调用 SDK refreshAuthorization | persistence 目标与 [refresh 1/6] 起日志一致，总计时起点 t0=${t0}`
        );
        await refreshMcpOAuthAccessToken(def, logger);
        await this.reloadOAuthSnapshot();
        const ms = Date.now() - t0;
        const afterRt = !!this._oauthTokens?.refresh_token;
        const afterAt = typeof this._oauthTokens?.access_token === 'string' ? this._oauthTokens.access_token.length : 0;
        logger.info(
            `[Consensus MCP OAuth] 刷新流程结束 | totalDurationMs=${ms} uuid=${this.uuid ?? 'n/a'} 快照: has_refresh_token=${afterRt} access_token_len=${afterAt}`
        );
        try {
            const { getProviderPoolManager } = await import('../../services/service-manager.js');
            const pool = getProviderPoolManager();
            if (pool && this.uuid) {
                pool.resetProviderRefreshStatus(MODEL_PROVIDER.CONSENSUS_MCP, this.uuid);
                logger.info(
                    `[Consensus MCP OAuth] 号池已重置节点刷新状态 | providerType=${MODEL_PROVIDER.CONSENSUS_MCP} uuid=${this.uuid}`
                );
            } else {
                logger.info(
                    `[Consensus MCP OAuth] 跳过号池重置 | pool=${pool ? 'ok' : 'null'} uuid=${this.uuid ?? 'none'}`
                );
            }
        } catch (e) {
            logger.info(
                `[Consensus MCP OAuth] 号池重置未执行 | reason=${e instanceof Error ? e.message : String(e)}`
            );
        }
    }

    async refreshToken() {
        return this.runMcpOAuthRefresh(false);
    }

    async forceRefreshToken() {
        return this.runMcpOAuthRefresh(true);
    }

    isExpiryDateNear() {
        try {
            const nearMinutes = 20;
            if (!this._oauthTokens?.refresh_token) {
                return false;
            }
            const expMs = computeMcpAccessTokenExpiryMs(
                this._oauthTokens,
                this._oauthTokensJsonPath
            );
            if (expMs == null) {
                logger.info(
                    '[Consensus MCP OAuth] Checking expiry | 无法从 JWT / mtime 推断过期时间，不触发定时刷新（可 force 或重新授权）'
                );
                return false;
            }
            const { message, isNearExpiry } = formatExpiryLog('Consensus MCP OAuth', expMs, nearMinutes);
            logger.info(message);
            return isNearExpiry;
        } catch (error) {
            logger.error(`[Consensus MCP OAuth] Error checking expiry date: ${error.message}`);
            return false;
        }
    }
}
