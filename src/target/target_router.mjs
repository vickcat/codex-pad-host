// ============================================================
// target_router.mjs —— 多目标注入路由 + 会话状态聚合（Phase 7）
//
// 产品方向（2026-08-14 用户确认）：
//   1. 只支持 Codex：语音注入 Codex 桌面应用（CDP 深控）
//   2. 屏幕 4 卡切换 Codex 应用内会话（在跑 + 未查看优先第 1 页）
//   3. 其他 app（WorkBuddy/Trae 等）= generic：剪贴板注入兜底
//
// 模式（config.target.app）：
//   codex   —— CodexController 轮询会话 + CDP 切换/注入
//   generic —— 无会话概念，单目标"前台窗口"，剪贴板注入
//
// 对外接口（供 server.mjs）：
//   * start()/stop()
//   * listSessions()       —— 排序后的会话列表（running 优先）
//   * selectSession(id)    —— 切换会话
//   * injectText(text)     —— 注入（CDP 或剪贴板）
//   * 'sessions' 事件      —— 会话列表变化（周期轮询驱动）
// ============================================================
import { EventEmitter } from 'events';
import { CodexController } from '../codex/cdp_client.mjs';
import { TextInjector } from '../inject/text_injector.mjs';

const POLL_MS = 3000;          // 会话状态轮询间隔
const MAX_SESSIONS = 12;       // 固件支持上限（每页 4，最多 3 页）
const EXTRA_TARGET_ID = 'target-wb';   // 追加目标的固定 agentId（WorkBuddy/Trae）

export class TargetRouter extends EventEmitter {
    constructor(config) {
        super();
        this.target = config.target || {};
        this.app = this.target.app || 'codex';        // codex | generic
        this.injector = new TextInjector();

        this.codex = null;        // CodexController（codex 模式）
        this._sessions = [];      // 缓存（排序后）
        this._pollTimer = null;
        this._reconnectTimer = null;
        this._started = false;
    }

    get mode() { return this.app; }

    async start() {
        if (this._started) return;
        this._started = true;
        if (this.app === 'codex') {
            this.codex = new CodexController({ autoWatch: false });
            this.codex.addEventListener('disconnect', () => {
                console.warn('[CDP] ⚠️ Codex CDP 断开（Codex 重启？），降级 + 安排重连');
                this.app = 'generic';
                // ⚠️ 2026-08-16：CDP 断连 → 状态事件（server 广播，设备端提示"Codex 未连接"）
                this.emit('status', { codex: 'offline', message: 'Codex CDP 断开，已降级剪贴板注入' });
                this._scheduleReconnect();
            });
            await this._tryConnectCodex();
        }
        // 首次拉取 + 周期轮询
        await this._refresh();
        this._pollTimer = setInterval(() => this._refresh().catch(() => {}), POLL_MS);
    }

    // ⚠️ CDP 自动重连（2026-08-15）：Codex 桌面重启后 9229 端口短暂不可用，
    //    连接失败/断开不再永久降级——每 10s 重试，恢复后自动切回 codex 深控并广播。
    async _tryConnectCodex() {
        if (!this.codex) return;
        if (this.codex.connected) { this.app = 'codex'; return; }
        try {
            await this.codex.connect();
            console.log('[CDP] ✅ Codex CDP 已连接' + (this.app === 'codex' ? '' : '（恢复深控）'));
            this.app = 'codex';
            // ⚠️ 2026-08-16：恢复连接 → 状态事件（设备端提示"Codex 已连接"）
            this.emit('status', { codex: 'online', message: '' });
            if (this._started) this._refresh().catch(() => {});   // 立即广播新列表
        } catch (e) {
            console.warn(`[CDP] ⚠️ Codex CDP 不可用: ${e.message}（剪贴板注入兜底，10s 后重试）`);
            this.app = 'generic';
            this._scheduleReconnect();
        }
    }

