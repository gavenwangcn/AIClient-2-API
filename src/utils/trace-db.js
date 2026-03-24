/**
 * SQLite 持久化层（与 cursor2api logger-db 对齐）
 */
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

let db = null;

export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

export function initDb(dbPath) {
    closeDb();
    const dir = dirname(dbPath);
    if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS requests (
            request_id   TEXT PRIMARY KEY,
            timestamp    INTEGER NOT NULL,
            summary_json TEXT NOT NULL,
            payload_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_timestamp ON requests(timestamp);
    `);
}

function getDb() {
    if (!db) throw new Error('SQLite trace DB not initialized. Call initDb() first.');
    return db;
}

export function dbInsertRequest(summary, payload) {
    const stmt = getDb().prepare(
        'INSERT OR REPLACE INTO requests (request_id, timestamp, summary_json, payload_json) VALUES (?, ?, ?, ?)'
    );
    stmt.run(
        summary.requestId,
        summary.startTime,
        JSON.stringify(summary),
        JSON.stringify(payload)
    );
}

export function dbGetPayload(requestId) {
    const row = getDb()
        .prepare('SELECT payload_json FROM requests WHERE request_id = ?')
        .get(requestId);
    if (!row?.payload_json) return undefined;
    try {
        return JSON.parse(row.payload_json);
    } catch {
        return undefined;
    }
}

function buildWhere(opts) {
    const conditions = [];
    const params = {};
    if (opts.before !== undefined) {
        conditions.push('timestamp < :before');
        params.before = opts.before;
    }
    if (opts.since !== undefined) {
        conditions.push('timestamp >= :since');
        params.since = opts.since;
    }
    if (opts.status) {
        conditions.push("json_extract(summary_json,'$.status') = :status");
        params.status = opts.status;
    }
    if (opts.keyword) {
        conditions.push("(request_id LIKE :kw OR json_extract(summary_json,'$.title') LIKE :kw OR json_extract(summary_json,'$.model') LIKE :kw)");
        params.kw = `%${opts.keyword}%`;
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params };
}

export function dbGetSummaries(opts) {
    const { limit, ...filterOpts } = opts;
    const { where, params } = buildWhere(filterOpts);
    const sql = `SELECT summary_json FROM requests ${where} ORDER BY timestamp DESC LIMIT :limit`;
    const rows = getDb().prepare(sql).all({ ...params, limit });
    return rows.map((r) => {
        try {
            return JSON.parse(r.summary_json);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

export function dbCountSummaries(opts = {}) {
    const { where, params } = buildWhere(opts);
    const sql = `SELECT COUNT(*) as cnt FROM requests ${where}`;
    const row = getDb().prepare(sql).get(params);
    return row.cnt;
}

export function dbGetStatusCounts(opts = {}) {
    const { where, params } = buildWhere(opts);
    const sql = `SELECT json_extract(summary_json,'$.status') as status, COUNT(*) as cnt FROM requests ${where} GROUP BY status`;
    const rows = getDb().prepare(sql).all(params);
    const counts = { all: 0, success: 0, degraded: 0, error: 0, processing: 0, intercepted: 0 };
    for (const row of rows) {
        if (row.status) counts[row.status] = row.cnt;
        counts.all += row.cnt;
    }
    return counts;
}

export function dbGetSummariesSince(cutoffTimestamp) {
    const rows = getDb()
        .prepare('SELECT summary_json FROM requests WHERE timestamp >= ? ORDER BY timestamp ASC')
        .all(cutoffTimestamp);
    return rows.map((r) => {
        try {
            return JSON.parse(r.summary_json);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

export function dbGetStats(since) {
    const where = since !== undefined ? 'WHERE timestamp >= ?' : '';
    const params = since !== undefined ? [since] : [];
    const row = getDb().prepare(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN json_extract(summary_json,'$.status')='success'     THEN 1 ELSE 0 END) as success,
            SUM(CASE WHEN json_extract(summary_json,'$.status')='degraded'    THEN 1 ELSE 0 END) as degraded,
            SUM(CASE WHEN json_extract(summary_json,'$.status')='error'       THEN 1 ELSE 0 END) as error,
            SUM(CASE WHEN json_extract(summary_json,'$.status')='intercepted' THEN 1 ELSE 0 END) as intercepted,
            SUM(CASE WHEN json_extract(summary_json,'$.status')='processing'  THEN 1 ELSE 0 END) as processing,
            AVG(CASE WHEN json_extract(summary_json,'$.endTime') IS NOT NULL
                THEN json_extract(summary_json,'$.endTime') - timestamp END) as avgTime,
            AVG(CASE WHEN json_extract(summary_json,'$.ttft') IS NOT NULL
                THEN json_extract(summary_json,'$.ttft') END) as avgTTFT
        FROM requests ${where}
    `).get(...params);
    return {
        totalRequests: row.total ?? 0,
        successCount: row.success ?? 0,
        degradedCount: row.degraded ?? 0,
        errorCount: row.error ?? 0,
        interceptedCount: row.intercepted ?? 0,
        processingCount: row.processing ?? 0,
        avgResponseTime: row.avgTime != null ? Math.round(row.avgTime) : 0,
        avgTTFT: row.avgTTFT != null ? Math.round(row.avgTTFT) : 0,
    };
}

export function dbClear() {
    getDb().prepare('DELETE FROM requests').run();
}

export function isDbInitialized() {
    return db !== null;
}
