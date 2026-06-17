import path from 'path';
import { existsSync } from 'fs';

/**
 * 用户插件目录（可通过 USER_PLUGINS_DIR 覆盖，Docker 建议挂载到 /app/plugins-user）
 * @param {string} [cwd]
 * @returns {string}
 */
export function getUserPluginsDir(cwd = process.cwd()) {
    const custom = process.env.USER_PLUGINS_DIR?.trim();
    if (custom) {
        return path.isAbsolute(custom) ? custom : path.join(cwd, custom);
    }

    const rootDir = path.join(cwd, 'plugins-user');
    if (existsSync(rootDir)) {
        return rootDir;
    }

    return path.join(cwd, 'src', 'plugins-user');
}
