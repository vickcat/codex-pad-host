// ============================================================
// claude_session.mjs —— Claude Code CLI 会话封装（Phase 5）
//
// 命令形态（Windows）:
//   claude.cmd -p --verbose --output-format stream-json --session-id <uuid> <prompt>
//
// 用固定 --session-id 实现多轮会话复用（同一 UUID 自动延续上下文）。
// 与 CodexSession 保持相同对外接口（state / sendPrompt / kill / 事件）。
// ============================================================
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { parseClaudeEvent } from './output_parser.mjs';

export class ClaudeSession extends EventEmitter {
    constructor(options) {
        super();
        this.agentId = options.agentId;
        this.name = options.name || `Agent ${options.agentId}`;
        this.command = options.command || 'claude';        // Windows 上需为 claude.cmd
        this.cwd = options.cwd || process.cwd();
        this.sessionId = options.sessionId || randomUUID();

        this.proc = null;
        this.status = 'idle';
        this.lastText = '';
        this.lastTool = '';
        this.lastDetail = '';
        this.usage = null;
        this.recent = [];
        this.startedAt = null;
        this.finishedAt = null;
        this._settled = false;
        this._settleFn = null;
    }

    get state() {
        return {
            agentId: this.agentId,
            name: this.name,
            type: 'claude',
            status: this.status,
            lastText: this.lastText,
            lastTool: this.lastTool,
            lastDetail: this.lastDetail,
            usage: this.usage,
            recent: [...this.recent],
            sessionId: this.sessionId,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
        };
    }

    sendPrompt(text) {
        if (!text || !text.trim()) {
            return Promise.resolve(this.emitError('空指令'));
        }
        if (this.status === 'running' || this.status === 'thinking') {
            return Promise.resolve(this.emitError('会话忙，请稍后再试'));
        }

        this._setStatus('thinking', { text: '提交指令…', detail: truncate(text, 80) });
        this._pushRecent('user', truncate(text, 80));
        this.startedAt = Date.now();
        this.finishedAt = null;
        this._settled = false;

        const args = [
            '-p', '--verbose', '--output-format', 'stream-json',
            '--session-id', this.sessionId,
            // prompt 从 stdin 读取（无位置参数时 claude -p 自动读 stdin）
        ];
        const env = {
            ...process.env,
            FORCE_COLOR: '0', NO_COLOR: '1',
            NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
        };

        return new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            this._settleFn = finish;

            let proc;
            try {
                proc = spawn(this.command, args, {
                    cwd: this.cwd,
                    env,
                    shell: process.platform === 'win32',   // Windows: .cmd 包装需 shell
                    windowsHide: true,
                });
            } catch (e) {
                this._setStatus('error', { text: `启动失败: ${e.message}` });
                finish();
                return;
            }
            this.proc = proc;

            // prompt 通过 stdin 传递（规避命令行参数转义）
            try {
                proc.stdin.write(text + '\n');
                proc.stdin.end();
            } catch { /* stdin 已关闭则忽略 */ }

            let stdoutBuf = '';
            let stderrTail = '';

            proc.stdout.on('data', (chunk) => {
                stdoutBuf += chunk.toString();
                let idx;
                while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
                    const line = stdoutBuf.slice(0, idx).trim();
                    stdoutBuf = stdoutBuf.slice(idx + 1);
                    if (line) this._handleLine(line);
                }
            });

            proc.stderr.on('data', (chunk) => {
                stderrTail = (stderrTail + chunk.toString()).slice(-500);
            });

            proc.on('error', (err) => {
                this._setStatus('error', { text: `CLI 进程错误: ${err.message}` });
                finish();
            });

            proc.on('close', (code) => {
                if (stdoutBuf.trim() && !this._settled) this._handleLine(stdoutBuf.trim());

                if (!this._settled) {
                    const msg = stderrTail.trim()
                        ? `CLI 退出 (code=${code}): ${truncate(stderrTail, 200)}`
                        : `CLI 退出 (code=${code})`;
                    this._setStatus(code === 0 ? 'done' : 'error', {
                        text: code === 0 ? this.lastText || '完成' : msg,
                    });
                }
                this.finishedAt = Date.now();
                this.proc = null;
                if (this._settleFn) {
                    const fn = this._settleFn;
                    this._settleFn = null;
                    fn();
                }
                finish();
            });
        });
    }

    _handleLine(line) {
        if (this._settled) return;   // 本轮已结算，忽略后续噪音
        const ev = parseClaudeEvent(JSON.parse(line));
        if (!ev) return;

        switch (ev.type) {
            case 'text': {
                this._setStatus('thinking', { text: ev.text });
                this._pushRecent('agent', ev.text);
                break;
            }
            case 'tool': {
                this.lastTool = ev.tool;
                this._setStatus('running', { tool: ev.tool, detail: ev.detail });
                this._pushRecent('tool', `${ev.tool}${ev.detail ? `: ${ev.detail}` : ''}`);
                break;
            }
            case 'status': {
                if (ev.status === 'waiting') {
                    this._setStatus('waiting', { detail: ev.detail });
                    this._pushRecent('waiting', ev.detail || '等待确认');
                } else {
                    this._setStatus('thinking', { text: ev.text, detail: ev.detail });
                }
                break;
            }
            case 'done': {
                this.usage = ev.usage || this.usage;
                // result 文本可能为空，保留 agent 最后文本
                const text = ev.text && ev.text !== '完成' ? ev.text : (this.lastText || '完成');
                this._setStatus('done', { text });
                if (text !== '完成') this._pushRecent('agent', text);
                break;
            }
            case 'error': {
                this._setStatus('error', { text: ev.text });
                break;
            }
            default:
                break;
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
            this._settled = true;
            if (this._settleFn) {
                const fn = this._settleFn;
                this._settleFn = null;
                fn();
            }
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

    kill() {
        if (this.proc) {
            try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
            this.proc = null;
        }
    }
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? `${s.slice(0, n)}…` : s;
}
