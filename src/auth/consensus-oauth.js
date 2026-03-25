import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import logger from '../utils/logger.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { normalizePath } from '../utils/provider-utils.js';
import { getMcporterExecutable, resolveConsensusTokenCacheDir } from '../providers/consensus/consensus-mcp-utils.js';

const DEFAULT_MCP_URL = 'https://mcp.consensus.app/mcp';
const DEFAULT_SERVER_NAME = 'consensus';
const POLL_MS = 2000;
const POLL_MAX_MS = 5 * 60 * 1000;
/** 等待 mcporter 打印授权链接的最长时间（毫秒） */
const URL_CAPTURE_TIMEOUT_MS = 45000;
const BUFFER_MAX = 512 * 1024;

/** 当前正在等待 OAuth 回调的 mcporter 子进程（新会话会结束旧进程） */
let activeConsensusAuthChild = null;

/** 汇总 mcporter 输出缓冲中的关键词，便于排查（不记录完整日志，避免刷屏） */
function summarizeMcporterOutputBuffer(buf) {
    if (!buf || typeof buf !== 'string') {
        return { len: 0 };
    }
    const lower = buf.toLowerCase();
    return {
        len: buf.length,
        hasAuthorizeUrl: !!extractConsensusAuthorizeUrl(buf),
        has401: /401|unauthorized|authentication required/i.test(buf),
        hasOAuth: /oauth|authorize/i.test(lower),
        hasSSE: /\bsse\b|sse transport/i.test(lower),
        hasStreamable: /streamable|streamable http/i.test(lower),
        hasError: /error:|failed to|exited with code/i.test(lower),
    };
}

/**
 * 从 mcporter --log-level debug 输出中提取 Consensus 授权页 URL
 * 示例：visit https://consensus.app/oauth/authorize/?response_type=code&... manually.
 * 部分环境会把 URL 折行，先压成单行再匹配。
 */
