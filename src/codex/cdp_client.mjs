// ============================================================
// cdp_client.mjs —— Codex 桌面应用 CDP 控制器（Phase 7）
//
// 背景：OpenAI.Codex（ChatGPT.exe，Electron）以
//   --remote-debugging-port=9229 启动，暴露 CDP 端点：
//     http://127.0.0.1:9229/json  → 两个 page
//       [0] app://-/index.html（主界面）
//       [1] app://-/index.html?initialRoute=%2Favatar-overlay
//   DOM 可读：侧边栏会话列表（工作/新对话/项目/已安排/插件/最近）、
//   会话标题、底部模型名 → 会话枚举/切换/注入/状态监听全部可行。
//
// 能力：
//   * listTargets()      —— 枚举 CDP 页面 target
//   * listSessions()     —— DOM 会话枚举（标题/状态/在跑/未读）
//   * selectSession(id)  —— DOM 点击切换会话
//   * injectText(text)   —— 聚焦输入框 → 注入文本 → 回车
//   * getStatus()        —— 当前是否在跑（发送中/停止按钮存在）
//   * watch()            —— 周期轮询会话状态，回调变更
//
// 实现：Runtime.evaluate 执行 JS 操作 DOM（比 CDP DOM 域更灵活），
// 选择器统一走 _SEL 配置，可随 Codex 版本 DOM 变化调整。
// ============================================================
import WebSocket from 'ws';

const CDP_HTTP = 'http://127.0.0.1:9229';
const PAGE_MAIN = 0;              // 主界面 target 索引

// 轮询间隔（会话状态监听，ms）
const WATCH_INTERVAL_MS = 2000;

export class CodexController extends EventTarget {
    /**
     * @param {object} opts
     * @param {number}  opts.port         CDP 调试端口（默认 9229）
     * @param {number}  opts.pageIndex    主界面 target 索引（默认 0）
     * @param {boolean} opts.autoWatch    启动后自动轮询会话状态
     */
    constructor(opts = {}) {
        super();
        this.port = opts.port ?? 9229;
        this.pageIndex = opts.pageIndex ?? PAGE_MAIN;
        this.autoWatch = opts.autoWatch ?? false;
        this._lastInjectedText = '';   // Phase 8.2：最近一次注入文本（撤销用）

        this.ws = null;
        this.target = null;         // 当前 page target 元信息
        this._id = 0;
        this._pending = new Map();
        this._watchTimer = null;
        this._sessions = [];        // 最近一次会话快照
        this._lastSnapshot = '';
        this._disposed = false;
    }

    get connected() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

    // ===================== 连接管理 =====================
    /**
     * 连接 Codex CDP：/json 枚举 → 连接主界面 page WS
     */
    async connect() {
        if (this.connected) return;
        const pages = await this.listTargets();
        // 主界面 = 非 avatar-overlay 的 page（页面顺序可能变化，按 URL 特征选）
        let target = pages.find((p) => !p.url.includes('avatar-overlay'));
        if (!target) target = pages[this.pageIndex] || pages[0];
        if (!target) throw new Error('CDP: 无可用 page target（Codex 桌面未运行？）');
        this.target = target;

        await new Promise((resolve, reject) => {
            const ws = new WebSocket(target.webSocketDebuggerUrl);
            ws.on('open', () => {
                this.ws = ws;
                resolve();
            });
            ws.on('error', (e) => reject(e));
            ws.on('close', () => {
                if (this._disposed) return;
                this.ws = null;
                if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
                this.dispatchEvent(new CustomEvent('disconnect', { detail: { reason: 'ws closed' } }));
            });
            ws.on('message', (data) => this._onMessage(data));
        });

        if (this.autoWatch) this.startWatch();
    }

