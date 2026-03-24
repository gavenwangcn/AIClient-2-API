/**
 * API 全链路追踪日志（聚合代理，SQLite 持久化）
 */
import { EventEmitter } from 'events';
import {
    initDb,
    closeDb,
    isDbInitialized,
    dbInsertRequest,
    dbGetPayload,
    dbGetSummaries,
    dbCountSummaries,
    dbGetStatusCounts,
    dbGetSummariesSince,
    dbClear,
    dbGetStats,
} from './trace-db.js';

const MAX_ENTRIES = 5000;
const MAX_REQUESTS = 200;

let logCounter = 0;
const logEntries = [];
const requestSummaries = new Map();
const requestPayloads = new Map();
const requestOrder = [];

const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

let traceConfig = {
    dbPath: './logs/aiclient2api-trace.db',
    maxDays: 30,
};

function shortId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

const TOOL_UNAVAILABLE_PATTERNS = [
    /read-only documentation tools/i,
    /documentation read tools/i,
    /only documentation.*tools/i,
    /\bi don't have (?:a |the )?(?:write|edit|bash)\b/i,
    /\bi (?:can't|cannot) (?:create|write|save|edit|modify) files? directly\b/i,
    /\bsave (?:this|it).+manually\b/i,
    /只(?:有|能用).*(?:文档|只读).*(?:工具|tool)/,
    /没有.*(?:Write|Bash|Edit).*工具/i,
    /无法直接(?:创建|写入|保存|修改|编辑)文件/,
];

const SELF_REPAIR_AFTER_CUTOFF_PATTERNS = [
    /\b(?:file|response|output).{0,40}(?:got )?cut (?:off|short)\b/i,
    /\bgot cut at line \d+\b/i,
    /\bread what was written and complete it\b/i,
    /\bappend the remaining (?:content|sections)\b/i,
    /\bcomplete the remaining\b/i,
    /文件.*(?:被截断|写到一半|没写完|写残)/,
    /(?:补上|追加)剩余(?:内容|部分|章节)/,
    /继续补全/,
];

function assessCompletionOutcome(summary, payload, stopReason) {
    const finalText = [payload.finalResponse, payload.rawResponse]
        .find((text) => typeof text === 'string' && text.trim().length > 0)
        ?.trim() || '';

    const issueTags = [];
    const reasonParts = [];

    const missingToolExecution = summary.hasTools
        && summary.toolCallsDetected === 0
        && finalText.length > 0
        && TOOL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(finalText));

    if (missingToolExecution) {
        issueTags.push('tool_unavailable');
        reasonParts.push('模型声称工具不可用，未执行实际工具调用');
    }

    const truncatedWithoutRecovery = (stopReason === 'max_tokens' || stopReason === 'length')
        && summary.continuationCount === 0;
    if (truncatedWithoutRecovery) {
        issueTags.push('truncated_output');
        reasonParts.push('响应触发 max_tokens 且未自动续写');
    }

    const selfRepairAfterCutoff = summary.hasTools
        && finalText.length > 0
        && SELF_REPAIR_AFTER_CUTOFF_PATTERNS.some((pattern) => pattern.test(finalText));
    if (selfRepairAfterCutoff) {
        issueTags.push('self_repair_after_cutoff');
        reasonParts.push('模型自述上一步输出或写入被截断，当前请求在补救补写');
    }

    if (issueTags.length > 0) {
        return {
            status: 'degraded',
            statusReason: reasonParts.join('；'),
            issueTags,
        };
    }
    return { status: 'success' };
}