export function extractConsensusAuthorizeUrl(text) {
    if (!text || typeof text !== 'string') return null;
    const flat = text.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ');
    const re = /https:\/\/consensus\.app\/oauth\/authorize\/?[^\s"'<>]*/i;
    const m = flat.match(re);
    return m ? m[0].trim() : null;
}

/** 仅用于日志：从授权 URL 中解析 redirect_uri（不记录 client_secret 等） */
function describeAuthorizeUrlForLog(authorizeUrl) {
    try {
        const u = new URL(authorizeUrl);
        const ru = u.searchParams.get('redirect_uri');
        const scope = u.searchParams.get('scope');
        const resource = u.searchParams.get('resource');
        const parts = [
            ru ? `redirect_uri=${ru}` : null,
            scope ? `scope=${scope}` : null,
            resource ? `resource=${resource}` : null,
        ].filter(Boolean);
        return parts.length ? parts.join(' ') : `host=${u.host}`;
    } catch {
        return 'url_parse_error';
    }
}

/**
 * mcporter 已判定 OAuth 失败且不会进入浏览器成功路径（常见于 Docker 内 401/SSE）
 */
function isMcporterOAuthTerminalFailure(buf) {
    if (!buf || buf.length < 80) return false;
    const lower = buf.toLowerCase();
    if (!lower.includes('failed to authorize')) return false;
    return (
        (lower.includes('sse error') && lower.includes('401')) ||
        (lower.includes('non-200') && lower.includes('401')) ||
        /at handleAuth\s*\(/i.test(buf)
    );
}

/**
 * 写入/合并 mcporter.json 中的 MCP 服务器定义
 * @param {string} [oauthRedirectUrl] - 若设置，写入 oauthRedirectUrl，供 mcporter 固定本机回调端口（见 mcporter 的 PersistentOAuthClientProvider）
 * @param {string|null|undefined} [tokenCacheDirAbs] - 若传字符串，写入 `tokenCacheDir`（与 vault 同用，见 mcporter `buildOAuthPersistence`）；`null` 表示移除该字段；`undefined` 表示不修改已有值
 */
export async function ensureConsensusMcporterFile(absConfigPath, serverName, mcpUrl, oauthRedirectUrl = '', tokenCacheDirAbs) {
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
    const prev = data.mcpServers[serverName];
    const trimmedRedirect =
        typeof oauthRedirectUrl === 'string' && oauthRedirectUrl.trim().length > 0 ? oauthRedirectUrl.trim() : '';
    const entry = {
        ...(prev && typeof prev === 'object' ? prev : {}),
        url: mcpUrl,
        /** 显式 OAuth：mcporter 会先于首次 HTTP 连接建立 OAuth 会话并打印浏览器授权链接；省略时易先走 Streamable/SSE 匿名请求导致 401 且来不及进入浏览器流（Docker 中常见）。 */
        auth: 'oauth',
    };
    if (trimmedRedirect) {
        entry.oauthRedirectUrl = trimmedRedirect;
    }
    if (tokenCacheDirAbs !== undefined) {
        if (tokenCacheDirAbs === null) {
            delete entry.tokenCacheDir;
        } else {
            entry.tokenCacheDir = tokenCacheDirAbs;
            await fsp.mkdir(tokenCacheDirAbs, { recursive: true });
        }
    }
    data.mcpServers[serverName] = entry;
    await fsp.writeFile(absConfigPath, JSON.stringify(data, null, 2), 'utf8');
    const hadPrev = !!(prev && typeof prev === 'object');
    const hadTokens = hadPrev && looksLikeMcporterAuthed(JSON.stringify(prev));
    logger.info(
        `[Consensus OAuth] ensureConsensusMcporterFile wrote mcpServers.${serverName}.url=${mcpUrl} -> ${absConfigPath}` +
            ` hadPreviousEntry=${hadPrev} preservedOAuthLikeFields=${hadTokens}` +
            (trimmedRedirect ? ` oauthRedirectUrl=${trimmedRedirect} (fixed callback; Docker 需映射同端口到容器)` : '') +
            (tokenCacheDirAbs !== undefined && tokenCacheDirAbs !== null
                ? ` tokenCacheDir=${tokenCacheDirAbs}`
                : tokenCacheDirAbs === null
                  ? ' tokenCacheDir=(cleared)'
                  : '')
    );
}

/**
 * 启发式判断 mcporter 配置是否已包含 OAuth / 会话信息（不同版本字段可能不同）
 */
export function looksLikeMcporterAuthed(content) {
    if (!content || typeof content !== 'string') return false;
    const lower = content.toLowerCase();
    return (
        lower.includes('access_token') ||
        lower.includes('accesstoken') ||
        lower.includes('refreshtoken') ||
        lower.includes('refresh_token') ||
        lower.includes('"oauth"') ||
        lower.includes('authorization') ||
        lower.includes('session')
    );
}

/**
 * 是否将 OAuth 敏感信息写入日志（授权码、access_token、refresh_token 等）。
 * 默认关闭；排查时设置 CONSENSUS_MCPORTER_LOG_SECRETS=1 或 CONSENSUS_OAUTH_LOG_SECRETS=1。
 * 生产环境切勿开启，日志泄露等同于账号泄露。
 */
export function isConsensusOAuthSecretsLogEnabled() {
    const v = process.env.CONSENSUS_MCPORTER_LOG_SECRETS ?? process.env.CONSENSUS_OAUTH_LOG_SECRETS;
    return v === '1' || /^true$/i.test(String(v || '').trim());
}

function collectOAuthSecretFields(obj) {
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    const keys = new Set([
        'access_token',
        'refresh_token',
        'accessToken',
        'refreshToken',
        'token',
        'id_token',
        'bearerToken',
    ]);
    for (const [k, v] of Object.entries(obj)) {
        if (keys.has(k) && typeof v === 'string' && v.length > 0) {
            out[k] = v;
        }
        if (k === 'oauth' && v && typeof v === 'object') {
            Object.assign(out, collectOAuthSecretFields(v));
        }
    }
    return out;
}

/**
 * 从 mcporter.json 文本中解析 Consensus 条目并打印敏感字段（仅 SECRETS_LOG 开启时）
 */
function logConsensusMcporterJsonSecrets(sourceLabel, text, serverName) {
    if (!isConsensusOAuthSecretsLogEnabled() || !text) return;
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return;
    }
    const servers = data.mcpServers || {};
    let entry = servers[serverName];
    if (!entry) {
        for (const v of Object.values(servers)) {
            if (v && typeof v === 'object' && typeof v.url === 'string' && v.url.includes('mcp.consensus.app')) {
                entry = v;
                break;
            }
        }
    }
    if (!entry || typeof entry !== 'object') return;
    const fields = collectOAuthSecretFields(entry);
    if (Object.keys(fields).length === 0) return;
    logger.info(
        `[Consensus OAuth] SECRETS_LOG ${sourceLabel} ${JSON.stringify(fields)}`
    );
}

let lastLoggedOAuthCode = '';
let lastLoggedBufferTokenFingerprint = '';

function tryLogOAuthArtifactsFromMcporterBuffer(buffer) {
    if (!isConsensusOAuthSecretsLogEnabled() || !buffer) return;
    const codeMatch = buffer.match(/(?:[?&]code=)([^&\s#'"<>]+)/i);
    if (codeMatch?.[1] && codeMatch[1] !== lastLoggedOAuthCode) {
        lastLoggedOAuthCode = codeMatch[1];
        logger.info(`[Consensus OAuth] SECRETS_LOG oauth_authorization_code=${codeMatch[1]}`);
    }
    const at = buffer.match(/"access_token"\s*:\s*"([^"]*)"/i);
    const rt = buffer.match(/"refresh_token"\s*:\s*"([^"]*)"/i);
    const fp = `${at?.[1]?.slice(0, 8) || ''}|${rt?.[1]?.slice(0, 8) || ''}`;
    if ((at || rt) && fp !== lastLoggedBufferTokenFingerprint) {
        lastLoggedBufferTokenFingerprint = fp;
        if (at) logger.info(`[Consensus OAuth] SECRETS_LOG access_token (from mcporter stream)=${at[1]}`);
        if (rt) logger.info(`[Consensus OAuth] SECRETS_LOG refresh_token (from mcporter stream)=${rt[1]}`);
    }
}

/**
 * 是否对 `mcporter auth` 传入 `--config`。
 * 默认 false：页面上「生成授权」执行 `mcporter auth <服务器名> ...`（如 consensus），不传 `--config`。
 * 固定回调 oauthRedirectUrl 应在 Docker/环境中预先配置（环境变量或已写入 ~/.mcporter/mcporter.json）；
 * 未使用 --config 时，handleConsensusOAuth 会在启动前把 `mcpServers.<serverName>` 同步到 ~/.mcporter/mcporter.json，供 mcporter 按名称解析 url / oauthRedirectUrl。
 * 仅当 CONSENSUS_MCPORTER_AUTH_USE_CONFIG=1/true 或请求体 consensusMcporterAuthUseConfig=true 时启用 --config（凭据直接写入项目 mcporter.json，旧行为）。
 * @returns {{ value: boolean, source: string }}
 */
function resolveConsensusAuthUseConfigMeta(options) {
    if (options && typeof options.consensusMcporterAuthUseConfig === 'boolean') {
        return {
            value: options.consensusMcporterAuthUseConfig,
            source: 'request body consensusMcporterAuthUseConfig',
        };
    }
    const raw = process.env.CONSENSUS_MCPORTER_AUTH_USE_CONFIG;
    const v = raw === undefined ? '' : String(raw).trim();
    if (v === '1' || /^true$/i.test(v)) {
        return { value: true, source: 'env CONSENSUS_MCPORTER_AUTH_USE_CONFIG=true' };
    }
    if (v === '0' || /^false$/i.test(v)) {
        return { value: false, source: 'env CONSENSUS_MCPORTER_AUTH_USE_CONFIG=false' };
    }
    if (v.length > 0) {
        return {
            value: false,
            source: `env CONSENSUS_MCPORTER_AUTH_USE_CONFIG (未识别 "${v}"，按 false)`,
        };
    }
    return {
        value: false,
        source: 'default false（生成授权不传 --config）',
    };
}

/** mcporter 无 --config 时写入默认位置（与 steipete/mcporter 的 homeConfigCandidates 一致） */
function getMcporterHomeConfigPaths() {
    const base = path.join(os.homedir(), '.mcporter');
    return [path.join(base, 'mcporter.json'), path.join(base, 'mcporter.jsonc')];
}

/** mcporter 0.7.x OAuth vault：access/refresh 等在 ~/.mcporter/credentials.json */
function getMcporterVaultCredentialsPath() {
    return path.join(os.homedir(), '.mcporter', 'credentials.json');
}

/** mcporter 在 cwd 下若存在 `config/mcporter.json` 也会优先于 home */
function getMcporterProjectConfigPath() {
    return path.resolve(process.cwd(), 'config', 'mcporter.json');
}

/**
 * 将默认 mcporter 配置里 Consensus 相关条目合并到项目 `mcpServers[serverName]`，供 `mcporter call consensus.*` 使用。
 */
async function mergeConsensusMcpFromSourceToProject(absConfigPath, serverName, mcpUrl, sourcePath) {
    let raw = '';
    try {
        raw = await fsp.readFile(sourcePath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') {
            return false;
        }
        logger.info(`[Consensus OAuth] merge skip: cannot read ${sourcePath} (${e.code || e.message || 'unknown'})`);
        return false;
    }
    if (!looksLikeMcporterAuthed(raw)) {
        logger.info(
            `[Consensus OAuth] merge skip: ${sourcePath} has no OAuth-like fields (len=${raw.length})`
        );
        return false;
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        logger.info(`[Consensus OAuth] merge skip: ${sourcePath} JSON parse failed: ${e.message}`);
        return false;
    }
    const servers = data.mcpServers || {};
    const serverNames = Object.keys(servers);
    let entry = null;
    let entrySource = '';
    for (const v of Object.values(servers)) {
        if (v && typeof v === 'object' && typeof v.url === 'string' && v.url.includes('mcp.consensus.app')) {
            entry = { ...v };
            entrySource = 'url contains mcp.consensus.app';
            break;
        }
    }
    if (!entry) {
        for (const v of Object.values(servers)) {
            if (v && typeof v === 'object' && looksLikeMcporterAuthed(JSON.stringify(v))) {
                entry = { ...v };
                entrySource = 'first server with oauth-like fields';
                break;
            }
        }
    }
    if (!entry) {
        logger.info(
            `[Consensus OAuth] merge skip: ${sourcePath} mcpServers has no usable entry (keys=${serverNames.join(',') || 'none'})`
        );
        return false;
    }

    const mergedKeys = Object.keys(entry).filter((k) => k !== 'url');
    let target = {};
    try {
        const t = await fsp.readFile(absConfigPath, 'utf8');
        target = JSON.parse(t);
    } catch {
        /* empty */
    }
    target.mcpServers = target.mcpServers || {};
    target.mcpServers[serverName] = { ...entry, url: entry.url || mcpUrl };
    await fsp.writeFile(absConfigPath, JSON.stringify(target, null, 2), 'utf8');
    logger.info(
        `[Consensus OAuth] merged OAuth from ${sourcePath} -> ${absConfigPath} server=${serverName} pick=${entrySource} entryKeys=${Object.keys(entry).join(',')}` +
            (mergedKeys.length ? ` nonUrlKeys=${mergedKeys.join(',')}` : '')
    );
    if (isConsensusOAuthSecretsLogEnabled()) {
        logConsensusMcporterJsonSecrets(`merge source file ${sourcePath}`, raw, serverName);
        try {
            const mergedText = await fsp.readFile(absConfigPath, 'utf8');
            logConsensusMcporterJsonSecrets(`merge target after write ${absConfigPath}`, mergedText, serverName);
        } catch {
            /* ignore */
        }
    }
    return true;
}

/** 供日志展示的合并候选路径（不含与项目文件同一路径） */
function getMergeCandidatePathsForLog(absConfigPath) {
    const extra = [getMcporterVaultCredentialsPath()];
    return [...extra, getMcporterProjectConfigPath(), ...getMcporterHomeConfigPaths()].filter(
        (p) => path.resolve(p) !== path.resolve(absConfigPath)
    );
}

/**
 * 从 ~/.mcporter/credentials.json（vault）合并 Consensus 条目到项目 mcporter.json
 * 结构见 mcporter oauth-vault：{ version:1, entries: { "<name>|<hash>": { tokens, serverUrl, ... } } }
 */
async function mergeConsensusMcpFromVaultCredentials(absConfigPath, serverName, mcpUrl) {
    const vaultPath = getMcporterVaultCredentialsPath();
    let raw = '';
    try {
        raw = await fsp.readFile(vaultPath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') {
            return false;
        }
        logger.info(`[Consensus OAuth] vault merge: cannot read ${vaultPath} (${e.code || e.message})`);
        return false;
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        logger.info(`[Consensus OAuth] vault merge: JSON parse failed ${vaultPath}: ${e.message}`);
        return false;
    }
    if (!data || data.version !== 1 || !data.entries || typeof data.entries !== 'object') {
        return false;
    }
    let picked = null;
    let pickedKey = '';
    for (const [key, entry] of Object.entries(data.entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const url = entry.serverUrl || '';
        if (typeof url === 'string' && url.includes('mcp.consensus.app')) {
            picked = entry;
            pickedKey = key;
            break;
        }
    }
    if (!picked) {
        for (const [key, entry] of Object.entries(data.entries)) {
            if (!entry || typeof entry !== 'object') continue;
            const tok = entry.tokens;
            if (tok && typeof tok === 'object' && (tok.access_token || tok.refresh_token)) {
                const hay = JSON.stringify(entry);
                if (hay.includes('mcp.consensus.app') || hay.includes('consensus')) {
                    picked = entry;
                    pickedKey = key;
                    break;
                }
            }
        }
    }
    if (!picked || !picked.tokens || typeof picked.tokens !== 'object') {
        return false;
    }
    const t = picked.tokens;
    if (!t.access_token && !t.refresh_token) {
        return false;
    }

    let target = {};
    try {
        const prev = await fsp.readFile(absConfigPath, 'utf8');
        target = JSON.parse(prev);
    } catch {
        /* empty */
    }
    target.mcpServers = target.mcpServers || {};
    target.mcpServers[serverName] = {
        ...(target.mcpServers[serverName] && typeof target.mcpServers[serverName] === 'object'
            ? target.mcpServers[serverName]
            : {}),
        url: picked.serverUrl || mcpUrl,
        ...t,
    };
    await fsp.writeFile(absConfigPath, JSON.stringify(target, null, 2), 'utf8');
    logger.info(
        `[Consensus OAuth] merged OAuth from vault ${vaultPath} entry=${pickedKey} -> ${absConfigPath} server=${serverName}`
    );
    if (isConsensusOAuthSecretsLogEnabled()) {
        try {
            const mergedText = await fsp.readFile(absConfigPath, 'utf8');
            logConsensusMcporterJsonSecrets(`vault merge target ${absConfigPath}`, mergedText, serverName);
        } catch {
            /* ignore */
        }
    }
    return true;
}

/** 尝试从 mcporter 默认位置把凭据合并进项目配置 */
async function tryMergeMcporterOAuthIntoProject(absConfigPath, serverName, mcpUrl) {
    const okVault = await mergeConsensusMcpFromVaultCredentials(absConfigPath, serverName, mcpUrl);
    if (okVault) return true;

    const candidates = [getMcporterProjectConfigPath(), ...getMcporterHomeConfigPaths()];
    for (const p of candidates) {
        if (path.resolve(p) === path.resolve(absConfigPath)) continue;
        const ok = await mergeConsensusMcpFromSourceToProject(absConfigPath, serverName, mcpUrl, p);
        if (ok) return true;
    }
    return false;
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
 * 启动 mcporter OAuth：解析 debug 输出中的授权链接供前端弹窗使用，并保持子进程以完成 localhost 回调。
 * 链路：客户端 → AIClient-2-API（Consensus 提供商）→ mcporter → Consensus 官方 MCP。
 */
export async function handleConsensusOAuth(currentConfig, options = {}) {
    lastLoggedOAuthCode = '';
    lastLoggedBufferTokenFingerprint = '';

    const relConfig =
        options.consensusMcporterConfigPath ||
        options.CONFIG_PATH ||
        'configs/consensus/mcporter.json';
    const absConfig = path.isAbsolute(relConfig)
        ? relConfig
        : path.resolve(process.cwd(), relConfig);

    const mcporterBin = getMcporterExecutable();
    const mcpUrl = options.consensusMcpUrl || DEFAULT_MCP_URL;
    const serverName = options.consensusServerName || DEFAULT_SERVER_NAME;
    const oauthTimeoutMs = Number(options.oauthTimeout ?? options.consensusOAuthTimeout ?? 120000) || 120000;
    const urlCaptureTimeoutMs = Math.min(URL_CAPTURE_TIMEOUT_MS, oauthTimeoutMs);

    const oauthRedirectUrl = (
        options.consensusOAuthRedirectUrl ??
        process.env.CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL ??
        ''
    ).trim();

    const authMeta = resolveConsensusAuthUseConfigMeta(options);
    const authUseConfig = authMeta.value;

    logger.info(
        `[Consensus OAuth] start cwd=${process.cwd()} absConfig=${absConfig} relConfig=${relConfig} bin=${mcporterBin} serverName=${serverName} mcpUrl=${mcpUrl} oauthTimeoutMs=${oauthTimeoutMs} urlCaptureTimeoutMs=${urlCaptureTimeoutMs}`
    );
    logger.info(`[Consensus OAuth] authUseConfig=${authUseConfig} (${authMeta.source})`);
    logger.info(
        `[Consensus OAuth] paths: homedir=${os.homedir()} mergeCandidates=${JSON.stringify(getMergeCandidatePathsForLog(absConfig))}`
    );
    if (isConsensusOAuthSecretsLogEnabled()) {
        logger.warn(
            '[Consensus OAuth] CONSENSUS_MCPORTER_LOG_SECRETS=1：将在日志中打印 oauth code / access_token / refresh_token（仅用于排查，禁止在生产长期开启）'
        );
    }

    if (oauthRedirectUrl) {
        logger.info(
            `[Consensus OAuth] fixed OAuth callback via oauthRedirectUrl=${oauthRedirectUrl} (mcporter listens on this URL; set Docker port mapping e.g. -p 19876:19876 for same port)`
        );
    }

    const mergedForTokenCache = { ...(currentConfig && typeof currentConfig === 'object' ? currentConfig : {}), ...options };
    const tokenCacheDirAbs = resolveConsensusTokenCacheDir(absConfig, mergedForTokenCache);
    if (tokenCacheDirAbs) {
        logger.info(
            `[Consensus OAuth] tokenCacheDir=${tokenCacheDirAbs} (mcporter 会将同套 token 写入该目录 tokens.json，并与 ~/.mcporter/credentials.json vault 组合使用)`
        );
    } else {
        logger.info('[Consensus OAuth] tokenCacheDir disabled (CONSENSUS_MCPORTER_TOKEN_CACHE_DISABLE)，仅使用 vault');
    }

    await ensureConsensusMcporterFile(absConfig, serverName, mcpUrl, oauthRedirectUrl, tokenCacheDirAbs);
    /** 无 --config 时 mcporter 按名称解析服务器，需 ~/.mcporter/mcporter.json 含 mcpServers.<serverName>（含 url/oauthRedirectUrl/tokenCacheDir） */
    if (!authUseConfig) {
        const homeMcporterJson = path.join(os.homedir(), '.mcporter', 'mcporter.json');
        await ensureConsensusMcporterFile(homeMcporterJson, serverName, mcpUrl, oauthRedirectUrl, tokenCacheDirAbs);
        logger.info(`[Consensus OAuth] mirrored server entry to mcporter home config for auth: ${homeMcporterJson}`);
    }

    stopPreviousMcporterAuth();

    /**
     * 首参数使用 mcporter.json 中的服务器名（与 `mcporter auth <server | url>` 一致），以便从配置读取 url、oauthRedirectUrl。
     * - `authUseConfig === false`（默认）：`mcporter auth <serverName> ...` 不传 --config；已同步 ~/.mcporter/mcporter.json；凭据写入 mcporter 默认位置后再合并到项目 absConfig。
     * - `authUseConfig === true`：插入 `--config` + 项目路径，凭据直接写入项目文件（旧行为）。
     */
    const args = ['auth', serverName, '--log-level', 'debug', '--oauth-timeout', String(oauthTimeoutMs)];
    if (authUseConfig) {
        args.splice(2, 0, '--config', absConfig);
    }

    const spawnEnv = { ...process.env };
    if (!authUseConfig && spawnEnv.MCPORTER_CONFIG) {
        const prev = spawnEnv.MCPORTER_CONFIG;
        delete spawnEnv.MCPORTER_CONFIG;
        logger.info(
            `[Consensus OAuth] cleared MCPORTER_CONFIG in child env (was ${prev}) so mcporter uses default OAuth file`
        );
    } else if (!authUseConfig) {
        logger.info('[Consensus OAuth] child env: MCPORTER_CONFIG unset (ok for ad-hoc auth flow)');
    }

    logger.info(
        `[Consensus OAuth] ${mcporterBin} ${args.join(' ')}` +
            (authUseConfig ? ` (--config=${absConfig})` : ' (no --config: home config mirrored, credentials merged to project after OAuth)')
    );

    const child = spawn(mcporterBin, args, {
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    activeConsensusAuthChild = child;
    logger.info(`[Consensus OAuth] mcporter auth child spawned pid=${child.pid ?? 'n/a'}`);

    let buffer = '';
    let firstChunkLogged = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const append = (chunk, streamLabel) => {
        const s = chunk.toString();
        if (streamLabel === 'stdout') stdoutBytes += s.length;
        else stderrBytes += s.length;
        buffer += s;
        if (buffer.length > BUFFER_MAX) {
            buffer = buffer.slice(-BUFFER_MAX);
        }
        if (!firstChunkLogged && buffer.length > 0) {
            firstChunkLogged = true;
            logger.info(
                `[Consensus OAuth] first output from mcporter stream=${streamLabel} chunkLen=${chunk.length} summary=${JSON.stringify(summarizeMcporterOutputBuffer(buffer))}`
            );
        }
        logger.info(
            `[Consensus OAuth] mcporter ${streamLabel} +${s.length} bytes (stdoutTotal=${stdoutBytes} stderrTotal=${stderrBytes} bufferLen=${buffer.length})`
        );
        tryLogOAuthArtifactsFromMcporterBuffer(buffer);
    };

    child.stdout.on('data', (c) => append(c, 'stdout'));
    child.stderr.on('data', (c) => append(c, 'stderr'));

    /** @type {number|null} */
    let childExitCode = null;
    child.on('exit', (code, signal) => {
        childExitCode = typeof code === 'number' ? code : -1;
        logger.info(
            `[Consensus OAuth] mcporter auth exited code=${code} signal=${signal || ''} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes} bufferLen=${buffer.length} summary=${JSON.stringify(summarizeMcporterOutputBuffer(buffer))}`
        );
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

    const waitStarted = Date.now();
    const deadline = waitStarted + urlCaptureTimeoutMs;
    let authUrlCaptured = null;
    let lastProgressLog = waitStarted;
    while (Date.now() < deadline) {
        authUrlCaptured = extractConsensusAuthorizeUrl(buffer);
        if (authUrlCaptured) break;
        // 子进程退出后 Node 会同步设置 child.exitCode；勿仅依赖 exit 事件回调里写入的变量（事件相对 await 可能滞后，曾导致空等满 urlCaptureTimeoutMs）
        if (child.exitCode !== null) {
            childExitCode = child.exitCode;
            authUrlCaptured = extractConsensusAuthorizeUrl(buffer);
            if (authUrlCaptured) break;
            logger.info(
                `[Consensus OAuth] subprocess ended exitCode=${child.exitCode} bufferLen=${buffer.length}, stop waiting (no parseable authorize URL in output)`
            );
            break;
        }
        if (isMcporterOAuthTerminalFailure(buffer)) {
            logger.info(
                `[Consensus OAuth] detected terminal failure in mcporter output (401/SSE/Failed to authorize), stop waiting`
            );
            break;
        }
        const now = Date.now();
        if (now - lastProgressLog >= 5000) {
            lastProgressLog = now;
            const elapsedSec = Math.round((now - waitStarted) / 1000);
            logger.info(
                `[Consensus OAuth] still waiting for authorize URL in mcporter output elapsed=${elapsedSec}s remaining~${Math.max(0, Math.round((deadline - now) / 1000))}s ${JSON.stringify(summarizeMcporterOutputBuffer(buffer))}`
            );
        }
        await new Promise((r) => setTimeout(r, 40));
    }

    if (!authUrlCaptured) {
        authUrlCaptured = extractConsensusAuthorizeUrl(buffer);
    }

    if (authUrlCaptured) {
        logger.info(
            `[Consensus OAuth] extracted authorize URL after ${Date.now() - waitStarted}ms urlLen=${authUrlCaptured.length} ${describeAuthorizeUrlForLog(authUrlCaptured)}`
        );
    }

    if (!authUrlCaptured) {
        try {
            child.kill('SIGTERM');
        } catch {
            /* ignore */
        }
        if (activeConsensusAuthChild === child) activeConsensusAuthChild = null;
        logger.error(`[Consensus OAuth] Log tail (truncated): ${buffer.slice(-2000)}`);
        const resolvedExit = child.exitCode !== null && child.exitCode !== undefined ? child.exitCode : childExitCode;
        if (isMcporterOAuthTerminalFailure(buffer) || (resolvedExit !== null && resolvedExit !== 0)) {
            throw new Error(
                'Consensus OAuth 失败：mcporter 在打印浏览器授权链接之前已报错（常见为 Streamable HTTP/SSE 返回 401）。' +
                    '可尝试：① 默认即不传 --config；② 在宿主机执行 `mcporter auth consensus`（或 `mcporter auth https://mcp.consensus.app/mcp`）后将 ~/.mcporter/mcporter.json 合并进项目配置；③ Docker 映射 OAuth 回调端口并确保 CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL 或 ~/.mcporter/mcporter.json 含 oauthRedirectUrl。' +
                    ` mcporterExitCode=${resolvedExit ?? 'null'}`
            );
        }
        const hint401 =
            /401|unauthorized|Non-200 status/i.test(buffer)
                ? ' 日志中出现 401：可尝试升级 mcporter（`npm i -g mcporter@latest`）、保持默认不传 --config，并确保 OAuth 回调可达运行 mcporter 的 localhost。'
                : '';
        throw new Error(
            `未在 mcporter 调试输出中解析到 Consensus 授权链接。请确认可访问 https://mcp.consensus.app/mcp 且 mcporter 版本较新。${hint401}`
        );
    }

    // 保持子进程存活以监听 redirect_uri（localhost:端口/callback），不阻塞 Node 事件循环退出计数
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
    let pollTick = 0;
    let mergeProbeLogged = false;
    activePollTimer = setInterval(async () => {
        pollTick++;
        try {
            let text = '';
            try {
                text = await fsp.readFile(absConfig, 'utf8');
            } catch {
                return;
            }
            const projectAuthed = looksLikeMcporterAuthed(text);
            if (pollTick === 1) {
                logger.info(
                    `[Consensus OAuth] poll start: intervalMs=${POLL_MS} maxMs=${POLL_MAX_MS} baselineMtimeMs=${baseline} projectFileLen=${text.length} projectLooksAuthed=${projectAuthed} authUseConfig=${authUseConfig}`
                );
            }
            if (!authUseConfig && !projectAuthed) {
                const merged = await tryMergeMcporterOAuthIntoProject(absConfig, serverName, mcpUrl);
                if (!merged && !mergeProbeLogged) {
                    mergeProbeLogged = true;
                    logger.info(
                        `[Consensus OAuth] merge: no Consensus OAuth block merged yet; will retry every ${POLL_MS}ms (checked ${JSON.stringify(getMergeCandidatePathsForLog(absConfig))})`
                    );
                }
                try {
                    text = await fsp.readFile(absConfig, 'utf8');
                } catch {
                    return;
                }
            }
            if (looksLikeMcporterAuthed(text)) {
                clearInterval(activePollTimer);
                activePollTimer = null;
                logger.info(
                    `[Consensus OAuth] Detected credentials in mcporter config after ${Date.now() - started}ms pollTicks=${pollTick} file=${absConfig}`
                );
                logConsensusMcporterJsonSecrets(`poll success ${absConfig}`, text, serverName);

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
            } else {
                const st = fs.statSync(absConfig);
                if (st.mtimeMs <= baseline && Date.now() - started < 3000) {
                    logger.info(
                        `[Consensus OAuth] poll tick=${pollTick} skip early: mtime not past baseline yet (mtimeMs=${st.mtimeMs} baseline=${baseline})`
                    );
                }
            }
        } catch (e) {
            logger.warn(`[Consensus OAuth] poll: ${e.message}`);
        }

        if (Date.now() - started > POLL_MAX_MS) {
            clearInterval(activePollTimer);
            activePollTimer = null;
            logger.info(
                `[Consensus OAuth] poll stopped after timeout ${POLL_MAX_MS}ms (pollTicks=${pollTick}) — no oauth_success broadcast`
            );
        }
    }, POLL_MS);

    logger.info(
        `[Consensus OAuth] Authorization URL captured for UI modal; child pid=${child.pid ?? 'n/a'} unref for redirect callback listener (mcporter keeps listening for ${describeAuthorizeUrlForLog(authUrlCaptured)})`
    );

    return {
        authUrl: authUrlCaptured,
        authInfo: {
            provider: 'consensus-mcp-oauth',
            mode: 'mcporter',
            mcporterConfigPath: relNorm,
            consensusMcpUrl: mcpUrl,
            oauthTimeoutMs,
            consensusMcporterAuthUseConfig: authUseConfig,
            consensusOAuthRedirectUrl: oauthRedirectUrl || undefined,
            oauthSecretsLogEnabled: isConsensusOAuthSecretsLogEnabled(),
            instructions: authUseConfig
                ? '请点击页面上的授权链接在新窗口打开并完成 Consensus 登录。授权回调由运行 mcporter 的进程监听（通常为 localhost）。若在 Docker 内启动授权，浏览器回调可能无法到达容器内回环：可在宿主机对同一份 mcporter.json 执行 `mcporter auth consensus --config <路径>` 完成登录后再挂载凭据，或使用 host 网络/端口映射。'
                : '第一步：点击「在浏览器中打开」完成 Consensus 登录（服务器端不会自动弹系统浏览器）。第二步：登录成功后，mcporter 将 OAuth 凭据写入默认配置（如 ~/.mcporter/mcporter.json），本服务会合并到项目 mcporter.json。Docker 请预先配置 CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL（或等价写入 ~/.mcporter/mcporter.json）并映射回调端口。若需凭据直接写入项目文件可设 CONSENSUS_MCPORTER_AUTH_USE_CONFIG=1（将使用 --config）。',
        },
    };
}
