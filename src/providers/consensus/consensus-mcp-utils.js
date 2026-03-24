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
