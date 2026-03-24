import { CONFIG } from '../../core/config-manager.js';

/**
 * 解析 mcporter 可执行文件路径：号池节点配置优先，其次全局 configs/config.json 中的 CONSENSUS_MCPORTER_PATH，最后回退到 PATH 上的 `mcporter`。
 * @param {Object} serviceConfig - 合并后的单次请求/节点配置（含 CONSENSUS_MCPORTER_PATH）
 * @returns {string}
 */
export function resolveMcporterExecutable(serviceConfig) {
    const fromNode = serviceConfig?.CONSENSUS_MCPORTER_PATH;
    if (fromNode !== undefined && fromNode !== null && String(fromNode).trim() !== '') {
        return String(fromNode).trim();
    }
    const fromGlobal = CONFIG?.CONSENSUS_MCPORTER_PATH;
    if (fromGlobal !== undefined && fromGlobal !== null && String(fromGlobal).trim() !== '') {
        return String(fromGlobal).trim();
    }
    return 'mcporter';
}
