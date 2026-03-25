import * as path from 'path';
import { promises as fsp } from 'fs';
import os from 'os';
import logger from '../utils/logger.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { normalizePath } from '../utils/provider-utils.js';
import { resolveConsensusTokenCacheDir } from '../providers/consensus/consensus-mcp-utils.js';
import { startConsensusNativeOAuth, cancelConsensusNativeOAuthSession } from './consensus-native-oauth-runner.js';

const DEFAULT_MCP_URL = 'https://mcp.consensus.app/mcp';
const DEFAULT_SERVER_NAME = 'consensus';
/** 等待 SDK 打印授权链接的最长时间（毫秒） */
const URL_CAPTURE_TIMEOUT_MS = 45000;

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
    const hadTokens = hadPrev && mcpServerEntryHasOAuthTokens(prev);
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
 * 单个 mcpServers 条目是否已落盘可用的 OAuth token（非仅有 auth:'oauth' 配置占位）。
 */
function mcpServerEntryHasOAuthTokens(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const directAt = entry.access_token ?? entry.accessToken;
    const directRt = entry.refresh_token ?? entry.refreshToken;
    if (typeof directAt === 'string' && directAt.trim().length > 0) return true;
    if (typeof directRt === 'string' && directRt.trim().length > 0) return true;
    const nested = entry.tokens;
    if (nested && typeof nested === 'object') {
        const a = nested.access_token ?? nested.accessToken;
        const r = nested.refresh_token ?? nested.refreshToken;
        if (typeof a === 'string' && a.trim().length > 0) return true;
        if (typeof r === 'string' && r.trim().length > 0) return true;
    }
    return false;
}

/**
 * 从已解析的 mcpServers 中选取 Consensus 相关条目（优先 serverName，其次 mcp.consensus.app URL，再选首个含 token 的条目）。
 * @param {Record<string, unknown>} servers
 * @param {string} [serverName]
 * @returns {{ entry: object|null, entrySource: string }}
 */
function pickConsensusServerEntry(servers, serverName) {
    const obj = servers && typeof servers === 'object' ? servers : {};
    if (serverName && obj[serverName] && typeof obj[serverName] === 'object') {
        return { entry: /** @type {object} */ (obj[serverName]), entrySource: `mcpServers.${serverName}` };
    }
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object' && typeof v.url === 'string' && v.url.includes('mcp.consensus.app')) {
            return { entry: /** @type {object} */ (v), entrySource: 'url contains mcp.consensus.app' };
        }
    }
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object' && mcpServerEntryHasOAuthTokens(/** @type {object} */ (v))) {
            return { entry: /** @type {object} */ (v), entrySource: 'first server entry with oauth tokens' };
        }
    }
    return { entry: null, entrySource: '' };
}

/**
 * 项目 mcporter.json 全文是否已对 Consensus 完成 OAuth（已写入 access/refresh token）。
 * 用于轮询与 oauth_success，避免仅有 auth:'oauth' 时误创建供应商账号。
 */
export function consensusMcporterJsonHasCompletedOAuth(content, serverName) {
    if (!content || typeof content !== 'string') return false;
    let data;
    try {
        data = JSON.parse(content);
    } catch {
        return false;
    }
    const { entry } = pickConsensusServerEntry(data.mcpServers || {}, serverName);
    return mcpServerEntryHasOAuthTokens(entry);
}

/**
 * 判断 JSON 文本是否表示「至少一个 mcp 服务器条目含 OAuth token」。
 * 兼容整份 mcporter.json 或单个服务器条目对象序列化。
 */
