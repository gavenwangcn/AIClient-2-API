import path from 'path';

/**
 * Docker 镜像内 mcporter 安装在固定路径；本地可通过环境变量 MCPORTER_EXECUTABLE 覆盖（无需 UI/配置文件）。
 * @returns {string}
 */
export function getMcporterExecutable() {
    const v = process.env.MCPORTER_EXECUTABLE;
    if (v !== undefined && v !== null && String(v).trim() !== '') {
        return String(v).trim();
    }
    return '/usr/bin/mcporter';
}

/**
 * 解析 mcporter 的 `tokenCacheDir`：与 `~/.mcporter/credentials.json` vault 组合时，同套 OAuth token 会同步写入该目录下的 `tokens.json`（见 mcporter `buildOAuthPersistence`）。
 * @param {string} absConfigPath - mcporter.json 绝对路径
 * @param {object} [options] - 请求体、provider 配置或 `process.env` 中可含 `CONSENSUS_MCPORTER_TOKEN_CACHE_DIR` / `CONSENSUS_MCPORTER_TOKEN_CACHE_DISABLE`
 * @returns {string|null} 绝对路径；`null` 表示不在配置中设置 `tokenCacheDir`（仅用 vault）
 */
export function resolveConsensusTokenCacheDir(absConfigPath, options = {}) {
    const disable =
        options.consensusTokenCacheDirDisable === true ||
        options.CONSENSUS_MCPORTER_TOKEN_CACHE_DISABLE === '1' ||
        options.CONSENSUS_MCPORTER_TOKEN_CACHE_DISABLE === 1 ||
        /^true$/i.test(String(options.CONSENSUS_MCPORTER_TOKEN_CACHE_DISABLE ?? '')) ||
        process.env.CONSENSUS_MCPORTER_TOKEN_CACHE_DISABLE === '1' ||
        /^true$/i.test(String(process.env.CONSENSUS_MCPORTER_TOKEN_CACHE_DISABLE ?? ''));
    if (disable) {
        return null;
    }

    const explicit =
        options.consensusTokenCacheDir ??
        options.CONSENSUS_MCPORTER_TOKEN_CACHE_DIR ??
        process.env.CONSENSUS_MCPORTER_TOKEN_CACHE_DIR;
    if (typeof explicit === 'string' && explicit.trim()) {
        const p = explicit.trim();
        return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    }

    return path.join(path.dirname(absConfigPath), 'oauth-cache');
}
