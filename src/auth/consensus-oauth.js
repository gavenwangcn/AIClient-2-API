import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
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
    data.mcpServers[serverName] = { url: mcpUrl };
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

    logger.info(
        `[Consensus OAuth] start cwd=${process.cwd()} absConfig=${absConfig} relConfig=${relConfig} bin=${mcporterBin} serverName=${serverName} mcpUrl=${mcpUrl} oauthTimeoutMs=${oauthTimeoutMs} urlCaptureTimeoutMs=${urlCaptureTimeoutMs}`
    );

    await ensureConsensusMcporterFile(absConfig, serverName, mcpUrl);

    stopPreviousMcporterAuth();

    /**
     * 首参数使用官方 MCP URL（与服务器上可成功的 `mcporter auth https://mcp.consensus.app/mcp` 一致）。
     * 仍传 `--config`，凭据合并进同一 mcporter.json，供后续 `mcporter call consensus.*`（配置里保留 mcpServers[serverName]）。
     * 仅用 `auth consensus` 时 mcporter 走「已命名服务器」分支，与 ad-hoc URL 的 OAuth/传输探测路径不同，部分环境会在 Streamable HTTP/SSE 握手阶段 401，无法打印浏览器链接。
     */
    const args = [
        'auth',
        mcpUrl,
        '--config',
        absConfig,
        '--log-level',
        'debug',
        '--oauth-timeout',
        String(oauthTimeoutMs),
    ];

    logger.info(`[Consensus OAuth] ${mcporterBin} ${args.join(' ')} (server alias in file: ${serverName})`);

    const child = spawn(mcporterBin, args, {
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
                    '在宿主机上执行与官方一致的命令可成功（无 Docker 网络隔离）：' +
                    '`/usr/bin/mcporter auth https://mcp.consensus.app/mcp --config <你的 mcporter.json>`，完成后将 `mcporter.json` 挂回容器。' +
                    '或在 Docker 使用 `network_mode: host` / 将授权回调端口映射到宿主机。' +
                    ` mcporterExitCode=${resolvedExit ?? 'null'}`
            );
        }
        const hint401 =
            /401|unauthorized|Non-200 status/i.test(buffer)
                ? ' 日志中出现 401 / unauthorized：多为 mcporter 与官方 MCP 在 Streamable HTTP/SSE 握手阶段未进入浏览器 OAuth（可尝试升级镜像内 mcporter：`npm i -g mcporter@latest`）。若在 Docker 内运行，OAuth 回调需落在能访问容器内 127.0.0.1 的环境，或在本机执行 `mcporter auth https://mcp.consensus.app/mcp --config <你的 mcporter.json>` 后将凭据文件挂载进容器。'
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
            instructions:
                '请点击「在浏览器中打开」完成 Consensus 登录。授权回调由运行 mcporter 的进程监听（通常为 127.0.0.1）。若在 Docker 内启动授权，浏览器回调可能无法到达容器内回环：可在宿主机对同一份 mcporter.json 执行 `/usr/bin/mcporter auth consensus --config ...` 完成登录后再挂载凭据，或为容器配置 host 网络/端口映射以接收回调。',
        },
    };
}
