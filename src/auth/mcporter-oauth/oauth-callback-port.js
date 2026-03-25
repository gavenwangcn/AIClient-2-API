/**
 * 探测本机 TCP 端口是否可被 bind（无其他进程占用）。
 * 用于 OAuth 固定 redirect 端口：占用则不应再开启新的回调监听。
 */
import net from 'node:net';

/**
 * @param {string} host - 与 oauthRedirectUrl 中 hostname 一致（如 localhost、127.0.0.1）
 * @param {number} port
 * @returns {Promise<boolean>} true 表示当前可监听，false 表示已被占用（EADDRINUSE）
 */
export function probeTcpPortAvailable(host, port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', (err) => {
            const code = /** @type {NodeJS.ErrnoException} */ (err).code;
            if (code === 'EADDRINUSE') {
                resolve(false);
                return;
            }
            reject(err);
        });
        server.listen(port, host, () => {
            server.close(() => resolve(true));
        });
    });
}
