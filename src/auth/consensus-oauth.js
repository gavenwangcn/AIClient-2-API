import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import logger from '../utils/logger.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { normalizePath } from '../utils/provider-utils.js';
import { resolveMcporterExecutable } from '../providers/consensus/consensus-mcp-utils.js';

const DEFAULT_MCP_URL = 'https://mcp.consensus.app/mcp';
const DEFAULT_SERVER_NAME = 'consensus';
const POLL_MS = 2000;
const POLL_MAX_MS = 5 * 60 * 1000;
/** 等待 mcporter 打印授权链接的最长时间（毫秒） */
const URL_CAPTURE_TIMEOUT_MS = 45000;
const BUFFER_MAX = 512 * 1024;

/** 当前正在等待 OAuth 回调的 mcporter 子进程（新会话会结束旧进程） */
let activeConsensusAuthChild = null;

/**
 * 从 mcporter --log-level debug 输出中提取 Consensus 授权页 URL
 * 示例：visit https://consensus.app/oauth/authorize/?response_type=code&... manually.
 */
export function extractConsensusAuthorizeUrl(text) {
    if (!text || typeof text !== 'string') return null;
    // mcporter 日志示例：... visit https://consensus.app/oauth/authorize/?response_type=code&... manually.
    const re = /https:\/\/consensus\.app\/oauth\/authorize\/?[^\s"'<>]+/i;
    const m = text.match(re);
    return m ? m[0] : null;
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

    const oauthMerge = { ...currentConfig };
    if (options.consensusMcporterPath) oauthMerge.CONSENSUS_MCPORTER_PATH = options.consensusMcporterPath;
    if (options.CONSENSUS_MCPORTER_PATH) oauthMerge.CONSENSUS_MCPORTER_PATH = options.CONSENSUS_MCPORTER_PATH;
    const mcporterBin = resolveMcporterExecutable(oauthMerge);
    const mcpUrl = options.consensusMcpUrl || DEFAULT_MCP_URL;
    const serverName = options.consensusServerName || DEFAULT_SERVER_NAME;
    const oauthTimeoutMs = Number(options.oauthTimeout ?? options.consensusOAuthTimeout ?? 120000) || 120000;
    const urlCaptureTimeoutMs = Math.min(URL_CAPTURE_TIMEOUT_MS, oauthTimeoutMs);

    await ensureConsensusMcporterFile(absConfig, serverName, mcpUrl);

    stopPreviousMcporterAuth();

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

    logger.info(`[Consensus OAuth] ${mcporterBin} ${args.join(' ')}`);

    const child = spawn(mcporterBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    activeConsensusAuthChild = child;

    let buffer = '';
    const append = (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > BUFFER_MAX) {
            buffer = buffer.slice(-BUFFER_MAX);
        }
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);

    child.on('exit', (code, signal) => {
        logger.info(`[Consensus OAuth] mcporter auth exited code=${code} signal=${signal || ''}`);
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

    const deadline = Date.now() + urlCaptureTimeoutMs;
    let authUrlCaptured = null;
    while (Date.now() < deadline) {
        authUrlCaptured = extractConsensusAuthorizeUrl(buffer);
        if (authUrlCaptured) break;
        await new Promise((r) => setTimeout(r, 40));
    }

    if (!authUrlCaptured) {
        try {
            child.kill('SIGTERM');
        } catch {
            /* ignore */
        }
        if (activeConsensusAuthChild === child) activeConsensusAuthChild = null;
        logger.error(`[Consensus OAuth] Log tail (truncated): ${buffer.slice(-2000)}`);
        throw new Error(
            '未在 mcporter 调试输出中解析到 Consensus 授权链接。请确认本机已安装 mcporter 且可访问 MCP，或稍后重试。'
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
                logger.info('[Consensus OAuth] Detected credentials in mcporter config, broadcasting success');

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

    logger.info('[Consensus OAuth] Authorization URL captured for UI modal');

    return {
        authUrl: authUrlCaptured,
        authInfo: {
            provider: 'consensus-mcp-oauth',
            mode: 'mcporter',
            mcporterConfigPath: relNorm,
            consensusMcpUrl: mcpUrl,
            oauthTimeoutMs,
            instructions:
                '请点击「在浏览器中打开」完成 Consensus 登录。授权回调由本机 mcporter 进程监听（redirect_uri 为 127.0.0.1），请在与运行 mcporter 相同的环境中打开链接，或使用远程桌面在服务器本机浏览器中完成授权。',
        },
    };
}