    async close() {
        this._disposed = true;
        this.stopWatch();
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            try { ws.close(); } catch { /* ignore */ }
        }
    }

    async listTargets() {
        const res = await fetch(`http://127.0.0.1:${this.port}/json`);
        if (!res.ok) throw new Error(`CDP: /json HTTP ${res.status}`);
        return await res.json();
    }

    _onMessage(data) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id && this._pending.has(msg.id)) {
            const { resolve, reject } = this._pending.get(msg.id);
            this._pending.delete(msg.id);
            if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
            else resolve(msg.result);
        }
        // 事件暂不处理（轮询方案）
    }

    /**
     * CDP 命令封装
     */
    send(method, params = {}) {
        if (!this.connected) return Promise.reject(new Error('CDP: 未连接'));
        return new Promise((resolve, reject) => {
            const id = ++this._id;
            this._pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
            // 兜底超时（防止 eval 卡死挂起）
            setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error(`CDP: ${method} timeout`));
                }
            }, 8000);
        });
    }

    /**
     * 在页面执行 JS，返回 returnByValue 的值
     * @param {string} expression
     * @returns {Promise<any>}
     */
    async evaluate(expression) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (res.exceptionDetails) {
            const d = res.exceptionDetails;
            throw new Error(`CDP eval: ${d.text} ${d.exception?.description || ''}`.slice(0, 300));
        }
        return res.result?.value;
    }

    // ===================== 会话枚举（DOM） =====================
    // 策略（2026-08-14 实测 Codex 桌面 DOM）：
    //   * 会话项 = DIV.sidebar-item（分类"新对话/已安排/插件"是 BUTTON.sidebar-item）
    //   * 会话标题 = 该 DIV 的 innerText（可能带"工作"等分类徽标，取首行）
    //   * 底部模型选择器（如 "deepseek"）y 坐标 >850，排除
    //   * 空状态"无聊天"排除
    // 每个会话返回 { id, title, status, running, unread }
    async listSessions() {
        let list = await this._enumerate();
        // 视图兜底：会话过少说明侧边栏处于项目/折叠视图 → 点"工作"恢复列表
        // （用户在外设上操作时进入列表视图是预期行为）
        if ((list || []).length < 2) {
            try {
                await this.evaluate(`(() => {
                    const btns = [...document.querySelectorAll('button')];
                    for (const el of btns) {
                        if ((el.innerText || '').trim().split(/\\n/)[0].trim() === '工作') {
                            el.click(); return true;
                        }
                    }
                    return false;
                })()`);
                await sleep(900);
                list = await this._enumerate();
            } catch { /* 恢复失败则以当前视图为准 */ }
        }

        const seenTitle = new Set();
        const sessions = [];
        for (const s of list || []) {
            if (seenTitle.has(s.title)) continue;
            seenTitle.add(s.title);
            sessions.push({
                id: `s-${sessions.length + 1}`,
                title: s.title,
                status: 'idle',
                running: false,
                unread: false,
            });
        }
        this._sessions = sessions;
        return sessions;
    }

    /**
     * 原始枚举（不恢复视图）
     */
    async _enumerate() {
        return await this.evaluate(`(() => {
            const items = [...document.querySelectorAll('[class*="sidebar-item"]')];
            const SKIP = ['新对话','已安排','插件','工作','项目','最近','无聊天','设置','帮助'];
            const out = [];
            for (const el of items) {
                if (el.tagName !== 'DIV') continue;          // 分类项是 BUTTON
                const r = el.getBoundingClientRect();
                if (r.y > 850) continue;                      // 底部模型区
                // 排除项目文件夹行（data-app-action-sidebar-project-row）
                if (el.getAttribute('data-app-action-sidebar-project-row') !== null) continue;
                const t = (el.innerText || '').trim();
                if (!t) continue;
                // 标题 = 首行（去掉"工作"等徽标前缀）
                const firstLine = t.split('\\n')[0].trim();
                if (!firstLine || SKIP.includes(firstLine)) continue;
                out.push({ title: firstLine.slice(0, 60), y: Math.round(r.y) });
            }
            // 按位置排序（上 → 下）
            out.sort((a, b) => a.y - b.y);
            return out;
        })()`);
    }

    /**
     * 判断当前页面是否有运行中的任务（存在停止按钮/发送中指示）
     */
    async isRunningNow() {
        const v = await this.evaluate(`(() => {
            // 常见停止按钮特征（ChatGPT/Codex 样式）
            const stop = document.querySelector('[aria-label*="Stop" i], [aria-label*="停止"], [data-testid*="stop" i]');
            return !!stop;
        })()`);
        return !!v;
    }

    /**
     * 读取当前激活会话标题（主区域 header）
     */
    async getActiveTitle() {
        const t = await this.evaluate(`(() => {
            const header = document.querySelector('header [class*="toolbar"], header h1, header h2, header [class*="title"]');
            if (header) {
                const s = (header.innerText || '').trim();
                if (s && s.length < 80) return s;
            }
            return '';
        })()`);
        return t || '';
    }

    /**
     * 获取会话状态快照：枚举 + 当前激活会话 running 标记
     */
    async getSnapshot() {
        const [sessions, running, activeTitle] = await Promise.all([
            this.listSessions(),
            this.isRunningNow(),
            this.getActiveTitle(),
        ]);
        // running 应用到当前激活会话（按标题匹配）
        if (running && activeTitle) {
            const hit = sessions.find((s) => s.title === activeTitle) ||
                        sessions.find((s) => activeTitle.includes(s.title) || s.title.includes(activeTitle));
            if (hit) hit.running = true;
        }
        // 无停止按钮时全部 idle（避免残留 running 状态）
        return sessions;
    }

    // ===================== 会话切换（DOM 点击） =====================
    /**
     * 点击切换到指定会话
     * @param {string} sessionId 列表会话 id（s-1 形式）
     */
    async selectSession(sessionId) {
        if (this._sessions.length === 0) await this.listSessions();
        const idx = parseInt(String(sessionId).replace('s-', ''), 10) - 1;
        const s = this._sessions[idx];
        if (!s) throw new Error(`CDP: 会话 ${sessionId} 不存在`);
        const ok = await this.evaluate(`(() => {
            const items = [...document.querySelectorAll('[class*="sidebar-item"]')];
            for (const el of items) {
                if (el.tagName !== 'DIV') continue;
                const r = el.getBoundingClientRect();
                if (r.y > 850) continue;
                const t = (el.innerText || '').trim();
                if (!t) continue;
                const firstLine = t.split('\\n')[0].trim();
                if (firstLine === ${JSON.stringify(s.title)}) {
                    el.click();
                    return true;
                }
            }
            return false;
        })()`);
        if (!ok) throw new Error(`CDP: 未找到会话 "${s.title}"`);
        return true;
    }

    // ===================== 文本注入（输入框） =====================
    /**
     * 向当前会话输入框注入文本，可选回车发送
     * @param {string} text
     * @param {boolean} sendEnter 是否回车发送（默认 true）
     */
    async injectText(text, sendEnter = true) {
        const r = await this.evaluate(`(() => {
            // 1. 找输入框（textarea 优先，其次 contenteditable）
            const q = document.querySelector('textarea') ||
                      document.querySelector('[contenteditable="true"], [contenteditable=""]');
            if (!q) return { ok: false, err: 'no input' };
            // 2. 聚焦
            q.focus();
            // ⚠️ Phase 8.2（2026-08-16）：不清空已有内容——多段累积提交
            //    （语音"确认"保留后再次录音 → 追加到输入框 → 最后统一发送）
            // 3. 注入文本（追加到末尾；原生 setter 触发框架响应）
            const text = ${JSON.stringify(text)};
            if (q.tagName === 'TEXTAREA') {
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                setter.call(q, (q.value || '') + text);
            } else {
                q.textContent = (q.textContent || '') + text;
            }
            q.dispatchEvent(new Event('input', { bubbles: true }));
            q.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, tag: q.tagName };
        })()`);
        if (!r?.ok) throw new Error(`CDP 注入失败: ${r?.err || 'unknown'}`);
        await sleep(200);   // 等 React 状态同步
        this._lastInjectedText = text;   // Phase 8.2：记录本次注入文本（撤销用）
        // ⚠️ Phase 8.2：注入后光标归位到末尾（ProseMirror 对 setter 注入会把光标重置到开头，
        //    用户体验差——继续输入/追加时光标应在末尾）
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'End', code: 'End',
            windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35,
        });
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'End', code: 'End',
            windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35,
        });
        if (!sendEnter) return true;
        // 回车发送
        await this.evaluate(`(() => {
            const q = document.querySelector('textarea') ||
                      document.querySelector('[contenteditable="true"], [contenteditable=""]');
            if (!q) return false;
            q.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
            }));
            q.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
            }));
            return true;
        })()`);
        return true;
    }

    /**
     * Phase 8.2：发送（聚焦输入框 + Enter）——用于"发送"键，注入已完成（自动粘贴），
     * 这里只提交输入框内容（不再重复注入）
     */
    async sendEnter() {
        const r = await this.evaluate(`(() => {
            const q = document.querySelector('textarea') ||
                      document.querySelector('[contenteditable="true"], [contenteditable=""]');
            if (!q) return { ok: false, err: 'no input' };
            q.focus();
            // 光标移到末尾后回车（ProseMirror 提交）
            if (q.tagName === 'TEXTAREA' && q.setSelectionRange) {
                q.setSelectionRange(q.value.length, q.value.length);
            }
            q.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
            }));
            q.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
            }));
            return { ok: true };
        })()`);
        if (!r?.ok) throw new Error(`CDP 发送失败: ${r?.err || 'unknown'}`);
        await sleep(200);
        return true;
    }

    /**
     * Phase 8.2：撤销最近一次注入
     * ⚠️ Codex 输入框 = DIV contenteditable (ProseMirror)：
     *    - Ctrl+Z 无效、DOM 直改无效（ProseMirror state 覆盖）
     *    - 真实 Backspace 键有效（ProseMirror 监听 keydown），但**必须光标在末尾**
     *      （contenteditable 的 focus 默认光标在开头，Backspace 删不到内容）
     */
    async undoLast() {
        const last = this._lastInjectedText || '';
        if (!last) return false;
        // 1. 聚焦（ProseMirror 默认光标在开头——用真实 End 键移到末尾，
        //    Selection API 对 ProseMirror 无效（实测光标仍回句首））
        await this.evaluate(`(() => {
            const q = document.querySelector('textarea') ||
                      document.querySelector('[contenteditable="true"], [contenteditable=""]');
            if (!q) return false;
            q.focus();
            return true;
        })()`);
        // 2. End 键移到内容末尾（ProseMirror 原生响应）
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'End', code: 'End',
            windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35,
        });
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'End', code: 'End',
            windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35,
        });
        // 3. Backspace × 文本长度（ProseMirror 收到真实按键 → 内部删除 → state 同步）
        for (let i = 0; i < last.length; i++) {
            await this.send('Input.dispatchKeyEvent', {
                type: 'keyDown', key: 'Backspace', code: 'Backspace',
                windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
            });
            await this.send('Input.dispatchKeyEvent', {
                type: 'keyUp', key: 'Backspace', code: 'Backspace',
                windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
            });
        }
        // 4. 撤销后光标归位到末尾（方便继续输入）
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'End', code: 'End',
            windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35,
        });
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'End', code: 'End',
            windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35,
        });
        await sleep(200);
        return true;
    }

    // ===================== 状态监听（轮询） =====================
    startWatch() {
        if (this._watchTimer) return;
        const tick = async () => {
            try {
                const snap = await this.getSnapshot();
                const key = JSON.stringify(snap.map((s) => ({ t: s.title, r: s.running })));
                if (key !== this._lastSnapshot) {
                    this._lastSnapshot = key;
                    this.dispatchEvent(new CustomEvent('sessions', { detail: { sessions: snap } }));
                }
            } catch (e) {
                // 连接中断时静默，disconnect 事件由 ws close 抛
            }
        };
        tick();
        this._watchTimer = setInterval(tick, WATCH_INTERVAL_MS);
    }

    stopWatch() {
        if (this._watchTimer) {
            clearInterval(this._watchTimer);
            this._watchTimer = null;
        }
    }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