    _scheduleReconnect() {
        if (this._reconnectTimer) return;   // 已有定时器，避免叠加
        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null;
            await this._tryConnectCodex().catch(() => {});
        }, 10000);
    }

    async stop() {
        this._started = false;
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.codex) await this.codex.close();
    }

    // ===================== 会话列表 =====================
    /**
     * 返回排序后的会话列表（running 优先 → 其余按位置）。
     * codex 模式：CDP 枚举；generic 模式：单目标"前台窗口"。
     */
    async listSessions() {
        if (this.app === 'codex' && this.codex?.connected) {
            try {
                const snap = await this.codex.getSnapshot();
                // 转成统一结构
                this._sessions = snap.slice(0, MAX_SESSIONS).map((s) => ({
                    agentId: s.id,
                    name: s.title,
                    type: 'codex',
                    target: 'codex',
                    status: s.running ? 'running' : 'idle',
                    running: s.running,
                    unread: s.unread || false,
                    lastText: '',
                    recent: [],
                }));
            } catch (e) {
                console.warn(`[CDP] 枚举失败: ${e.message}`);
            }
        } else {
            // generic / CDP 不可用：单目标剪贴板注入
            this._sessions = [{
                agentId: 'generic-1',
                name: '前台窗口注入',
                type: 'generic',
                target: 'generic',
                status: 'idle',
                running: false,
                unread: false,
                lastText: '语音确认后注入当前前台应用',
                recent: [],
            }];
        }
        // 追加剪贴板注入目标（WorkBuddy/Trae 等）：固定放最后一张卡
        // （Phase 7 产品方向：WorkBuddy 仅剪贴板注入，CDP 深控不可行）
        const extraName = (this.target.extraTarget || '').trim();
        const hasExtra = extraName && this._sessions.some((s) => s.agentId === EXTRA_TARGET_ID);
        // 若追加了 extra 目标，Codex 会话最多占 3 个位置（固件 AGENT_MAX=4，确保 extra 卡显示）
        if (extraName) {
            this._sessions = this._sessions.filter((s) => s.agentId !== EXTRA_TARGET_ID).slice(0, 3);
            this._sessions.push({
                agentId: EXTRA_TARGET_ID,
                name: extraName,
                type: 'generic',
                target: 'generic',
                status: 'idle',
                running: false,
                unread: false,
                lastText: '剪贴板注入（需目标窗口前台）',
                recent: [],
            });
        }
        // running 优先排序（extraTarget 保持末尾：不参与 running 排序）
        const extras = this._sessions.filter((s) => s.agentId === EXTRA_TARGET_ID);
        const mains = this._sessions.filter((s) => s.agentId !== EXTRA_TARGET_ID);
        mains.sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0));
        this._sessions = [...mains, ...extras];
        return this._sessions;
    }

    getSessions() { return this._sessions; }

    // ===================== 会话切换 =====================
    async selectSession(sessionId) {
        if (this.app === 'codex' && this.codex?.connected) {
            await this.codex.selectSession(sessionId);
            console.log(`[CDP] 切换到会话 ${sessionId}`);
            return { ok: true, target: 'codex' };
        }
        return { ok: false, error: 'generic 模式无会话切换' };
    }

    // ===================== 文本注入 =====================
    /**
     * 注入文本（codex=CDP 输入框，generic/extra=剪贴板粘贴）
     * @param {string} text
     * @param {string} [agentId] 目标会话 id（EXTRA_TARGET_ID 走剪贴板）
     */
    /**
     * 注入文本（codex=CDP 输入框，generic/extra=剪贴板粘贴）
     * @param {string} text
     * @param {string} [agentId] 目标会话 id（EXTRA_TARGET_ID 走剪贴板）
     * @param {boolean} [sendEnter] 注入后是否回车发送（Phase 7 改：默认 false 仅粘贴，
     *              回车由设备 BOOT 物理键（USB HID Enter）触发，见固件 handleButton）
     */
    async injectText(text, agentId = '', sendEnter = false) {
        // 追加目标（WorkBuddy/Trae）或 generic 模式 → 剪贴板注入
        const isExtra = (agentId === EXTRA_TARGET_ID) || (this.app !== 'codex');
        if (!isExtra && this.codex?.connected) {
            try {
                await this.codex.injectText(text, sendEnter);
                console.log(`[CDP] ✅ 已注入 Codex 会话输入框${sendEnter ? '并发送' : '（待回车）'}`);
                return { ok: true, target: 'codex', phase: sendEnter ? 'cdp_injected' : 'cdp_pasted' };
            } catch (e) {
                console.warn(`[CDP] ❌ CDP 注入失败(${e.message})，降级剪贴板注入`);
                // 降级：剪贴板注入
            }
        }
        // Phase 8 优化：单次 PS 会话完成"激活窗口 + 粘贴"（省一次 PS 启动 ~400ms）
        const actTitle = isExtra ? (this.target.extraActivate || '') : '';
        if (actTitle) {
            await this.injector.injectToWindow(actTitle, text, sendEnter);
            console.log(`[TXT] ✅ 已激活 "${actTitle}" 并剪贴板注入${sendEnter ? '发送' : '（待回车）'}`);
        } else if (sendEnter) {
            await this.injector.injectAndEnter(text);
        } else {
            await this.injector.injectOnly(text);
        }
        return { ok: true, target: 'generic', phase: sendEnter ? 'clipboard_injected' : 'clipboard_pasted' };
    }

    /**
     * Phase 8.2：发送（回车提交）——注入已完成，这里只提交
     * Codex → CDP 聚焦+Enter；通用注入 → 前台 SendKeys Enter
     */
    async sendEnter(agentId = '') {
        const isExtra = (agentId === EXTRA_TARGET_ID) || (this.app !== 'codex');
        if (!isExtra && this.codex?.connected) {
            try {
                await this.codex.sendEnter();
                console.log(`[CDP] ⏎ 已发送（输入框回车提交）`);
                return { ok: true, target: 'codex', phase: 'cdp_sent' };
            } catch (e) {
                console.warn(`[CDP] ❌ 发送失败(${e.message})，降级前台回车`);
            }
        }
        await this.injector.sendKeys('{ENTER}');
        console.log(`[TXT] ⏎ 已发送（前台回车）`);
        return { ok: true, target: 'generic', phase: 'clipboard_sent' };
    }

    /**
     * Phase 8.2：撤销最近一次注入（BOOT 键 / 撤销按钮）
     * Codex → CDP Ctrl+Z；剪贴板注入 → 前台 SendKeys Ctrl+Z
     */
    async cancelLastInject(agentId = '') {
        const isExtra = (agentId === EXTRA_TARGET_ID) || (this.app !== 'codex');
        if (!isExtra && this.codex?.connected) {
            try {
                await this.codex.undoLast();
                console.log(`[CDP] ↩️ 已撤销最近注入 (ctrl+z)`);
                return { ok: true, target: 'codex', phase: 'cdp_undo' };
            } catch (e) {
                console.warn(`[CDP] ❌ 撤销失败(${e.message})，降级剪贴板 Ctrl+Z`);
            }
        }
        await this.injector.sendKeys('^z');
        console.log(`[TXT] ↩️ 已发送 Ctrl+Z 撤销`);
        return { ok: true, target: 'generic', phase: 'clipboard_undo' };
    }

    // ===================== 内部 =====================
    async _refresh() {
        const before = JSON.stringify(this._sessions.map((s) => ({ i: s.agentId, r: s.running })));
        await this.listSessions();
        const after = JSON.stringify(this._sessions.map((s) => ({ i: s.agentId, r: s.running })));
        if (after !== before) {
            this.emit('sessions', this._sessions);
        }
    }
}
