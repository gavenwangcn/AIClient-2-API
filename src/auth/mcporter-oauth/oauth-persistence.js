/**
 * 与 mcporter `src/oauth-persistence.ts` 一致：vault + 可选 tokenCacheDir 目录持久化、CompositePersistence。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from './fs-json.js';
import { clearVaultEntry, loadVaultEntry, saveVaultEntry } from './oauth-vault.js';

/** @typedef {'all'|'client'|'tokens'|'verifier'|'state'} OAuthClearScope */

class DirectoryPersistence {
    /**
     * @param {string} root
     * @param {{ info?: Function, debug?: Function }} [logger]
     */
    constructor(root, logger) {
        this.root = root;
        this.logger = logger;
        this.tokenPath = path.join(root, 'tokens.json');
        this.clientInfoPath = path.join(root, 'client.json');
        this.codeVerifierPath = path.join(root, 'code_verifier.txt');
        this.statePath = path.join(root, 'state.txt');
    }

    describe() {
        return this.root;
    }

    async ensureDir() {
        await fs.mkdir(this.root, { recursive: true });
    }

    async readTokens() {
        return readJsonFile(this.tokenPath);
    }

    async saveTokens(tokens) {
        await this.ensureDir();
        await writeJsonFile(this.tokenPath, tokens);
        this.logger?.debug?.(`Saved tokens to ${this.tokenPath}`);
    }

    async readClientInfo() {
        return readJsonFile(this.clientInfoPath);
    }

    async saveClientInfo(info) {
        await this.ensureDir();
        await writeJsonFile(this.clientInfoPath, info);
    }

    async readCodeVerifier() {
        try {
            return (await fs.readFile(this.codeVerifierPath, 'utf8')).trim();
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
    }

    async saveCodeVerifier(value) {
        await this.ensureDir();
        await fs.writeFile(this.codeVerifierPath, value, 'utf8');
    }

    async readState() {
        return readJsonFile(this.statePath);
    }

    async saveState(value) {
        await this.ensureDir();
        await writeJsonFile(this.statePath, value);
    }

    /** @param {OAuthClearScope} scope */
    async clear(scope) {
        const files = [];
        if (scope === 'all' || scope === 'tokens') files.push(this.tokenPath);
        if (scope === 'all' || scope === 'client') files.push(this.clientInfoPath);
        if (scope === 'all' || scope === 'verifier') files.push(this.codeVerifierPath);
        if (scope === 'all' || scope === 'state') files.push(this.statePath);
        await Promise.all(
            files.map(async (file) => {
                try {
                    await fs.unlink(file);
                } catch (error) {
                    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
                        throw error;
                    }
                }
            })
        );
    }
}

class VaultPersistence {
    /** @param {{ name: string, command: { kind: string, url?: URL } }} definition */
    constructor(definition) {
        this.definition = definition;
    }

    describe() {
        return '~/.mcporter/credentials.json (vault)';
    }

    async readTokens() {
        return (await loadVaultEntry(this.definition))?.tokens;
    }

    async saveTokens(tokens) {
        await saveVaultEntry(this.definition, { tokens });
    }

    async readClientInfo() {
        return (await loadVaultEntry(this.definition))?.clientInfo;
    }

    async saveClientInfo(info) {
        await saveVaultEntry(this.definition, { clientInfo: info });
    }

    async readCodeVerifier() {
        return (await loadVaultEntry(this.definition))?.codeVerifier;
    }

    async saveCodeVerifier(value) {
        await saveVaultEntry(this.definition, { codeVerifier: value });
    }

    async readState() {
        return (await loadVaultEntry(this.definition))?.state;
    }

    async saveState(value) {
        await saveVaultEntry(this.definition, { state: value });
    }

    /** @param {OAuthClearScope} scope */
    async clear(scope) {
        await clearVaultEntry(this.definition, scope);
    }
}

class CompositePersistence {
    /** @param {any[]} stores */
    constructor(stores) {
        this.stores = stores;
    }

    describe() {
        return this.stores.map((store) => store.describe()).join(' + ');
    }

    async readTokens() {
        for (const store of this.stores) {
            const result = await store.readTokens();
            if (result) return result;
        }
        return undefined;
    }

    async saveTokens(tokens) {
        await Promise.all(this.stores.map((store) => store.saveTokens(tokens)));
    }

    async readClientInfo() {
        for (const store of this.stores) {
            const result = await store.readClientInfo();
            if (result) return result;
        }
        return undefined;
    }

    async saveClientInfo(info) {
        await Promise.all(this.stores.map((store) => store.saveClientInfo(info)));
    }

    async readCodeVerifier() {
        for (const store of this.stores) {
            const result = await store.readCodeVerifier();
            if (result) return result;
        }
        return undefined;
    }

    async saveCodeVerifier(value) {
        await Promise.all(this.stores.map((store) => store.saveCodeVerifier(value)));
    }

    async readState() {
        for (const store of this.stores) {
            const result = await store.readState();
            if (result) return result;
        }
        return undefined;
    }

    async saveState(value) {
        await Promise.all(this.stores.map((store) => store.saveState(value)));
    }

    /** @param {OAuthClearScope} scope */
    async clear(scope) {
        await Promise.all(this.stores.map((store) => store.clear(scope)));
    }
}

/**
 * @param {{ name: string, command: { kind: string, url?: URL }, tokenCacheDir?: string }} definition
 * @param {{ info?: Function, debug?: Function }} [logger]
 */
export async function buildOAuthPersistence(definition, logger) {
    const vault = new VaultPersistence(definition);
    /** @type {any[]} */
    const stores = [vault];

    if (definition.tokenCacheDir) {
        stores.unshift(new DirectoryPersistence(definition.tokenCacheDir, logger));
    }

    const legacyDir = path.join(os.homedir(), '.mcporter', definition.name);
    if (!definition.tokenCacheDir && legacyDir) {
        const legacy = new DirectoryPersistence(legacyDir, logger);
        const legacyTokens = await legacy.readTokens();
        const legacyClient = await legacy.readClientInfo();
        const legacyVerifier = await legacy.readCodeVerifier();
        const legacyState = await legacy.readState();
        if (legacyTokens || legacyClient || legacyVerifier || legacyState) {
            if (legacyTokens) await vault.saveTokens(legacyTokens);
            if (legacyClient) await vault.saveClientInfo(legacyClient);
            if (legacyVerifier) await vault.saveCodeVerifier(legacyVerifier);
            if (legacyState) await vault.saveState(legacyState);
            logger?.info?.(`Migrated legacy OAuth cache for '${definition.name}' into vault.`);
        }
    }

    return stores.length === 1 ? vault : new CompositePersistence(stores);
}

/**
 * @param {{ name: string, command: { kind: string, url?: URL }, tokenCacheDir?: string }} definition
 * @param {{ info?: Function, debug?: Function }} [logger]
 */
export async function readCachedAccessToken(definition, logger) {
    const persistence = await buildOAuthPersistence(definition, logger);
    const tokens = await persistence.readTokens();
    if (tokens && typeof tokens.access_token === 'string' && tokens.access_token.trim().length > 0) {
        return tokens.access_token;
    }
    return undefined;
}
