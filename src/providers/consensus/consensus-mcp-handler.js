import { spawn } from 'child_process';
import * as path from 'path';
import { getRequestBody } from '../../utils/common.js';
import { MODEL_PROVIDER } from '../../utils/common.js';
import logger from '../../utils/logger.js';
import { getApiService } from '../../services/service-manager.js';
import { getMcporterExecutable } from './consensus-mcp-utils.js';
import { createApiTraceLogger } from '../../utils/api-trace-logger.js';

function createConsensusMcpTrace(method, pathName) {
    return createApiTraceLogger({
        httpRequestId: logger.getCurrentRequestId(),
        method,
        path: pathName,
        model: 'consensus-mcp',
        stream: false,
        hasTools: false,
        toolCount: 0,
        messageCount: 0,
        apiFormat: 'mcp',
        traceKind: 'mcp',
    });
}

/** MCP 协议版本（与 MCP 规范 JSON-RPC 传输一致） */
const MCP_PROTOCOL_VERSION = '2024-11-05';

function runMcporterList(bin, configPath, extraArgs = []) {
    const abs = path.isAbsolute(configPath)
        ? configPath
        : path.resolve(process.cwd(), configPath);
    const args = ['--config', abs, '--log-level', 'error', 'list', ...extraArgs, '--json'];
    logger.info(`[Consensus MCP] mcporter list bin=${bin} config=${abs} extraArgs=${JSON.stringify(extraArgs)}`);
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        logger.info(`[Consensus MCP] mcporter list pid=${proc.pid ?? 'n/a'}`);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (e) => {
            logger.info(`[Consensus MCP] mcporter list spawn error: ${e.message}`);
            reject(e);
        });
        proc.on('close', (code) => {
            const ms = Date.now() - t0;
            if (code !== 0) {
                logger.info(
                    `[Consensus MCP] mcporter list failed code=${code} durationMs=${ms} stderrPreview=${JSON.stringify(stderr.slice(0, 800))}`
                );
                reject(new Error(stderr || stdout || `mcporter list exited ${code}`));
                return;
            }
            logger.info(`[Consensus MCP] mcporter list ok durationMs=${ms} stdoutLen=${stdout.length}`);
            try {
                resolve(stdout.trim() ? JSON.parse(stdout.trim()) : {});
            } catch {
                resolve({ raw: stdout.trim() });
            }
        });
    });
}

function normalizeToolsListResult(raw) {
    if (raw == null) return { tools: [] };
    if (Array.isArray(raw)) return { tools: raw };
    if (typeof raw === 'object' && Array.isArray(raw.tools)) return raw;
    if (typeof raw === 'object' && raw.tools && typeof raw.tools === 'object') {
        return { tools: Object.values(raw.tools) };
    }
    return { tools: [] };
}

/**
 * MCP JSON-RPC 2.0：initialize / ping / tools/list / tools/call → mcporter → Consensus 官方 MCP
 * 客户端与 AIClient-2-API 之间使用标准 MCP 消息（JSON-RPC），由本服务转发至 mcporter CLI。
 */
