/**
 * 非流式响应「续写」：因 max_tokens / length 等截断时，追加 assistant + user 再请求。
 * 流式请求未实现续写（需在客户端或后续单独实现）。
 */

/**
 * 从上游原生非流式响应解析结束原因（OpenAI / Gemini / Claude 等）
 */
export function extractNativeStopReason(nativeResponse) {
    if (!nativeResponse || typeof nativeResponse !== 'object') return undefined;
    const c0 = nativeResponse.choices?.[0];
    if (c0?.finish_reason) return c0.finish_reason;
    const fr = nativeResponse.candidates?.[0]?.finishReason;
    if (fr) return fr;
    if (typeof nativeResponse.stop_reason === 'string') return nativeResponse.stop_reason;
    // OpenAI Responses / Codex：incomplete + incomplete_details.reason（如 max_output_tokens）
    if (nativeResponse.status === 'incomplete' && nativeResponse.incomplete_details?.reason) {
        return nativeResponse.incomplete_details.reason;
    }
    return undefined;
}

/**
 * 是否为「输出被长度限制截断」类结束原因（可尝试续写）
 */
export function isTruncationStopReason(reason) {
    if (reason == null || reason === '') return false;
    const raw = String(reason).trim();
    const lower = raw.toLowerCase();
    const norm = lower.replace(/-/g, '_');
    if (norm === 'length') return true;
    if (norm === 'max_tokens' || norm === 'max_output_tokens' || norm === 'model_length') return true;
    if (raw.toUpperCase() === 'MAX_TOKENS') return true;
    if (norm === 'max_output_tokens') return true;
    return false;
}

/**
 * 在上一轮 assistant 文本后追加一条 user，发起下一轮（会去掉 tools，避免重复注入）
 * @param {string} protocolPrefix getProtocolPrefix(toProvider)
 * @returns {object|null} 新请求体，不支持时返回 null
 */
export function appendContinuationRound(protocolPrefix, body, assistantRoundText, userPrompt) {
    if (!body || typeof body !== 'object' || typeof assistantRoundText !== 'string') return null;
    let next;
    try {
        next = JSON.parse(JSON.stringify(body));
    } catch {
        return null;
    }
    delete next.tools;
    delete next.tool_choice;
    delete next.functions;

    const u = typeof userPrompt === 'string' && userPrompt.trim() ? userPrompt.trim() : 'Continue';

    // OpenAI Responses / Codex：上游多为 input 数组（非 chat messages）
    if (protocolPrefix === 'openaiResponses' || protocolPrefix === 'codex') {
        const r = appendResponsesStyleInput(next, assistantRoundText, u);
        if (r) return r;
        if (protocolPrefix === 'codex' && Array.isArray(next.messages)) {
            next.messages = [
                ...next.messages,
                { role: 'assistant', content: assistantRoundText },
                { role: 'user', content: u },
            ];
            return next;
        }
        return null;
    }

    // forward-api 与 OpenAI Chat 兼容（messages + choices）
    if (protocolPrefix === 'openai' || protocolPrefix === 'grok' || protocolPrefix === 'forward') {
        if (!Array.isArray(next.messages)) return null;
        next.messages = [
            ...next.messages,
            { role: 'assistant', content: assistantRoundText },
            { role: 'user', content: u },
        ];
        return next;
    }
    if (protocolPrefix === 'claude') {
        if (!Array.isArray(next.messages)) return null;
        next.messages = [
            ...next.messages,
            { role: 'assistant', content: assistantRoundText },
            { role: 'user', content: u },
        ];
        return next;
    }
    if (protocolPrefix === 'gemini') {
        if (!Array.isArray(next.contents)) return null;
        next.contents = [
            ...next.contents,
            { role: 'model', parts: [{ text: assistantRoundText }] },
            { role: 'user', parts: [{ text: u }] },
        ];
        return next;
    }
    return null;
}

/**
 * @param {object} next 已深拷贝的请求体
 */
function appendResponsesStyleInput(next, assistantRoundText, u) {
    if (Array.isArray(next.input)) {
        next.input = [
            ...next.input,
            { role: 'assistant', content: assistantRoundText },
            { role: 'user', content: u },
        ];
        return next;
    }
    if (typeof next.input === 'string') {
        next.input = [
            { role: 'user', content: next.input },
            { role: 'assistant', content: assistantRoundText },
            { role: 'user', content: u },
        ];
        return next;
    }
    return null;
}

/**
 * 将多轮拼接后的全文写入最后一帧原生响应，便于再转换为客户端格式
 * @param {string} protocolPrefix getProtocolPrefix(toProvider)
 */
export function patchNativeMergedContent(protocolPrefix, nativeResponse, accumulatedText) {
    if (!nativeResponse || typeof nativeResponse !== 'object') return nativeResponse;
    let o;
    try {
        o = JSON.parse(JSON.stringify(nativeResponse));
    } catch {
        return nativeResponse;
    }
    if (protocolPrefix === 'openaiResponses' || protocolPrefix === 'codex') {
        if (mergeResponsesOutputMergedText(o, accumulatedText)) return o;
        if (protocolPrefix === 'codex' && o.choices?.[0]?.message) {
            o.choices[0].message.content = accumulatedText;
            return o;
        }
        return o;
    }
    if (protocolPrefix === 'openai' || protocolPrefix === 'grok' || protocolPrefix === 'forward') {
        if (o.choices?.[0]?.message) o.choices[0].message.content = accumulatedText;
        return o;
    }
    if (protocolPrefix === 'claude') {
        if (typeof o.content === 'string') {
            o.content = accumulatedText;
        } else if (Array.isArray(o.content)) {
            const tb = o.content.find((x) => x.type === 'text');
            if (tb) tb.text = accumulatedText;
            else o.content = [{ type: 'text', text: accumulatedText }];
        }
        return o;
    }
    if (protocolPrefix === 'gemini') {
        if (o.candidates?.[0]?.content) {
            o.candidates[0].content.parts = [{ text: accumulatedText }];
        }
        return o;
    }
    return nativeResponse;
}

/**
 * Responses API 非流式：output[].type===message 内 output_text
 */
function mergeResponsesOutputMergedText(o, accumulatedText) {
    const out = o.output;
    if (!Array.isArray(out)) return false;
    for (let i = out.length - 1; i >= 0; i--) {
        const item = out[i];
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
                if (c && (c.type === 'output_text' || typeof c.text === 'string')) {
                    c.type = c.type || 'output_text';
                    c.text = accumulatedText;
                    return true;
                }
            }
            item.content = [{ type: 'output_text', text: accumulatedText }];
            return true;
        }
    }
    return false;
}
