/**
 * 与 mcporter `src/oauth-vault.ts` 一致：~/.mcporter/credentials.json vault 键与读写逻辑。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from './fs-json.js';

const VAULT_PATH = path.join(os.homedir(), '.mcporter', 'credentials.json');

/** @param {{ name: string, command: { kind: string, url?: URL, command?: string, args?: string[] } }} definition */
export function vaultKeyForDefinition(definition) {
    const descriptor = {
        name: definition.name,
        url: definition.command.kind === 'http' ? definition.command.url.toString() : null,
        command:
            definition.command.kind === 'stdio'
                ? { command: definition.command.command, args: definition.command.args ?? [] }
                : null,
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex').slice(0, 16);
    return `${definition.name}|${hash}`;
}

async function readVault() {
    let shouldRewrite = false;
    try {
        const existing = await readJsonFile(VAULT_PATH);
        if (existing && existing.version === 1 && existing.entries && typeof existing.entries === 'object') {
            return existing;
        }
        shouldRewrite = true;
    } catch {
        shouldRewrite = true;
    }
    const empty = { version: 1, entries: {} };
    if (shouldRewrite) {
        await writeVault(empty);
    }
    return empty;
}

async function writeVault(contents) {
    const dir = path.dirname(VAULT_PATH);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonFile(VAULT_PATH, contents);
}

/** @param {{ name: string, command: { kind: string, url?: URL } }} definition */
export async function loadVaultEntry(definition) {
    const vault = await readVault();
    return vault.entries[vaultKeyForDefinition(definition)];
}

/** @param {{ name: string, command: { kind: string, url?: URL } }} definition @param {Record<string, unknown>} patch */
export async function saveVaultEntry(definition, patch) {
    const vault = await readVault();
    const key = vaultKeyForDefinition(definition);
    const current = vault.entries[key] ?? {
        serverName: definition.name,
        serverUrl: definition.command.kind === 'http' ? definition.command.url.toString() : undefined,
        updatedAt: new Date().toISOString(),
    };
    vault.entries[key] = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    await writeVault(vault);
}

/** @param {{ name: string, command: { kind: string, url?: URL } }} definition @param {'all'|'tokens'|'client'|'verifier'|'state'} scope */
export async function clearVaultEntry(definition, scope) {
    const vault = await readVault();
    const key = vaultKeyForDefinition(definition);
    const existing = vault.entries[key];
    if (!existing) {
        return;
    }
    if (scope === 'all') {
        delete vault.entries[key];
    } else {
        const updated = { ...existing };
        if (scope === 'tokens') delete updated.tokens;
        if (scope === 'client') delete updated.clientInfo;
        if (scope === 'verifier') delete updated.codeVerifier;
        if (scope === 'state') delete updated.state;
        updated.updatedAt = new Date().toISOString();
        vault.entries[key] = updated;
    }
    await writeVault(vault);
}