function sanitizeForStorage(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((item) => sanitizeForStorage(item));
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (key === 'data' && typeof value === 'string' && value.length > 1000) {
            result[key] = `[base64 data: ${value.length} chars]`;
        } else if (key === 'source' && typeof value === 'object' && value?.type === 'base64') {
            result[key] = { type: 'base64', media_type: value.media_type, data: `[${(value.data?.length || 0)} chars]` };
        } else if (typeof value === 'object') {
            result[key] = sanitizeForStorage(value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

function extractTextParts(value) {
    if (typeof value === 'string') return value;
    if (!value) return '';
    if (Array.isArray(value)) {
        return value.map((item) => extractTextParts(item)).filter(Boolean).join('\n');
    }
    if (typeof value === 'object') {
        const record = value;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.output === 'string') return record.output;
        if (typeof record.content === 'string') return record.content;
        if (record.content !== undefined) return extractTextParts(record.content);
        if (record.input !== undefined) return extractTextParts(record.input);
    }
    return '';
}

function extractGeminiParts(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map((p) => {
        if (p.text) return p.text;
        if (p.functionCall) return JSON.stringify(p.functionCall);
        return '';
    }).filter(Boolean).join('\n');
}

/** Responses / Codex：从 input 条目中抽取文本（与 ProviderStrategy 逻辑对齐） */
function textFromResponsesInputItem(item) {
    if (!item || typeof item !== 'object') return '';
    if (typeof item.content === 'string') return item.content;
    if (Array.isArray(item.content)) {
        return item.content.map((c) => c.text || c.output_text || '').filter(Boolean).join('\n');
    }
    if (typeof item.text === 'string') return item.text;
    return '';
}

/**
 * 将 Responses 形态 input 转为与 messages 相同结构的预览行，供工具指令占用与列表展示
 */
function buildPseudoMessagesFromResponsesInput(input, instructions) {
    const MAX_MSG = 100000;
    const rows = [];
    if (typeof instructions === 'string' && instructions.length > 0) {
        const t = instructions.length > MAX_MSG ? `${instructions.substring(0, MAX_MSG)}\n... [截断]` : instructions;
        rows.push({
            role: 'system',
            contentPreview: t,
            contentLength: instructions.length,
            hasImages: false,
        });
    }
    if (typeof input === 'string') {
        const fullContent = input.length > MAX_MSG ? `${input.substring(0, MAX_MSG)}\n... [截断]` : input;
        rows.push({ role: 'user', contentPreview: fullContent, contentLength: input.length, hasImages: false });
        return rows;
    }
    if (!Array.isArray(input)) return rows;
    for (const item of input) {
        const role = item.role || 'user';
        const text = textFromResponsesInputItem(item);
        const fullContent = text.length > MAX_MSG ? `${text.substring(0, MAX_MSG)}\n... [截断]` : text;
        rows.push({ role: role || 'user', contentPreview: fullContent, contentLength: text.length, hasImages: false });
    }
    return rows;
}

export function countMessagesInBody(body) {
    if (!body || typeof body !== 'object') return 0;
    if (Array.isArray(body.messages)) return body.messages.length;
    if (Array.isArray(body.contents)) return body.contents.length;
    if (typeof body.input === 'string') return 1;
    if (Array.isArray(body.input)) return body.input.length;
    return 0;
}

export function countToolsInBody(body) {
    if (!body || typeof body !== 'object') return 0;
    let n = 0;
    if (Array.isArray(body.tools)) n += body.tools.length;
    // OpenAI 旧版 function_call
    if (Array.isArray(body.functions)) n += body.functions.length;
    return n;
}

function persistRequest(summary, payload) {
    try {
        dbInsertRequest(summary, payload);
    } catch (e) {
        console.warn('[ApiTrace] SQLite 写入失败:', e.message);
    }
}

/**
 * @param {object} config - CONFIG
 */
export function initApiTraceLogger(config) {
    traceConfig = {
        dbPath: config.TRACE_LOG_DB_PATH || './logs/aiclient2api-trace.db',
        maxDays: config.TRACE_LOG_MAX_DAYS ?? 30,
    };
    try {
        initDb(traceConfig.dbPath);
        loadLogsFromDb();
    } catch (e) {
        console.warn('[ApiTrace] SQLite 初始化失败，追踪仅内存:', e.message);
    }
}

export function loadLogsFromDb() {
    if (!isDbInitialized()) return;
    try {
        const cutoff = Date.now() - traceConfig.maxDays * 86400000;
        const summaries = dbGetSummariesSince(cutoff);
        let dbLoaded = 0;
        for (const s of summaries) {
            if (!requestSummaries.has(s.requestId)) {
                requestSummaries.set(s.requestId, s);
                requestOrder.push(s.requestId);
                dbLoaded++;
            }
        }
        while (requestOrder.length > MAX_REQUESTS) {
            const oldId = requestOrder.shift();
            requestSummaries.delete(oldId);
            requestPayloads.delete(oldId);
        }
        if (dbLoaded > 0) {
            console.log(`[ApiTrace] 从 SQLite 加载 ${dbLoaded} 条历史摘要`);
        }
    } catch (e) {
        console.warn('[ApiTrace] 从 SQLite 加载失败:', e.message);
    }
}

export function clearAllLogs() {
    const count = requestSummaries.size;
    logEntries.length = 0;
    requestSummaries.clear();
    requestPayloads.clear();
    requestOrder.length = 0;
    logCounter = 0;
    if (isDbInitialized()) {
        try {
            dbClear();
        } catch { /* ignore */ }
    }
    return { cleared: count };
}

export function getStats() {
    let success = 0;
    let degraded = 0;
    let error = 0;
    let intercepted = 0;
    let processing = 0;
    let totalTime = 0;
    let timeCount = 0;
    let totalTTFT = 0;
    let ttftCount = 0;
    for (const s of requestSummaries.values()) {
        if (s.status === 'success') success++;
        else if (s.status === 'degraded') degraded++;
        else if (s.status === 'error') error++;
        else if (s.status === 'intercepted') intercepted++;
        else if (s.status === 'processing') processing++;
        if (s.endTime) {
            totalTime += s.endTime - s.startTime;
            timeCount++;
        }
        if (s.ttft) {
            totalTTFT += s.ttft;
            ttftCount++;
        }
    }
    return {
        totalRequests: requestSummaries.size,
        successCount: success,
        degradedCount: degraded,
        errorCount: error,
        interceptedCount: intercepted,
        processingCount: processing,
        avgResponseTime: timeCount > 0 ? Math.round(totalTime / timeCount) : 0,
        avgTTFT: ttftCount > 0 ? Math.round(totalTTFT / ttftCount) : 0,
        totalLogEntries: logEntries.length,
    };
}

export function getVueStats(since) {
    if (isDbInitialized()) {
        try {
            return { ...dbGetStats(since), totalLogEntries: logEntries.length };
        } catch (e) {
            console.warn('[ApiTrace] dbGetStats 失败:', e.message);
        }
    }
    return getStats();
}

export function getAllLogs(opts = {}) {
    let result = logEntries;
    if (opts.requestId) result = result.filter((e) => e.requestId === opts.requestId);
    if (opts.level) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        const minLevel = levels[opts.level];
        result = result.filter((e) => levels[e.level] >= minLevel);
    }
    if (opts.source) result = result.filter((e) => e.source === opts.source);
    if (opts.since) result = result.filter((e) => e.timestamp > opts.since);
    if (opts.limit) result = result.slice(-opts.limit);
    return result;
}

export function getRequestSummaries(limit) {
    const ids = limit ? requestOrder.slice(-limit) : requestOrder;
    return ids.map((id) => requestSummaries.get(id)).filter(Boolean).reverse();
}

export function getRequestPayload(requestId) {
    const cached = requestPayloads.get(requestId);
    if (cached) return cached;
    if (isDbInitialized()) {
        try {
            return dbGetPayload(requestId);
        } catch { /* ignore */ }
    }
    return undefined;
}

export function getRequestSummariesPage(opts) {
    const { limit, before, status, keyword, since } = opts;
    if (isDbInitialized()) {
        try {
            const summaries = dbGetSummaries({ limit: limit + 1, before, status, keyword, since });
            const hasMore = summaries.length > limit;
            return {
                summaries: hasMore ? summaries.slice(0, limit) : summaries,
                hasMore,
                total: dbCountSummaries({ since, status, keyword }),
                statusCounts: dbGetStatusCounts({ keyword, since }),
            };
        } catch (e) {
            console.warn('[ApiTrace] SQLite 分页失败:', e.message);
        }
    }
    let allUnfiltered = requestOrder.slice().reverse();
    if (since !== undefined) {
        allUnfiltered = allUnfiltered.filter((id) => (requestSummaries.get(id)?.startTime ?? 0) >= since);
    }
    if (keyword) {
        const kw = keyword.toLowerCase();
        allUnfiltered = allUnfiltered.filter((id) => {
            const s = requestSummaries.get(id);
            return s && (
                s.requestId.toLowerCase().includes(kw)
                || s.model.toLowerCase().includes(kw)
                || (s.title ?? '').toLowerCase().includes(kw)
            );
        });
    }
    const statusCounts = {
        all: allUnfiltered.length, success: 0, degraded: 0, error: 0, processing: 0, intercepted: 0,
    };
    for (const id of allUnfiltered) {
        const s = requestSummaries.get(id);
        if (s?.status) statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
    }
    let all = status ? allUnfiltered.filter((id) => requestSummaries.get(id)?.status === status) : allUnfiltered;
    const startIdx = before !== undefined
        ? all.findIndex((id) => (requestSummaries.get(id)?.startTime ?? Infinity) < before)
        : 0;
    const slice = startIdx >= 0 ? all.slice(startIdx, startIdx + limit + 1) : [];
    const hasMore = slice.length > limit;
    return {
        summaries: slice.slice(0, limit).map((id) => requestSummaries.get(id)).filter(Boolean),
        hasMore,
        total: all.length,
        statusCounts,
    };
}

export function subscribeToLogs(listener) {
    logEmitter.on('log', listener);
    return () => logEmitter.off('log', listener);
}

export function subscribeToSummaries(listener) {
    logEmitter.on('summary', listener);
    return () => logEmitter.off('summary', listener);
}

function addEntry(entry) {
    logEntries.push(entry);
    while (logEntries.length > MAX_ENTRIES) logEntries.shift();
    logEmitter.emit('log', entry);
}

/**
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.path
 * @param {string} opts.model
 * @param {boolean} opts.stream
 * @param {boolean} opts.hasTools
 * @param {number} opts.toolCount
 * @param {number} opts.messageCount
 * @param {'anthropic'|'openai'|'responses'|'gemini'} opts.apiFormat
 * @param {string} [opts.httpRequestId]
 */
export function createApiTraceLogger(opts) {
    const requestId = shortId();
    const summary = {
        requestId,
        startTime: Date.now(),
        method: opts.method,
        path: opts.path,
        model: opts.model,
        stream: opts.stream,
        apiFormat: opts.apiFormat || 'openai',
        hasTools: opts.hasTools,
        toolCount: opts.toolCount,
        messageCount: opts.messageCount,
        status: 'processing',
        responseChars: 0,
        retryCount: 0,
        continuationCount: 0,
        toolCallsDetected: 0,
        phaseTimings: [],
        thinkingChars: 0,
        systemPromptLength: opts.systemPromptLength || 0,
    };
    if (opts.httpRequestId) summary.httpRequestId = opts.httpRequestId;

    const payload = {};
    requestSummaries.set(requestId, summary);
    requestPayloads.set(requestId, payload);
    requestOrder.push(requestId);
    while (requestOrder.length > MAX_REQUESTS) {
        const oldId = requestOrder.shift();
        requestSummaries.delete(oldId);
        requestPayloads.delete(oldId);
    }

    return new RequestLogger(requestId, summary, payload);
}

export class RequestLogger {
    constructor(requestId, summary, payload) {
        this.requestId = requestId;
        this._summary = summary;
        this._payload = payload;
        this._activePhase = null;
        this._ttftRecorded = false;
    }

    _log(level, source, phase, message, details) {
        logCounter += 1;
        addEntry({
            id: `log_${logCounter}`,
            requestId: this.requestId,
            timestamp: Date.now(),
            level,
            source,
            phase,
            message,
            details,
            duration: Date.now() - this._summary.startTime,
        });
    }

    startPhase(phase, label) {
        if (this._activePhase && !this._activePhase.endTime) {
            this._activePhase.endTime = Date.now();
            this._activePhase.duration = this._activePhase.endTime - this._activePhase.startTime;
        }
        const t = { phase, label, startTime: Date.now() };
        this._activePhase = t;
        this._summary.phaseTimings.push(t);
    }

    endPhase() {
        if (this._activePhase && !this._activePhase.endTime) {
            this._activePhase.endTime = Date.now();
            this._activePhase.duration = this._activePhase.endTime - this._activePhase.startTime;
        }
    }

    debug(source, phase, message, details) { this._log('debug', source, phase, message, details); }
    info(source, phase, message, details) { this._log('info', source, phase, message, details); }
    warn(source, phase, message, details) {
        this._log('warn', source, phase, message, details);
        console.log(`\x1b[33m⚠\x1b[0m [${this.requestId}] ${message}`);
    }
    error(source, phase, message, details) {
        this._log('error', source, phase, message, details);
        console.error(`\x1b[31m✗\x1b[0m [${this.requestId}] ${message}`);
    }

    isProcessing() {
        return this._summary.status === 'processing';
    }

    recordTTFT() {
        if (this._ttftRecorded) return;
        this._ttftRecorded = true;
        this._summary.ttft = Date.now() - this._summary.startTime;
    }

    recordUpstreamApiTime(startTime) {
        this._summary.cursorApiTime = Date.now() - startTime;
    }

    updateSummary(updates) {
        Object.assign(this._summary, updates);
        logEmitter.emit('summary', this._summary);
    }

    recordOriginalRequest(body) {
        if (typeof body.system === 'string') {
            this._payload.systemPrompt = body.system;
        } else if (Array.isArray(body.system)) {
            this._payload.systemPrompt = body.system.map((b) => b.text || '').join('\n');
        }
        if (Array.isArray(body.messages)) {
            const MAX_MSG = 100000;
            this._payload.messages = body.messages.map((m) => {
                let fullContent = '';
                let contentLength = 0;
                let hasImages = false;
                if (typeof m.content === 'string') {
                    fullContent = m.content.length > MAX_MSG ? `${m.content.substring(0, MAX_MSG)}\n... [截断]` : m.content;
                    contentLength = m.content.length;
                } else if (Array.isArray(m.content)) {
                    const textParts = m.content.filter((c) => c.type === 'text');
                    const imageParts = m.content.filter((c) => c.type === 'image' || c.type === 'image_url' || c.type === 'input_image');
                    hasImages = imageParts.length > 0;
                    const text = textParts.map((c) => c.text || '').join('\n');
                    fullContent = text.length > MAX_MSG ? `${text.substring(0, MAX_MSG)}\n... [截断]` : text;
                    contentLength = text.length;
                    if (hasImages) fullContent += `\n[+${imageParts.length} images]`;
                } else if (m.content && typeof m.content === 'object') {
                    const text = extractTextParts(m.content);
                    fullContent = text.length > MAX_MSG ? `${text.substring(0, MAX_MSG)}\n... [截断]` : text;
                    contentLength = text.length;
                }
                return { role: m.role, contentPreview: fullContent, contentLength, hasImages };
            });
            const userMsgs = body.messages.filter((m) => m.role === 'user');
            if (userMsgs.length > 0) {
                const lastUser = userMsgs[userMsgs.length - 1];
                let text = '';
                if (typeof lastUser.content === 'string') {
                    text = lastUser.content;
                } else if (Array.isArray(lastUser.content)) {
                    text = lastUser.content
                        .filter((c) => c.type === 'text')
                        .map((c) => c.text || '')
                        .join(' ');
                }
                text = text.replace(/<[a-zA-Z_-]+>[\s\S]*?<\/[a-zA-Z_-]+>/gi, '');
                text = text.replace(/First,\s*think\s+step\s+by\s+step[\s\S]*$/i, '');
                text = text.replace(/Respond with the appropriate action[\s\S]*$/i, '');
                text = text.replace(/\s+/g, ' ').trim();
                this._summary.title = text.length > 80 ? `${text.substring(0, 77)}...` : text;
            }
        }
        if (Array.isArray(body.tools)) {
            this._payload.tools = body.tools.map((t) => ({
                name: t.name || t.function?.name || 'unknown',
                description: t.description || t.function?.description || '',
            }));
        } else if (Array.isArray(body.functions)) {
            this._payload.tools = body.functions.map((f) => ({
                name: f.name || 'unknown',
                description: f.description || '',
            }));
        }
        if (!this._payload.messages && Array.isArray(body.contents)) {
            const MAX_MSG = 100000;
            this._payload.messages = body.contents.map((c) => {
                const text = extractGeminiParts(c.parts);
                const fullContent = text.length > MAX_MSG ? `${text.substring(0, MAX_MSG)}\n... [截断]` : text;
                return { role: c.role || 'user', contentPreview: fullContent, contentLength: text.length };
            });
            const userBlocks = [...body.contents].filter((c) => c.role === 'user');
            if (userBlocks.length > 0) {
                const text = extractGeminiParts(userBlocks[userBlocks.length - 1].parts);
                const t = text.replace(/\s+/g, ' ').trim();
                this._summary.title = t.length > 80 ? `${t.substring(0, 77)}...` : t;
            }
        }
        // OpenAI Responses / Codex：客户端或上游使用 input 而非 messages
        if (!this._payload.messages && body.input !== undefined) {
            this._payload.messages = buildPseudoMessagesFromResponsesInput(body.input, body.instructions);
            const userRows = this._payload.messages.filter((m) => m.role === 'user');
            if (userRows.length > 0) {
                const last = userRows[userRows.length - 1];
                let t = last.contentPreview || '';
                t = t.replace(/\s+/g, ' ').trim();
                if (t.length > 0) {
                    this._summary.title = t.length > 80 ? `${t.substring(0, 77)}...` : t;
                }
            }
        }
        this._payload.originalRequest = sanitizeForStorage(body);
    }

    /** 记录发给上游提供商的请求体（转换后 upstream 请求快照） */
    recordUpstreamRequest(body, toProvider) {
        const msgs = [];
        if (Array.isArray(body.messages)) {
            for (const m of body.messages) {
                const text = extractTextParts(m.content);
                msgs.push({
                    role: m.role || 'user',
                    contentPreview: text.length > 100000 ? `${text.slice(0, 100000)}\n... [截断]` : text,
                    contentLength: text.length,
                });
            }
        } else if (Array.isArray(body.contents)) {
            for (const c of body.contents) {
                const text = extractGeminiParts(c.parts);
                msgs.push({
                    role: c.role || 'user',
                    contentPreview: text.length > 100000 ? `${text.slice(0, 100000)}\n... [截断]` : text,
                    contentLength: text.length,
                });
            }
        } else if (body.input !== undefined) {
            const pseudo = buildPseudoMessagesFromResponsesInput(body.input, body.instructions);
            for (const m of pseudo) {
                msgs.push({
                    role: m.role || 'user',
                    contentPreview: m.contentPreview,
                    contentLength: m.contentLength,
                });
            }
        }
        if (msgs.length) {
            this._payload.cursorMessages = msgs;
        }
        let totalChars = 0;
        for (const m of msgs) totalChars += m.contentLength;
        this._payload.cursorRequest = {
            model: body.model,
            toProvider: toProvider || undefined,
            messageCount: msgs.length || countMessagesInBody(body),
            totalChars,
            endpoint: body.endpoint,
        };
        this._payload.upstreamRequest = sanitizeForStorage(body);
    }

    recordRawResponse(text) {
        this._payload.rawResponse = text;
    }

    recordFinalResponse(text) {
        this._payload.finalResponse = text;
    }

    recordThinking(content) {
        this._payload.thinkingContent = content;
        this._summary.thinkingChars = content.length;
    }

    recordToolCalls(calls) {
        this._payload.toolCalls = calls;
    }

    complete(responseChars, stopReason) {
        if (this._summary.status !== 'processing') return;
        this.endPhase();
        // 展示与落库用有效停止原因：未解析到时，有输出则视为正常结束 stop
        const effectiveStop = stopReason !== undefined && stopReason !== null && stopReason !== ''
            ? stopReason
            : (responseChars > 0 ? 'stop' : undefined);
        const assessment = assessCompletionOutcome(this._summary, this._payload, effectiveStop);
        this._summary.endTime = Date.now();
        this._summary.status = assessment.status;
        this._summary.statusReason = assessment.statusReason;
        this._summary.issueTags = assessment.issueTags;
        this._summary.responseChars = responseChars;
        this._summary.stopReason = effectiveStop;
        const duration = this._summary.endTime - this._summary.startTime;
        const stopLabel = effectiveStop !== undefined ? effectiveStop : 'n/a';
        const completionMessage = assessment.status === 'degraded'
            ? `降级完成 (${duration}ms, ${responseChars} chars, stop=${stopLabel})${assessment.statusReason ? ` - ${assessment.statusReason}` : ''}`
            : `完成 (${duration}ms, ${responseChars} chars, stop=${stopLabel})`;
        this._log(assessment.status === 'degraded' ? 'warn' : 'info', 'System', 'complete', completionMessage);
        logEmitter.emit('summary', this._summary);
        persistRequest(this._summary, this._payload);
    }

    fail(errorMessage) {
        if (this._summary.status !== 'processing') return;
        this.endPhase();
        this._summary.status = 'error';
        this._summary.endTime = Date.now();
        this._summary.error = errorMessage;
        this._log('error', 'System', 'error', errorMessage);
        logEmitter.emit('summary', this._summary);
        persistRequest(this._summary, this._payload);
    }

    intercepted(reason) {
        this._summary.status = 'intercepted';
        this._summary.endTime = Date.now();
        this._log('info', 'System', 'intercept', reason);
        logEmitter.emit('summary', this._summary);
        persistRequest(this._summary, this._payload);
    }
}

export { closeDb as closeTraceDb };
