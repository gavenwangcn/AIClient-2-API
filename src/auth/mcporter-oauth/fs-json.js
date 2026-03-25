import fs from 'node:fs/promises';
import path from 'node:path';

/** @param {string} filePath */
export async function readJsonFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

/** @param {string} filePath @param {unknown} data */
export async function writeJsonFile(filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}