export function looksLikeMcporterAuthed(content) {
    if (!content || typeof content !== 'string') return false;
    let data;
    try {
        data = JSON.parse(content);
    } catch {
        return false;
    }
    if (data.mcpServers && typeof data.mcpServers === 'object') {
        for (const v of Object.values(data.mcpServers)) {
            if (v && typeof v === 'object' && mcpServerEntryHasOAuthTokens(v)) return true;
        }
        return false;
    }
    return mcpServerEntryHasOAuthTokens(data);
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

/**
 * `authUseConfig === false`（默认）时除项目 `mcporter.json` 外，会镜像 `mcpServers.<serverName>` 到 `~/.mcporter/mcporter.json`，便于与独立运行的 mcporter 共用同套 url/oauthRedirectUrl/tokenCacheDir。
 * `true` 时仅维护项目内配置文件路径。
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
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        logger.info(`[Consensus OAuth] merge skip: ${sourcePath} JSON parse failed: ${e.message}`);
        return false;
    }
    const servers = data.mcpServers || {};
    const serverNames = Object.keys(servers);
    const picked = pickConsensusServerEntry(servers, serverName);
    if (!picked.entry || !mcpServerEntryHasOAuthTokens(picked.entry)) {
        logger.info(
            `[Consensus OAuth] merge skip: ${sourcePath} has no Consensus mcp entry with stored access/refresh token (keys=${serverNames.join(',') || 'none'})`
        );
        return false;
    }
    const entrySource = picked.entrySource;
    const entry = { ...picked.entry };

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

/**
 * 用户取消授权 UI 或关闭弹框时调用：关闭原生 OAuth 回调 HTTP（释放 TCP 端口）与 MCP 传输。
 */
export async function cancelConsensusMcporterAuth() {
    await cancelConsensusNativeOAuthSession(logger);
    logger.info('[Consensus OAuth] cancel: native OAuth session stopped');
}

/**
 * Consensus MCP OAuth：使用 `@modelcontextprotocol/sdk` + 与 mcporter 一致的 vault/tokenCache（见 `mcporter-oauth/*`），不执行 `mcporter auth` 子进程。
 */
export async function handleConsensusOAuth(currentConfig, options = {}) {
    const relConfig =
        options.consensusMcporterConfigPath ||
        options.CONFIG_PATH ||
        'configs/consensus/mcporter.json';
    const absConfig = path.isAbsolute(relConfig)
        ? relConfig
        : path.resolve(process.cwd(), relConfig);

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
        `[Consensus OAuth] start cwd=${process.cwd()} absConfig=${absConfig} relConfig=${relConfig} mode=native-mcp-sdk serverName=${serverName} mcpUrl=${mcpUrl} oauthTimeoutMs=${oauthTimeoutMs} urlCaptureTimeoutMs=${urlCaptureTimeoutMs}`
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
            `[Consensus OAuth] fixed OAuth callback oauthRedirectUrl=${oauthRedirectUrl} (本进程监听该 URL；Docker 请映射端口，例如 -p 19876:19876)`
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
    /** `authUseConfig === false` 时镜像到 ~/.mcporter/mcporter.json，便于与独立 mcporter 共用同一条目 */
    if (!authUseConfig) {
        const homeMcporterJson = path.join(os.homedir(), '.mcporter', 'mcporter.json');
        await ensureConsensusMcporterFile(homeMcporterJson, serverName, mcpUrl, oauthRedirectUrl, tokenCacheDirAbs);
        logger.info(`[Consensus OAuth] mirrored server entry to mcporter home config: ${homeMcporterJson}`);
    }

    const relNorm = normalizePath(relConfig.replace(/\\/g, '/'));
    let consensusOAuthSuccessEmitted = false;
    /** 仅在原生 OAuth 流程内、确认 access_token 已写入 vault/tokenCache 后调用一次（见 consensus-native-oauth-runner onOAuthComplete） */
    const emitConsensusOAuthSuccessAfterPersist = async () => {
        if (consensusOAuthSuccessEmitted) return;
        consensusOAuthSuccessEmitted = true;
        try {
            logger.info(
                '[Consensus OAuth] OAuth 流程内确认：access_token 已落盘，合并项目配置并广播 oauth_success'
            );
            await tryMergeMcporterOAuthIntoProject(absConfig, serverName, mcpUrl);
            let text = '';
            try {
                text = await fsp.readFile(absConfig, 'utf8');
            } catch {
                /* ignore */
            }
            logConsensusMcporterJsonSecrets(`oauth-complete ${absConfig}`, text, serverName);
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
        } catch (e) {
            logger.warn(`[Consensus OAuth] emitConsensusOAuthSuccessAfterPersist: ${e.message}`);
        }
    };

    let nativeResult;
    try {
        nativeResult = await startConsensusNativeOAuth({
            appLogger: logger,
            serverName,
            mcpUrl,
            oauthRedirectUrl: oauthRedirectUrl || undefined,
            tokenCacheDirAbs,
            oauthTimeoutMs,
            urlCaptureTimeoutMs,
            onOAuthComplete: emitConsensusOAuthSuccessAfterPersist,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`[Consensus OAuth] native OAuth failed: ${msg}`);
        throw new Error(
            `Consensus OAuth 失败（原生 MCP SDK）：${msg}。请检查 mcpUrl、回调地址 CONSENSUS_MCPORTER_OAUTH_REDIRECT_URL、网络与 Docker 端口映射。`
        );
    }

    const { authUrl: authUrlCaptured, alreadyAuthed, flowPromise } = nativeResult;

    if (!authUrlCaptured && !alreadyAuthed) {
        throw new Error('Consensus OAuth：未获得授权链接且未处于已登录状态');
    }

    flowPromise.catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`[Consensus OAuth] background OAuth flow rejected: ${msg}`);
    });

    if (alreadyAuthed) {
        logger.info(
            '[Consensus OAuth] 已有有效 token，连接未触发浏览器授权；oauth_success 已在流程内（access_token 落盘后）发出'
        );
    }

    if (authUrlCaptured) {
        logger.info(
            `[Consensus OAuth] Authorization URL ready for UI modal ${describeAuthorizeUrlForLog(authUrlCaptured)}`
        );
    } else {
        logger.info('[Consensus OAuth] No browser URL (alreadyAuthed); UI may skip opening a new window');
    }

    return {
        authUrl: authUrlCaptured,
        alreadyAuthed,
        authInfo: {
            provider: 'consensus-mcp-oauth',
            mode: 'native-mcp-sdk',
            alreadyAuthed,
            mcporterConfigPath: relNorm,
            consensusMcpUrl: mcpUrl,
            oauthTimeoutMs,
            consensusMcporterAuthUseConfig: authUseConfig,
            consensusOAuthRedirectUrl: oauthRedirectUrl || undefined,
            oauthSecretsLogEnabled: isConsensusOAuthSecretsLogEnabled(),
            instructions: alreadyAuthed
                ? '当前 MCP 连接已具备有效 OAuth token（与 mcporter 共用 ~/.mcporter/credentials.json vault）。无需在浏览器中再次授权。'
                : authUseConfig
                  ? '请点击页面上的授权链接在新窗口完成 Consensus 登录。回调由本服务进程监听 oauthRedirectUrl（默认 localhost）。Docker 须映射回调端口到容器。'
                  : '第一步：在浏览器打开授权链接完成登录（本服务不自动打开系统浏览器）。第二步：授权成功后 token 写入 ~/.mcporter/credentials.json（及可选 tokenCacheDir），本服务在换取 access_token 并落盘后会合并到项目 mcporter.json 并更新提供商信息。',
        },
    };
}
