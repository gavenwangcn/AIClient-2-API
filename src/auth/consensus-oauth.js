import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import logger from '../utils/logger.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { normalizePath } from '../utils/provider-utils.js';
import { getMcporterExecutable } from '../providers/consensus/consensus-mcp-utils.js';

const DEFAULT_MCP_URL = 'https://mcp.consensus.app/mcp';
const DEFAULT_SERVER_NAME = 'consensus';
const POLL_MS = 2000;
const POLL_MAX_MS = 5 * 60 * 1000;
/** 等待 mcporter 打印授权链接的最长时间（毫秒） */
const URL_CAPTURE_TIMEOUT_MS = 45000;
const BUFFER_MAX = 512 * 1024;

/** 当前正在等待 OAuth 回调的 mcporter 子进程（新会话会结束旧进程） */
let activeConsensusAuthChild = null;

/** 汇总 mcporter 输出缓冲中的关键词，便于排查（不记录完整日志，避免刷屏） */
function summarizeMcporterOutputBuffer(buf) {
    if (!buf || typeof buf !== 'string') {
        return { len: 0 };
    }
    const lower = buf.toLowerCase();
    return {
        len: buf.length,
        hasAuthorizeUrl: !!extractConsensusAuthorizeUrl(buf),
        has401: /401|unauthorized|authentication required/i.test(buf),
        hasOAuth: /oauth|authorize/i.test(lower),
        hasSSE: /\bsse\b|sse transport/i.test(lower),
        hasStreamable: /streamable|streamable http/i.test(lower),
        hasError: /error:|failed to|exited with code/i.test(lower),
    };
}

/**
 * 从 mcporter --log-level debug 输出中提取 Consensus 授权页 URL
 * 示例：visit https://consensus.app/oauth/authorize/?response_type=code&... manually.
 * 部分环境会把 URL 折行，先压成单行再匹配。
 */
