// ============================================================
// output_parser.mjs —— CLI JSONL 事件流解析器（Phase 5）
//
// 支持两种 CLI 输出协议：
//   1. Codex:  codex exec --json            → JSONL
//      codex exec resume --json <id> [PROMPT]
//   2. Claude: claude -p --verbose --output-format stream-json
//
// 所有行统一解析为「规范化事件」，供会话类驱动状态机：
//   { type: 'meta'|'status'|'text'|'tool'|'done'|'error',
//     status: 'idle'|'thinking'|'running'|'waiting'|'done'|'error',
//     text?, tool?, detail?, usage?, sessionId?, raw }
//
// 非 JSON 行容错：不抛异常，返回 null 由调用方忽略/降级显示。
// ============================================================

/**
 * 规范化 Codex 事件
 * @param {object} ev 已 parse 的 JSON 行
 * @returns {object|null} 规范化事件
 */
export function parseCodexEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const type = ev.type;

    switch (type) {
        case 'thread.started': {
            return { type: 'meta', status: 'idle', sessionId: ev.thread_id, raw: ev };
        }

        case 'turn.started': {
            return { type: 'status', status: 'thinking', text: '开始思考…', raw: ev };
        }

        case 'turn.completed': {
            const usage = ev.response?.usage || ev.usage || null;
            return {
                type: 'done',
                status: 'done',
                text: extractSummary(ev.response?.output) || '完成',
                usage,
                raw: ev,
            };
        }

        case 'turn.failed': {
            const msg = ev.error?.message || ev.error || '执行失败';
            return { type: 'error', status: 'error', text: String(msg), raw: ev };
        }

        case 'item.completed': {
            const item = ev.item || {};
            return parseCodexItem(item, ev);
        }

        case 'error': {
            return { type: 'error', status: 'error', text: ev.message || 'CLI 错误', raw: ev };
        }

        case 'approval_required':
        case 'approval.needed': {
            const detail = ev.action || ev.actor?.name || '需要用户确认';
            return { type: 'status', status: 'waiting', detail: `等待确认: ${detail}`, raw: ev };
        }

        default:
            // 未知事件类型：忽略（thread.completed / session 级事件等）
            return null;
    }
}

function parseCodexItem(item, rawEv) {
    const it = item.type;
    switch (it) {
        case 'message':
        case 'agent_message': {
            // 实测 codex 0.146: item.type='agent_message', text 直接是字符串
            const text = typeof item.text === 'string' && item.text
                ? item.text
                : (typeof item.message === 'string'
                    ? item.message
                    : item.message?.content?.[0]?.text
                      || (Array.isArray(item.message?.content) ? '' : ''));
            return text
                ? { type: 'text', status: 'thinking', text: truncate(text, 300), raw: rawEv }
                : { type: 'status', status: 'thinking', raw: rawEv };
        }

        case 'tool_call': {
            return {
                type: 'tool',
                status: 'running',
                tool: item.tool_name || item.tool || 'tool',
                detail: summarizeInput(item.input),
                raw: rawEv,
            };
        }

        case 'tool_result': {
            return {
                type: 'tool',
                status: 'running',
                tool: item.tool_name || item.tool || 'tool',
                detail: truncate(typeof item.result === 'string' ? item.result : '', 160),
                raw: rawEv,
            };
        }

        case 'reasoning': {
            const text = typeof item.message === 'string' ? item.message : '';
            return text
                ? { type: 'text', status: 'thinking', text: truncate(text, 300), raw: rawEv }
                : { type: 'status', status: 'thinking', raw: rawEv };
        }

        case 'error': {
            return { type: 'error', status: 'error', text: item.message || 'Agent 报错', raw: rawEv };
        }

        default:
            return null;
    }
}

/**
 * 规范化 Claude 事件
 * @param {object} ev 已 parse 的 JSON 行
 * @returns {object|null} 规范化事件
 */
export function parseClaudeEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const type = ev.type;

    switch (type) {
        case 'system': {
            if (ev.subtype === 'init') {
                return { type: 'meta', status: 'idle', sessionId: ev.session_id, raw: ev };
            }
            return null;
        }

        case 'assistant': {
            const msg = ev.message || {};
            const content = msg.content || [];
            for (const block of content) {
                switch (block.type) {
                    case 'text': {
                        const t = (block.text || '').trim();
                        if (t) {
                            return { type: 'text', status: 'thinking', text: truncate(t, 300), raw: ev };
                        }
                        break;
                    }
                    case 'tool_use': {
                        return {
                            type: 'tool',
                            status: 'running',
                            tool: block.name || 'tool',
                            detail: summarizeInput(block.input),
                            raw: ev,
                        };
                    }
                    case 'thinking': {
                        const t = (block.thinking || '').trim();
                        if (t) {
                            return { type: 'status', status: 'thinking', detail: truncate(t, 120), raw: ev };
                        }
                        break;
                    }
                    default:
                        break;
                }
            }
            return null;
        }

        case 'user': {
            // 工具结果回显：可作 running 的 detail，非关键，直接忽略
            return null;
        }

        case 'result': {
            const isError = ev.is_error === true || ev.subtype === 'error';
            const usage = ev.usage || null;
            return {
                type: isError ? 'error' : 'done',
                status: isError ? 'error' : 'done',
                text: truncate(ev.result || '', 500) || (isError ? '执行失败' : '完成'),
                usage,
                raw: ev,
            };
        }

        default:
            return null;
    }
}

// ===================== 工具函数 =====================

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

function summarizeInput(input) {
    if (input == null) return '';
    if (typeof input === 'string') return truncate(input.replace(/\s+/g, ' '), 120);
    try {
        return truncate(JSON.stringify(input), 120);
    } catch {
        return '';
    }
}

function extractSummary(output) {
    if (!Array.isArray(output)) return '';
    for (const item of output) {
        if (item?.type === 'message' || item?.type === 'agent_message') {
            const t = typeof item.text === 'string' && item.text
                ? item.text
                : (typeof item.message === 'string'
                    ? item.message
                    : item.message?.content?.[0]?.text);
            if (t) return truncate(t, 300);
        }
    }
    return '';
}

// 便捷入口：按 provider 分发
export function parseCliLine(provider, line) {
    let ev;
    try {
        ev = JSON.parse(line);
    } catch {
        return null;   // 非 JSON 行
    }
    return provider === 'claude' ? parseClaudeEvent(ev) : parseCodexEvent(ev);
}
