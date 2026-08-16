// ============================================================
// mock_session.mjs —— 模拟 Agent 会话（Phase 5）
//
// 用途：在 CLI 模型不可用 / 不想消耗 token 时，验证
// 「语音确认 → 会话托管 → 状态推送」完整链路。
// 模拟与真实会话相同的状态机与事件：
//   thinking(提交) → running(工具1) → running(工具2) → done
// 支持自定义回复（模拟 Codex 编写 hello world 的验收场景）。
// ============================================================
import { EventEmitter } from 'events';

export class MockSession extends EventEmitter {
    constructor(options) {
        super();
        this.agentId = options.agentId;
        this.name = options.name || `Agent ${options.agentId}`;
        this.cwd = options.cwd || process.cwd();
        this.replyTemplate = options.replyTemplate || '';

        this.status = 'idle';
        this.lastText = '';
        this.lastTool = '';
        this.lastDetail = '';
        this.usage = { input_tokens: 0, output_tokens: 0 };
        this.recent = [];
        this.startedAt = null;
        this.finishedAt = null;
        this._timer = null;
    }

    get state() {
        return {
            agentId: this.agentId,
            name: this.name,
            type: 'mock',
            status: this.status,
            lastText: this.lastText,
            lastTool: this.lastTool,
            lastDetail: this.lastDetail,
            usage: this.usage,
            recent: [...this.recent],
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
        };
    }

    sendPrompt(text) {
        if (this.status === 'running' || this.status === 'thinking') {
            return Promise.resolve(this.emitError('会话忙，请稍后再试'));
        }
        const prompt = (text || '').trim();
        this._setStatus('thinking', { text: '提交指令…', detail: truncate(prompt, 80) });
        this._pushRecent('user', truncate(prompt, 80));
        this.startedAt = Date.now();

        // 模拟时序：thinking 1s → tool_call 1.2s → tool_result → done
        const steps = [
            { delay: 1000, fn: () => this._setStatus('running', { tool: 'shell', detail: '正在执行指令…' }) },
            { delay: 1200, fn: () => this._setStatus('running', { tool: 'file', detail: '写入输出文件…' }) },
            {
                delay: 1000,
                fn: () => {
                    const reply = this.replyTemplate
                        ? this.replyTemplate.replaceAll('{prompt}', prompt)
                        : `[mock] 收到指令: "${truncate(prompt, 60)}"。\n（这是模拟会话的输出。接入真实 CLI 后这里显示 Codex/Claude 的实际结果。）`;
                    this.usage = { input_tokens: 1200, output_tokens: 240 };
                    this._setStatus('done', { text: reply });
                    this._pushRecent('agent', reply);
                },
            },
        ];
        this._timer = setTimeout(() => runSteps(steps, () => { this.finishedAt = Date.now(); }), 0);

        return Promise.resolve();
    }

    kill() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        if (this.status === 'running' || this.status === 'thinking') {
            this._setStatus('error', { text: '会话已终止' });
        }
    }

    _setStatus(status, extra = {}) {
        this.status = status;
        if (extra.text !== undefined) this.lastText = extra.text;
        if (extra.tool !== undefined) this.lastTool = extra.tool;
        if (extra.detail !== undefined) this.lastDetail = extra.detail;
        this.emit('state_change', this.state);
        if (status === 'done' || status === 'error') {
            this.emit('output', `[${status}] ${extra.text || ''}`);
        }
    }

    _pushRecent(kind, text) {
        this.recent.push({ kind, text, t: Date.now() });
        if (this.recent.length > 6) this.recent.shift();
        this.emit('output', text);
    }

    emitError(text) {
        this._setStatus('error', { text });
        return Promise.resolve();
    }
}

function runSteps(steps, onDone) {
    let i = 0;
    const next = () => {
        if (i >= steps.length) { onDone(); return; }
        const s = steps[i++];
        setTimeout(() => { s.fn(); next(); }, s.delay);
    };
    next();
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? `${s.slice(0, n)}…` : s;
}