async function handleConsensusMcpJsonRpc(body, currentConfig) {
    const rpcTag = `[Consensus MCP] JSON-RPC method=${body?.method ?? 'n/a'} id=${body?.id !== undefined ? body.id : 'n/a'}`;
    logger.info(rpcTag);
    if (body?.method === 'tools/call' && body.params?.name) {
        logger.info(`[Consensus MCP] tools/call toolName=${body.params.name} (arguments omitted)`);
    }

    // JSON-RPC 通知（无 id）：仅 notifications/* 返回 204，无响应体
    if (body && body.jsonrpc === '2.0' && body.method && !('id' in body)) {
        if (String(body.method).startsWith('notifications/')) {
            return { __http204: true };
        }
        return {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Invalid Request: missing id (non-notification requests must include id)' },
        };
    }

    const service = await getApiService(currentConfig, null, { skipUsageCount: true });
    const cfg = service.consensusApiService?.config || service.config;
    const serverName = cfg.CONSENSUS_MCP_SERVER_NAME || 'consensus';
    const id = body.id !== undefined ? body.id : null;

    if (!body.method) {
        return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: missing method' } };
    }

    if (body.method === 'initialize') {
        const clientProto = body.params?.protocolVersion || MCP_PROTOCOL_VERSION;
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: clientProto,
                capabilities: {
                    tools: {},
                    logging: {},
                },
                serverInfo: {
                    name: 'aiclient-consensus-mcp-bridge',
                    version: '1.0.0',
                    title: 'AIClient-2-API Consensus MCP (mcporter → Consensus)',
                },
            },
        };
    }

    if (body.method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
    }

    if (body.method === 'tools/list') {
        const bin = getMcporterExecutable();
        const configPath = cfg.CONSENSUS_MCPORTER_CONFIG_PATH;
        if (!configPath) {
            return { jsonrpc: '2.0', id, error: { code: -32603, message: 'CONSENSUS_MCPORTER_CONFIG_PATH missing' } };
        }
        const raw = await runMcporterList(bin, configPath, [serverName, '--schema']);
        const result = normalizeToolsListResult(raw);
        return { jsonrpc: '2.0', id, result };
    }

    if (body.method === 'tools/call') {
        const name = body.params?.name;
        const toolArgs = body.params?.arguments || {};
        if (!name) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: missing params.name' } };
        }
        const selector = String(name).includes('.') ? name : `${serverName}.${name}`;
        if (!service.callMcpTool) {
            return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Consensus adapter missing callMcpTool' } };
        }
        const raw = await service.callMcpTool(selector, toolArgs);
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        return {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{ type: 'text', text }],
            },
        };
    }

    return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${body.method}` },
    };
}

function setMcpResponseHeaders(res) {
    res.setHeader('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
}

/**
 * Consensus MCP 代理：POST /v1/mcp、/mcp（JSON-RPC MCP）；POST /v1/mcp/call；GET /v1/mcp/tools
 */
export async function handleConsensusMcpRoutes(method, pathName, req, res, currentConfig, _providerPoolManager) {
    if (currentConfig.MODEL_PROVIDER !== MODEL_PROVIDER.CONSENSUS_MCP) {
        return false;
    }

    const isMcpRoute =
        (method === 'POST' && (pathName === '/v1/mcp' || pathName === '/mcp')) ||
        (method === 'GET' && pathName === '/v1/mcp/tools') ||
        (method === 'POST' && pathName === '/v1/mcp/call');
    if (isMcpRoute) {
        logger.info(`[Consensus MCP] route hit ${method} ${pathName}`);
    }

    let trace = null;
    try {
        if (method === 'POST' && (pathName === '/v1/mcp' || pathName === '/mcp')) {
            trace = createConsensusMcpTrace(method, pathName);
            trace.startPhase('receive', 'MCP JSON-RPC');
            const body = await getRequestBody(req);
            if (body && body.jsonrpc === '2.0') {
                const rpcMethod = body.method || 'unknown';
                let toolName;
                if (rpcMethod === 'tools/call') toolName = body.params?.name;
                trace.recordMcpMeta({
                    jsonrpcMethod: rpcMethod,
                    toolName,
                    jsonrpcId: body.id,
                });
                trace.endPhase();
                trace.startPhase('upstream', 'mcporter → Consensus');
                const out = await handleConsensusMcpJsonRpc(body, currentConfig);
                trace.endPhase();
                trace.startPhase('respond', 'HTTP');
                if (out && out.__http204) {
                    trace.recordMcpMeta({
                        jsonrpcMethod: rpcMethod,
                        toolName,
                        jsonrpcId: body.id,
                        httpStatus: 204,
                    });
                    res.writeHead(204);
                    res.end();
                    trace.complete(0, 'stop');
                    return true;
                }
                const bodyStr = JSON.stringify(out);
                setMcpResponseHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(bodyStr);
                if (out && out.error) {
                    trace.recordMcpMeta({
                        jsonrpcMethod: rpcMethod,
                        toolName,
                        jsonrpcId: body.id,
                        httpStatus: 200,
                        rpcError: out.error.message || 'JSON-RPC error',
                    });
                    trace.fail(out.error.message || 'JSON-RPC error');
                } else {
                    trace.recordMcpMeta({ httpStatus: 200 });
                    trace.complete(bodyStr.length, 'stop');
                }
                return true;
            }
            trace.recordMcpMeta({ jsonrpcMethod: 'invalid-body' });
            trace.endPhase();
            trace.fail('Expected MCP JSON-RPC 2.0 body with jsonrpc, method');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: { message: 'Expected MCP JSON-RPC 2.0 body with jsonrpc, method' },
            }));
            return true;
        }

        if (method === 'GET' && pathName === '/v1/mcp/tools') {
            trace = createConsensusMcpTrace(method, pathName);
            trace.startPhase('receive', 'GET /v1/mcp/tools');
            trace.recordMcpMeta({ jsonrpcMethod: 'GET /v1/mcp/tools' });
            trace.endPhase();
            trace.startPhase('upstream', 'mcporter list --schema');
            const service = await getApiService(currentConfig, null, { skipUsageCount: true });
            const cfg = service.consensusApiService?.config || service.config;
            const bin = getMcporterExecutable();
            const configPath = cfg.CONSENSUS_MCPORTER_CONFIG_PATH;
            const serverName = cfg.CONSENSUS_MCP_SERVER_NAME || 'consensus';
            if (!configPath) {
                trace.endPhase();
                trace.fail('CONSENSUS_MCPORTER_CONFIG_PATH missing');
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'CONSENSUS_MCPORTER_CONFIG_PATH missing' } }));
                return true;
            }
            const data = await runMcporterList(bin, configPath, [serverName, '--schema']);
            trace.endPhase();
            trace.startPhase('respond', 'HTTP');
            const bodyStr = JSON.stringify(data);
            setMcpResponseHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(bodyStr);
            trace.recordMcpMeta({ httpStatus: 200 });
            trace.complete(bodyStr.length, 'stop');
            return true;
        }

        if (method === 'POST' && pathName === '/v1/mcp/call') {
            trace = createConsensusMcpTrace(method, pathName);
            trace.startPhase('receive', 'POST /v1/mcp/call');
            const body = await getRequestBody(req);
            const selector = body.selector || body.tool;
            if (!selector) {
                trace.recordMcpMeta({ jsonrpcMethod: 'POST /v1/mcp/call', rpcError: 'missing selector' });
                trace.endPhase();
                trace.fail('Missing selector or tool');
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: { message: 'Missing "selector" (e.g. consensus.search) or "tool"' },
                }));
                return true;
            }
            const args = body.args || body.arguments || {};
            trace.recordMcpMeta({ jsonrpcMethod: 'POST /v1/mcp/call', selector });
            trace.endPhase();
            trace.startPhase('upstream', 'mcporter call');
            const service = await getApiService(currentConfig, null, { skipUsageCount: true });
            if (!service.callMcpTool) {
                trace.endPhase();
                trace.fail('Consensus adapter missing callMcpTool');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Consensus adapter missing callMcpTool' } }));
                return true;
            }

            const result = await service.callMcpTool(selector, args);
            trace.endPhase();
            trace.startPhase('respond', 'HTTP');
            const bodyStr = JSON.stringify(result);
            setMcpResponseHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(bodyStr);
            trace.recordMcpMeta({ httpStatus: 200 });
            trace.complete(bodyStr.length, 'stop');
            return true;
        }
    } catch (error) {
        logger.error(`[Consensus MCP] ${error.message}`);
        if (trace) trace.fail(error.message);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
        }
        return true;
    }

    return false;
}
