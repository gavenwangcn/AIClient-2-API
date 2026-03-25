import { spawn } from 'child_process';
import path from 'path';
import logger from '../../utils/logger.js';
import { getMcporterExecutable } from './consensus-mcp-utils.js';

/**
 * @param {unknown} raw
 * @returns {{ tools: unknown[] }}
 */
export function normalizeToolsListResult(raw) {
    if (raw == null) return { tools: [] };
    if (Array.isArray(raw)) return { tools: raw };
    if (typeof raw === 'object' && Array.isArray(/** @type {{ tools?: unknown[] }} */ (raw).tools)) return /** @type {{ tools: unknown[] }} */ (raw);
    if (typeof raw === 'object' && raw.tools && typeof raw.tools === 'object') {
        return { tools: Object.values(/** @type {{ tools: Record<string, unknown> }} */ (raw).tools) };
    }
    return { tools: [] };
}

/**
 * 执行 `mcporter --config <path> list ... --json`（与 MCP 代理 tools/list 一致）。
 *
 * @param {string} configPath - mcporter.json（绝对或相对 cwd）
 * @param {{
 *   extraArgs?: string[],
 *   mcporterLogLevel?: string,
 *   logTag?: string,
 *   bin?: string,
 * }} [options]
 * @returns {Promise<unknown>}
 */
export async function runMcporterListJson(configPath, options = {}) {
    const bin = options.bin ?? getMcporterExecutable();
    const abs = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
    const extraArgs = options.extraArgs ?? [];
    const mcporterLogLevel = options.mcporterLogLevel ?? 'error';
    const logTag = options.logTag ?? '[Consensus MCP]';
    const args = ['--config', abs, '--log-level', mcporterLogLevel, 'list', ...extraArgs, '--json'];

    logger.info(`${logTag} mcporter list bin=${bin} config=${abs} extraArgs=${JSON.stringify(extraArgs)}`);
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        logger.info(`${logTag} mcporter list pid=${proc.pid ?? 'n/a'}`);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => {
            stdout += d.toString();
        });
        proc.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        proc.on('error', (e) => {
            logger.info(`${logTag} mcporter list spawn error: ${e.message}`);
            reject(e);
        });
        proc.on('close', (code) => {
            const ms = Date.now() - t0;
            if (code !== 0) {
                logger.info(
                    `${logTag} mcporter list failed code=${code} durationMs=${ms} stderrPreview=${JSON.stringify(stderr.slice(0, 800))}`
                );
                reject(new Error(stderr || stdout || `mcporter list exited ${code}`));
                return;
            }
            logger.info(`${logTag} mcporter list ok durationMs=${ms} stdoutLen=${stdout.length}`);
            try {
                resolve(stdout.trim() ? JSON.parse(stdout.trim()) : {});
            } catch {
                resolve({ raw: stdout.trim() });
            }
        });
    });
}

/**
 * OAuth 成功且配置已合并后：用 mcporter CLI 执行与线上 MCP 桥接相同的 list（含 --schema），确认落盘 token 对 mcporter 真实可用。
 *
 * @param {string} absConfigPath - mcporter.json 绝对路径
 * @param {{ serverName?: string }} [ctx]
 * @returns {Promise<{ ok: true, toolCount: number, skipped?: boolean } | { ok: false, error: string }>}
 */
export async function verifyMcporterCliAfterOAuth(absConfigPath, ctx = {}) {
    const serverName = ctx.serverName ?? 'consensus';
    const tag = '[Consensus OAuth][mcporter verify]';
    if (process.env.CONSENSUS_MCPORTER_POST_OAUTH_VERIFY === '0') {
        logger.info(`${tag} 已跳过（CONSENSUS_MCPORTER_POST_OAUTH_VERIFY=0）`);
        return { ok: true, toolCount: 0, skipped: true };
    }
    logger.info(
        `${tag} 开始：授权与合并完成后执行 mcporter list ${serverName} --schema --json，校验 CLI 能否用 vault/tokenCache 访问 MCP`
    );
    const t0 = Date.now();
    try {
        const raw = await runMcporterListJson(absConfigPath, {
            extraArgs: [serverName, '--schema'],
            logTag: tag,
            mcporterLogLevel: 'error',
        });
        const norm = normalizeToolsListResult(raw);
        const tools = norm.tools;
        const n = Array.isArray(tools) ? tools.length : 0;
        logger.info(`${tag} 完成：耗时 ${Date.now() - t0}ms，解析到工具条数=${n}`);
        if (n > 0) {
            const names = tools
                .slice(0, 12)
                .map((t) => (t && typeof t === 'object' && 'name' in t ? String(/** @type {{ name?: string }} */ (t).name) : ''))
                .filter(Boolean);
            if (names.length) {
                logger.info(`${tag} 工具名（至多 12 个）: ${names.join(', ')}${n > names.length ? ' …' : ''}`);
            }
        }
        return { ok: true, toolCount: n };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(
            `${tag} 未通过：${msg}。说明：OAuth 已由本服务落盘，但若 mcporter 子进程 list 失败，后续代理可能同样失败；请检查 MCPORTER_EXECUTABLE、${absConfigPath}、网络与凭据。`
        );
        return { ok: false, error: msg };
    }
}
