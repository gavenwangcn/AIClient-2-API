/**
 * 全链路日志 HTTP 路由（聚合代理日志视图）
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import {
    getAllLogs,
    getRequestSummaries,
    getStats,
    getVueStats,
    getRequestPayload,
    subscribeToLogs,
    subscribeToSummaries,
    clearAllLogs,
    getRequestSummariesPage,
} from '../utils/api-trace-logger.js';

const TRACE_DIR = path.join(process.cwd(), 'static', 'trace-logs');

function getSearchParams(req) {
    try {
        return new URL(req.url || '/', 'http://localhost').searchParams;
    } catch {
        return new URLSearchParams();
    }
}

function getToken(req) {
    const q = getSearchParams(req).get('token');
    if (q) return q;
    const auth = req.headers.authorization || req.headers['x-api-key'];
    if (!auth) return undefined;
    return String(auth).replace(/^Bearer\s+/i, '').trim();
}

/** 与 REQUIRED_API_KEY 一致；未配置或空字符串则不要求鉴权 */
export function traceAuthOk(req, config) {
    const key = config.REQUIRED_API_KEY;
    if (key === undefined || key === null || key === '') return true;
    const token = getToken(req);
    return !!token && token === key;
}

function json(res, status, obj) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(obj));
}

function readTraceFile(name) {
    const p = path.join(TRACE_DIR, name);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
}

/**
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handleTraceLogRequest(method, pathnameFull, req, res, config) {
    const pathname = pathnameFull.split('?')[0];

    if (method === 'GET' && pathname === '/logs') {
        if (!traceAuthOk(req, config)) {
            const html = readTraceFile('trace-login.html');
            if (html) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(html);
            } else {
                json(res, 401, { error: { message: 'Unauthorized', type: 'auth_error' } });
            }
            return true;
        }
        const html = readTraceFile('logs.html');
        if (!html) {
            json(res, 500, { error: { message: 'Trace logs UI missing', type: 'server_error' } });
            return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return true;
    }

    const isTraceApi = pathname === '/api/logs'
        || pathname === '/api/requests'
        || pathname === '/api/requests/more'
        || pathname === '/api/stats'
        || pathname === '/api/vue/stats'
        || pathname === '/api/logs/stream'
        || pathname === '/api/logs/clear'
        || /^\/api\/payload\//.test(pathname);

    if (!isTraceApi) return false;

    if (!traceAuthOk(req, config)) {
        json(res, 401, { error: { message: 'Unauthorized. Provide token via ?token=xxx or Authorization header.', type: 'auth_error' } });
        return true;
    }

    const sp = getSearchParams(req);

    if (method === 'GET' && pathname === '/api/logs') {
        const requestId = sp.get('requestId') || undefined;
        const level = sp.get('level') || undefined;
        const source = sp.get('source') || undefined;
        const limit = sp.get('limit') ? parseInt(sp.get('limit'), 10) : 200;
        const since = sp.get('since') ? parseInt(sp.get('since'), 10) : undefined;
        json(res, 200, getAllLogs({ requestId, level, source, limit, since }));
        return true;
    }

    if (method === 'GET' && pathname === '/api/requests') {
        const limit = sp.get('limit') ? parseInt(sp.get('limit'), 10) : 50;
        json(res, 200, getRequestSummaries(limit));
        return true;
    }

    if (method === 'GET' && pathname === '/api/requests/more') {
        const limit = sp.get('limit') ? parseInt(sp.get('limit'), 10) : 50;
        const before = sp.get('before') ? parseInt(sp.get('before'), 10) : undefined;
        const since = sp.get('since') ? parseInt(sp.get('since'), 10) : undefined;
        const status = sp.get('status') || undefined;
        const keyword = sp.get('keyword') || undefined;
        json(res, 200, getRequestSummariesPage({ limit, before, since, status, keyword }));
        return true;
    }

    if (method === 'GET' && pathname === '/api/stats') {
        json(res, 200, getStats());
        return true;
    }

    if (method === 'GET' && pathname === '/api/vue/stats') {
        const since = sp.get('since') ? parseInt(sp.get('since'), 10) : undefined;
        json(res, 200, getVueStats(since));
        return true;
    }

    const payloadMatch = pathname.match(/^\/api\/payload\/(.+)$/);
    if (method === 'GET' && payloadMatch) {
        const requestId = decodeURIComponent(payloadMatch[1]);
        const payload = getRequestPayload(requestId);
        if (!payload) {
            json(res, 404, { error: 'Not found' });
            return true;
        }
        json(res, 200, payload);
        return true;
    }

    if (method === 'POST' && pathname === '/api/logs/clear') {
        const result = clearAllLogs();
        json(res, 200, { success: true, ...result });
        return true;
    }

    if (method === 'GET' && pathname === '/api/logs/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });
        const sse = (event, data) => `event: ${event}\ndata: ${data}\n\n`;
        try {
            res.write(sse('stats', JSON.stringify(getStats())));
        } catch { /* ignore */ }
        const unsubLog = subscribeToLogs((e) => {
            try {
                res.write(sse('log', JSON.stringify(e)));
            } catch { /* ignore */ }
        });
        const unsubSummary = subscribeToSummaries((s) => {
            try {
                res.write(sse('summary', JSON.stringify(s)));
                res.write(sse('stats', JSON.stringify(getStats())));
            } catch { /* ignore */ }
        });
        const hb = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            } catch { /* ignore */ }
        }, 15000);
        req.on('close', () => {
            unsubLog();
            unsubSummary();
            clearInterval(hb);
        });
        return true;
    }

    return false;
}
