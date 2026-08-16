// ============================================================
// codex_session.mjs —— Codex CLI 会话封装（Phase 5）
//
// 命令形态：
//   新会话: codex exec --json -C <cwd> [--skip-git-repo-check] <prompt>
//   复用:   codex exec resume --json <thread_id> -C <cwd> <prompt>
//
// 每次 sendPrompt 会 spawn 一个一次性进程（exec 模式执行完即退出），
// 从 thread.started 事件记录 thread_id，后续 prompt 用 resume 复用。
// 状态机: idle → thinking → running → waiting → done | error
//
// 事件（EventEmitter）：
//   'state_change' (state)  状态变化（含 status/text/tool/detail/usage）
//   'output' (text)         新增一条文本/工具输出（供最近活动列表）
// ============================================================
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { parseCodexEvent } from './output_parser.mjs';

export class CodexSession extends EventEmitter {
    constructor(options) {
        super();
        this.agentId = options.agentId;
        this.name = options.name || `Agent ${options.agentId}`;
        this.command = options.command || 'codex';       // Windows 上需为 codex.cmd
        this.cwd = options.cwd || process.cwd();
        this.model = options.model || '';                // 覆盖 ~/.codex/config.toml 的 model
        this.skipGitCheck = options.skipGitCheck !== false;
        this.sandbox = options.sandbox || 'read-only';   // read-only | workspace-write | danger-full-access

        this.proc = null;
        this.threadId = null;        // codex thread id（会话复用）
        this.status = 'idle';
        this.lastText = '';
        this.lastTool = '';
        this.lastDetail = '';
        this.usage = null;
        this.recent = [];            // 最近活动（最多 6 条）
        this.startedAt = null;
        this.finishedAt = null;
        this.allowStdin = false;     // exec 模式无需写 stdin
        this._settled = false;       // 本轮是否已结算（done/error）
        this._settleFn = null;       // 结算回调（Promise resolve）
    }

    get state() {
        return {
            agentId: this.agentId,
            name: this.name,
            type: 'codex',
            status: this.status,
            lastText: this.lastText,
            lastTool: this.lastTool,
            lastDetail: this.lastDetail,
            usage: this.usage,
            recent: [...this.recent],
            threadId: this.threadId,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
        };
    }

    /**
     * 发送一个 prompt，等待本轮 CLI 执行完成。
     * @param {string} text
     * @returns {Promise<void>} 解析完成即 resolve（不阻塞）
     */
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

        const args = this._buildArgs();
        // NO_PROXY：codex(reqwest) 会走系统代理(127.0.0.1:22307)转发本地代理请求导致失败，
        // 必须显式绕过 localhost。模型名通过 -m 覆盖（config.toml 可能是错误/别名模型名）。
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
                // 按行解析（JSONL 可能跨 chunk）
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
                // 处理残留 stdout
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
                // 兜底：进程退出但状态未结算时也 resolve
                if (this._settleFn) {
                    const fn = this._settleFn;
                    this._settleFn = null;
                    fn();
                }
                finish();
            });
        });
    }

    _buildArgs() {
        const args = ['exec'];
        if (this.threadId) {
            args.push('resume', this.threadId);
        }
        args.push('--json');
        if (this.model) args.push('-m', this.model);
        if (this.skipGitCheck) args.push('--skip-git-repo-check');
        args.push('-C', this.cwd);
        if (this.sandbox) args.push('-s', this.sandbox);
        // prompt 用 '-' 从 stdin 读取（避免命令行特殊字符问题）
        args.push('-');
        return args;
    }

    _handleLine(line) {
        if (this._settled) return;   // 本轮已结算，忽略重连/后续噪音
        const ev = parseCodexEvent(JSON.parse(line));
        if (!ev) return;

        if (ev.sessionId && !this.threadId) {
            this.threadId = ev.sessionId;
        }

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
                // turn.completed 的 summary 可能为空（fallback '完成'），此时保留 agent 最后文本
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
                fn();   // 本轮结算：Promise resolve，不等进程 close
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
