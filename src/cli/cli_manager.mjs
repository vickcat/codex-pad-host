// ============================================================
// cli_manager.mjs —— CLI 会话池管理（Phase 5）
//
//   agentId → Session（CodexSession | ClaudeSession | MockSession）
//   * createAgent / destroy / sendPrompt / getState / getAllStates
//   * 会话 state_change 事件统一转发为 manager 的 'state_change'
//   * 默认 Agent 池由 config.cli.agents 定义（Agent 1/2/3）
//
// Windows 注意：npm 全局安装的 CLI 是 .cmd 包装，spawn 需要
// 显式追加 .cmd，否则报 ENOENT。
// ============================================================
import { EventEmitter } from 'events';
import { CodexSession } from './codex_session.mjs';
import { ClaudeSession } from './claude_session.mjs';
import { MockSession } from './mock_session.mjs';

export class CliManager extends EventEmitter {
    constructor(config) {
        super();
        this.cliConfig = config.cli || {};
        this.agents = new Map();   // agentId -> session
        this._defaultAgentId = this.cliConfig.defaultAgentId || 'agent-1';
        this._lastCwd = new Map(); // agentId -> cwd（幂等创建用）
    }

    get defaultAgentId() { return this._defaultAgentId; }

    /**
     * 按配置创建 Agent（type: codex | claude | mock）
     */
    createAgent(def) {
        const id = def.id || `agent-${this.agents.size + 1}`;
        if (this.agents.has(id)) return this.agents.get(id);

        const type = def.type || 'mock';
        const cwd = def.cwd || process.cwd();
        const base = { agentId: id, name: def.name || `Agent ${id}`, cwd };

        let session;
        if (type === 'codex') {
            session = new CodexSession({
                ...base,
                command: resolveCmd(this.cliConfig.codexCommand, 'codex'),
                model: def.model || this.cliConfig.codexModel,
                sandbox: def.sandbox || this.cliConfig.codexSandbox,
            });
        } else if (type === 'claude') {
            session = new ClaudeSession({ ...base, command: resolveCmd(this.cliConfig.claudeCommand, 'claude') });
        } else {
            session = new MockSession({ ...base, replyTemplate: def.replyTemplate });
        }

        this._wire(session);
        this.agents.set(id, session);
        return session;
    }

    _wire(session) {
        session.on('state_change', (state) => {
            this.emit('state_change', session.agentId, state);
        });
        session.on('output', (line) => {
            this.emit('output', session.agentId, line);
        });
    }

    getSession(agentId) {
        const id = agentId || this._defaultAgentId;
        return this.agents.get(id) || null;
    }

    getState(agentId) {
        const s = this.getSession(agentId);
        return s ? s.state : null;
    }

    getAllStates() {
        return [...this.agents.values()].map((s) => s.state);
    }

    async sendPrompt(agentId, text) {
        const s = this.getSession(agentId);
        if (!s) {
            const msg = `Agent ${agentId} 不存在`;
            this.emit('state_change', agentId, {
                agentId, name: agentId, type: 'unknown', status: 'error',
                lastText: msg, recent: [],
            });
            return { ok: false, error: msg };
        }
        await s.sendPrompt(text);
        return { ok: true, agentId: s.agentId, status: s.status };
    }

    /**
     * 非阻塞提交：立即返回，CLI 异步执行（长任务时 ack 不等待完成）
     * @returns {{ok: boolean, agentId?: string, status?: string, error?: string}}
     */
    submitPrompt(agentId, text) {
        const s = this.getSession(agentId);
        if (!s) {
            return { ok: false, error: `Agent ${agentId} 不存在` };
        }
        if (s.status === 'running' || s.status === 'thinking') {
            return { ok: true, agentId: s.agentId, status: s.status, busy: true };
        }
        s.sendPrompt(text).catch((e) => {
            this.emit('output', agentId, `submit error: ${e.message}`);
        });
        return { ok: true, agentId: s.agentId, status: 'thinking' };
    }

    destroy(agentId) {
        const s = this.agents.get(agentId);
        if (s) {
            s.kill();
            this.agents.delete(agentId);
            return true;
        }
        return false;
    }

    /**
     * 从 config.cli.agents 初始化默认 Agent 池（幂等）
     */
    initDefaultAgents() {
        const list = this.cliConfig.agents || [];
        for (const def of list) {
            if (!this.agents.has(def.id)) {
                this.createAgent(def);
            }
        }
        if (this.agents.size === 0) {
            // 兜底：一个 mock Agent
            this.createAgent({ id: 'agent-1', name: 'Agent 1 (mock)', type: 'mock' });
        }
    }

    shutdown() {
        for (const id of [...this.agents.keys()]) this.destroy(id);
    }
}

// Windows 说明：npm 全局 bin 是 .cmd 包装，session 内 spawn 已用 shell:true，
// 因此这里返回原始命令名即可（shell 负责解析 codex/claude.cmd）
function resolveCmd(cfgCmd, fallback) {
    return cfgCmd || fallback;
}