export function extractConsensusAuthorizeUrl(text) {
    if (!text || typeof text !== 'string') return null;
    const flat = text.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ');
    const re = /https:\/\/consensus\.app\/oauth\/authorize\/?[^\s"'<>]*/i;
    const m = flat.match(re);
    return m ? m[0].trim() : null;
}

/**
 * mcporter 已判定 OAuth 失败且不会进入浏览器成功路径（常见于 Docker 内 401/SSE）
 */
function isMcporterOAuthTerminalFailure(buf) {
    if (!buf || buf.length < 80) return false;
    const lower = buf.toLowerCase();
    if (!lower.includes('failed to authorize')) return false;
    return (
        (lower.includes('sse error') && lower.includes('401')) ||
        (lower.includes('non-200') && lower.includes('401')) ||
        /at handleAuth\s*\(/i.test(buf)
    );
}

/**
 * 写入/合并 mcporter.json 中的 MCP 服务器定义
 */
export async function ensureConsensusMcporterFile(absConfigPath, serverName, mcpUrl) {
    const dir = path.dirname(absConfigPath);
    await fsp.mkdir(dir, { recursive: true });

    let data = {};
    try {
        const raw = await fsp.readFile(absConfigPath, 'utf8');
        data = JSON.parse(raw);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }

    data.mcpServers = data.mcpServers || {};
    const prev = data.mcpServers[serverName];
    data.mcpServers[serverName] = {
        ...(prev && typeof prev === 'object' ? prev : {}),
        url: mcpUrl,
    };
    await fsp.writeFile(absConfigPath, JSON.stringify(data, null, 2), 'utf8');
    logger.info(
        `[Consensus OAuth] ensureConsensusMcporterFile wrote mcpServers.${serverName}.url=${mcpUrl} -> ${absConfigPath}`
    );
}

/**
 * 启发式判断 mcporter 配置是否已包含 OAuth / 会话信息（不同版本字段可能不同）
 */
export function looksLikeMcporterAuthed(content) {
    if (!content || typeof content !== 'string') return false;
    const lower = content.toLowerCase();
    return (
        lower.includes('access_token') ||
        lower.includes('refreshtoken') ||
        lower.includes('refresh_token') ||
        lower.includes('"oauth"') ||
        lower.includes('authorization') ||
        lower.includes('session')
    );
}

/**
 * 是否对 `mcporter auth` 传入 `--config`。
 * 默认 false：与「仅 URL、无 --config」在服务器上易打印 authorize 链接的行为一致；OAuth 凭据落在 mcporter 默认配置（见下方合并逻辑）。
 * 设为 true 或环境变量 CONSENSUS_MCPORTER_AUTH_USE_CONFIG=1 则恢复旧行为（凭据直接写入项目 mcporter.json）。
 */
function resolveConsensusAuthUseConfig(options) {
    if (options && typeof options.consensusMcporterAuthUseConfig === 'boolean') {
        return options.consensusMcporterAuthUseConfig;
    }
    const v = process.env.CONSENSUS_MCPORTER_AUTH_USE_CONFIG;
    if (v === '1' || /^true$/i.test(String(v || '').trim())) return true;
    if (v === '0' || /^false$/i.test(String(v || '').trim())) return false;
    return false;
}

/** mcporter 无 --config 时写入默认位置（与 steipete/mcporter 的 homeConfigCandidates 一致） */
function getMcporterHomeConfigPaths() {
    const base = path.join(os.homedir(), '.mcporter');
    return [path.join(base, 'mcporter.json'), path.join(base, 'mcporter.jsonc')];
}

/** mcporter 在 cwd 下若存在 `config/mcporter.json` 也会优先于 home */
function getMcporterProjectConfigPath() {
    return path.resolve(process.cwd(), 'config', 'mcporter.json');
}

/**
 * 将默认 mcporter 配置里 Consensus 相关条目合并到项目 `mcpServers[serverName]`，供 `mcporter call consensus.*` 使用。
 */
async function mergeConsensusMcpFromSourceToProject(absConfigPath, serverName, mcpUrl, sourcePath) {
    let raw = '';
    try {
        raw = await fsp.readFile(sourcePath, 'utf8');
    } catch {
        return false;
    }
    if (!looksLikeMcporterAuthed(raw)) return false;

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return false;
    }
    const servers = data.mcpServers || {};
    let entry = null;
    for (const v of Object.values(servers)) {
        if (v && typeof v === 'object' && typeof v.url === 'string' && v.url.includes('mcp.consensus.app')) {
            entry = { ...v };
            break;
        }
    }
    if (!entry) {
        for (const v of Object.values(servers)) {
            if (v && typeof v === 'object' && looksLikeMcporterAuthed(JSON.stringify(v))) {
                entry = { ...v };
                break;
            }
        }
    }
    if (!entry) return false;

    let target = {};
    try {
        const t = await fsp.readFile(absConfigPath, 'utf8');
        target = JSON.parse(t);
    } catch {
        /* empty */
    }
    target.mcpServers = target.mcpServers || {};
    target.mcpServers[serverName] = { ...entry, url: entry.url || mcpUrl };
    await fsp.writeFile(absConfigPath, JSON.stringify(target, null, 2), 'utf8');
    logger.info(`[Consensus OAuth] merged OAuth from ${sourcePath} into ${absConfigPath} (server=${serverName})`);
    return true;
}

/** 尝试从 mcporter 默认位置把凭据合并进项目配置 */
async function tryMergeMcporterOAuthIntoProject(absConfigPath, serverName, mcpUrl) {
    const candidates = [getMcporterProjectConfigPath(), ...getMcporterHomeConfigPaths()];
    for (const p of candidates) {
        if (path.resolve(p) === path.resolve(absConfigPath)) continue;
        const ok = await mergeConsensusMcpFromSourceToProject(absConfigPath, serverName, mcpUrl, p);
        if (ok) return true;
    }
    return false;
}

let activePollTimer = null;

function stopPreviousMcporterAuth() {
    if (activeConsensusAuthChild) {
        try {
            activeConsensusAuthChild.kill('SIGTERM');
            logger.info('[Consensus OAuth] Stopped previous mcporter auth process');
        } catch (e) {
            logger.warn(`[Consensus OAuth] Failed to kill previous mcporter: ${e.message}`);
        }
        activeConsensusAuthChild = null;
    }
}

/**
 * 启动 mcporter OAuth：解析 debug 输出中的授权链接供前端弹窗使用，并保持子进程以完成 127.0.0.1 回调。
 * 链路：客户端 → AIClient-2-API（Consensus 提供商）→ mcporter → Consensus 官方 MCP。
 */
export async function handleConsensusOAuth(currentConfig, options = {}) {
    const relConfig =
        options.consensusMcporterConfigPath ||
        options.CONFIG_PATH ||
        'configs/consensus/mcporter.json';
    const absConfig = path.isAbsolute(relConfig)
        ? relConfig
        : path.resolve(process.cwd(), relConfig);

    const mcporterBin = getMcporterExecutable();
    const mcpUrl = options.consensusMcpUrl || DEFAULT_MCP_URL;
    const serverName = options.consensusServerName || DEFAULT_SERVER_NAME;
    const oauthTimeoutMs = Number(options.oauthTimeout ?? options.consensusOAuthTimeout ?? 120000) || 120000;
    const urlCaptureTimeoutMs = Math.min(URL_CAPTURE_TIMEOUT_MS, oauthTimeoutMs);

    const authUseConfig = resolveConsensusAuthUseConfig(options);

    logger.info(
        `[Consensus OAuth] start cwd=${process.cwd()} absConfig=${absConfig} relConfig=${relConfig} bin=${mcporterBin} serverName=${serverName} mcpUrl=${mcpUrl} oauthTimeoutMs=${oauthTimeoutMs} urlCaptureTimeoutMs=${urlCaptureTimeoutMs} authUseConfig=${authUseConfig}`
    );

    await ensureConsensusMcporterFile(absConfig, serverName, mcpUrl);

    stopPreviousMcporterAuth();

    /**
     * 首参数使用官方 MCP URL。
     * - `authUseConfig === false`：与 `mcporter auth https://mcp.consensus.app/mcp --log-level debug ...` 一致，易在 debug 输出中打印 authorize 链接；凭据写入 mcporter 默认路径（如 ~/.mcporter/mcporter.json），成功后再合并到项目 absConfig。
     * - `authUseConfig === true`：传 `--config`，凭据直接写入项目文件（旧行为；部分 Docker 环境可能在打印链接前 401）。
     */
    const args = ['auth', mcpUrl, '--log-level', 'debug', '--oauth-timeout', String(oauthTimeoutMs)];
    if (authUseConfig) {
        args.splice(2, 0, '--config', absConfig);
    }

    const spawnEnv = { ...process.env };
    if (!authUseConfig && spawnEnv.MCPORTER_CONFIG) {
        delete spawnEnv.MCPORTER_CONFIG;
        logger.info('[Consensus OAuth] cleared MCPORTER_CONFIG in child env so mcporter uses default OAuth file (not project path)');
    }

    logger.info(
        `[Consensus OAuth] ${mcporterBin} ${args.join(' ')}` +
            (authUseConfig ? ` (server alias in file: ${serverName})` : ' (no --config: ad-hoc URL flow, credentials merged to project after OAuth)')
    );

    const child = spawn(mcporterBin, args, {
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    activeConsensusAuthChild = child;
    logger.info(`[Consensus OAuth] mcporter auth child spawned pid=${child.pid ?? 'n/a'}`);

    let buffer = '';
    let firstChunkLogged = false;
    const append = (chunk, streamLabel) => {
        buffer += chunk.toString();
        if (buffer.length > BUFFER_MAX) {
            buffer = buffer.slice(-BUFFER_MAX);
        }
        if (!firstChunkLogged && buffer.length > 0) {
            firstChunkLogged = true;
            logger.info(
                `[Consensus OAuth] first output from mcporter stream=${streamLabel} chunkLen=${chunk.length} summary=${JSON.stringify(summarizeMcporterOutputBuffer(buffer))}`
            );
        }
    };

    child.stdout.on('data', (c) => append(c, 'stdout'));
    child.stderr.on('data', (c) => append(c, 'stderr'));

    /** @type {number|null} */
    let childExitCode = null;
    child.on('exit', (code, signal) => {
        childExitCode = typeof code === 'number' ? code : -1;
        logger.info(
            `[Consensus OAuth] mcporter auth exited code=${code} signal=${signal || ''} bufferLen=${buffer.length} summary=${JSON.stringify(summarizeMcporterOutputBuffer(buffer))}`
        );
        if (activeConsensusAuthChild === child) {
            activeConsensusAuthChild = null;
        }
    });
    child.on('error', (err) => {
        logger.error(`[Consensus OAuth] mcporter spawn error: ${err.message}`);
        if (activeConsensusAuthChild === child) {
            activeConsensusAuthChild = null;
        }
    });

    const waitStarted = Date.now();
    const deadline = waitStarted + urlCaptureTimeoutMs;
    let authUrlCaptured = null;
    let lastProgressLog = waitStarted;
    while (Date.now() < deadline) {
        authUrlCaptured = extractConsensusAuthorizeUrl(buffer);
        if (authUrlCaptured) break;
        // 子进程退出后 Node 会同步设置 child.exitCode；勿仅依赖 exit 事件回调里写入的变量（事件相对 await 可能滞后，曾导致空等满 urlCaptureTimeoutMs）
        if (child.exitCode !== null) {
            childExitCode = child.exitCode;
            authUrlCaptured = extractConsensusAuthorizeUrl(buffer);
            if (authUrlCaptured) break;
            logger.info(
                `[Consensus OAuth] subprocess ended exitCode=${child.exitCode} bufferLen=${buffer.length}, stop waiting (no parseable authorize URL in output)`
            );
            break;
        }
        if (isMcporterOAuthTerminalFailure(buffer)) {
            logger.info(
                `[Consensus OAuth] detected terminal failure in mcporter output (401/SSE/Failed to authorize), stop waiting`
            );
            break;
        }
        const now = Date.now();
        if (now - lastProgressLog >= 5000) {
            lastProgressLog = now;
            const elapsedSec = Math.round((now - waitStarted) / 1000);
            logger.info(
                `[Consensus OAuth] still waiting for authorize URL in mcporter output elapsed=${elapsedSec}s remaining~${Math.max(0, Math.round((deadline - now) / 1000))}s ${JSON.stringify(summarizeMcporterOutputBuffer(buffer))}`
            );
        }
        await new Promise((r) => setTimeout(r, 40));
    }

    if (!authUrlCaptured) {
        authUrlCaptured = extractConsensusAuthorizeUrl(buffer);
    }

    if (authUrlCaptured) {
        logger.info(
            `[Consensus OAuth] extracted authorize URL after ${Date.now() - waitStarted}ms urlLen=${authUrlCaptured.length}`
        );
    }

    if (!authUrlCaptured) {
        try {
            child.kill('SIGTERM');
        } catch {
            /* ignore */
        }
        if (activeConsensusAuthChild === child) activeConsensusAuthChild = null;
        logger.error(`[Consensus OAuth] Log tail (truncated): ${buffer.slice(-2000)}`);
        const resolvedExit = child.exitCode !== null && child.exitCode !== undefined ? child.exitCode : childExitCode;
        if (isMcporterOAuthTerminalFailure(buffer) || (resolvedExit !== null && resolvedExit !== 0)) {
            throw new Error(
                'Consensus OAuth 失败：mcporter 在打印浏览器授权链接之前已报错（常见为 Streamable HTTP/SSE 返回 401）。' +
                    '可尝试：① 不设 CONSENSUS_MCPORTER_AUTH_USE_CONFIG（默认不传 --config，与仅 URL 的 auth 一致）；② 在宿主机执行 `mcporter auth https://mcp.consensus.app/mcp` 后将 ~/.mcporter/mcporter.json 合并进项目配置；③ Docker 使用 network_mode: host 或映射 OAuth 回调端口。' +
                    ` mcporterExitCode=${resolvedExit ?? 'null'}`
            );
        }
        const hint401 =
            /401|unauthorized|Non-200 status/i.test(buffer)
                ? ' 日志中出现 401：可尝试升级 mcporter（`npm i -g mcporter@latest`）、默认不传 --config（见 CONSENSUS_MCPORTER_AUTH_USE_CONFIG），并确保 OAuth 回调可达运行 mcporter 的 127.0.0.1。'
                : '';
        throw new Error(
            `未在 mcporter 调试输出中解析到 Consensus 授权链接。请确认可访问 https://mcp.consensus.app/mcp 且 mcporter 版本较新。${hint401}`
        );
    }

    // 保持子进程存活以监听 redirect_uri（127.0.0.1:端口/callback），不阻塞 Node 事件循环退出计数
    child.unref();

    const relNorm = normalizePath(relConfig.replace(/\\/g, '/'));
    let baseline = null;
    try {
        baseline = fs.statSync(absConfig).mtimeMs;
    } catch {
        baseline = 0;
    }

    if (activePollTimer) {
        clearInterval(activePollTimer);
        activePollTimer = null;
    }

    const started = Date.now();
    activePollTimer = setInterval(async () => {
        try {
            let text = '';
            try {
                text = await fsp.readFile(absConfig, 'utf8');
            } catch {
                return;
            }
            if (!authUseConfig && !looksLikeMcporterAuthed(text)) {
                await tryMergeMcporterOAuthIntoProject(absConfig, serverName, mcpUrl);
                try {
                    text = await fsp.readFile(absConfig, 'utf8');
                } catch {
                    return;
                }
            }
            const st = fs.statSync(absConfig);
            if (st.mtimeMs <= baseline && Date.now() - started < 3000) {
                return;
            }
            if (looksLikeMcporterAuthed(text)) {
                clearInterval(activePollTimer);
                activePollTimer = null;
                logger.info(
                    `[Consensus OAuth] Detected credentials in mcporter config (mtime delta vs baseline), broadcasting success file=${absConfig}`
                );

                broadcastEvent('oauth_success', {
                    provider: 'consensus-mcp-oauth',
                    credPath: absConfig,
                    relativePath: relNorm.startsWith('./') ? relNorm : `./${relNorm}`.replace('././', './'),
                    timestamp: new Date().toISOString(),
                });

                try {
                    await autoLinkProviderConfigs(CONFIG, {
                        onlyCurrentCred: true,
                        credPath: relNorm.startsWith('./') ? relNorm : `./${relNorm}`,
                    });
                } catch (e) {
                    logger.warn(`[Consensus OAuth] autoLinkProviderConfigs: ${e.message}`);
                }
            }
        } catch (e) {
            logger.warn(`[Consensus OAuth] poll: ${e.message}`);
        }

        if (Date.now() - started > POLL_MAX_MS) {
            clearInterval(activePollTimer);
            activePollTimer = null;
        }
    }, POLL_MS);

    logger.info(
        `[Consensus OAuth] Authorization URL captured for UI modal; child pid=${child.pid ?? 'n/a'} unref for redirect callback listener`
    );

    return {
        authUrl: authUrlCaptured,
        authInfo: {
            provider: 'consensus-mcp-oauth',
            mode: 'mcporter',
            mcporterConfigPath: relNorm,
            consensusMcpUrl: mcpUrl,
            oauthTimeoutMs,
            consensusMcporterAuthUseConfig: authUseConfig,
            instructions: authUseConfig
                ? '请点击页面上的授权链接在新窗口打开并完成 Consensus 登录。授权回调由运行 mcporter 的进程监听（通常为 127.0.0.1）。若在 Docker 内启动授权，浏览器回调可能无法到达容器内回环：可在宿主机对同一份 mcporter.json 执行 `mcporter auth https://mcp.consensus.app/mcp --config <路径>` 完成登录后再挂载凭据，或使用 host 网络/端口映射。'
                : '第一步：点击「在浏览器中打开」完成 Consensus 登录（服务器端不会自动弹系统浏览器）。第二步：登录成功后，mcporter 会把 OAuth 凭据写入其默认配置（如 ~/.mcporter/mcporter.json），本服务会合并到项目配置供后续代理免登录。若回调无法到达容器，请在可访问 127.0.0.1 的环境执行同样的 `mcporter auth https://mcp.consensus.app/mcp` 后，将 ~/.mcporter/mcporter.json 中 Consensus 条目合并进项目 configs/consensus/mcporter.json。设置 CONSENSUS_MCPORTER_AUTH_USE_CONFIG=1 可改为凭据直接写入项目文件（旧行为）。',
        },
    };
}
