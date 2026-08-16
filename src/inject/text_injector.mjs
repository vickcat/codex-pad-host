// ============================================================
// text_injector.mjs —— Windows 剪贴板文本注入（Phase 5 / Phase 7 优化）
//
// 用途：把确认后的转写文本"粘贴 + 回车"到前台应用
// （WorkBuddy / Codex 桌面 / 终端等），作为 CLI 会话托管之外的投递方式。
//
// ⚠️ Phase 7 性能优化（2026-08-15）：
//   原实现每次注入启动 5 次 powershell.exe（备份/写入/Ctrl+V/回车/恢复），
//   Windows 每次启动 PS 约 300-800ms → 注入累计 2-4s 纯开销（用户反馈"慢"）。
//   改为【单次 PowerShell 会话】完成全部步骤（备份→写入→SendKeys→恢复），
//   注入耗时从 ~3s 降到 ~0.5-1s。
//
// 实现（兼容 Windows PowerShell 5.1）：
//   1. 单进程内：备份剪贴板 → Set-Clipboard 写入（UTF-8 base64 传参防乱码）
//   2. WScript.Shell SendKeys 模拟 Ctrl+V 粘贴
//   3. 可选 SendKeys Enter 发送
//   4. 恢复原剪贴板
//
// ⚠️ 注入会向前台窗口发送按键：请确保目标窗口处于激活状态。
// ============================================================
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PS = 'powershell.exe';
const DONE_MARK = '__PS_DONE__';

// ============================================================
// PsSession —— 常驻 PowerShell 交互会话（Phase 8，2026-08-15 晚）
//
// 背景：每次 execFileAsync 启动 powershell.exe 需 400-500ms（进程启动开销），
//       两步注入实测 1.43s、单会话 940ms。改为**常驻一个 PS 进程**（stdin 交互），
//       脚本尾部输出 DONE_MARK 标记完成 → 注入耗时降到 ~300ms（快 4.7 倍）。
//
// 实现：spawn('powershell.exe', ['-Command','-']) 交互模式；
//       脚本以单行（; 连接）写入 stdin + 提交标记行；
//       stdout 逐行缓冲，遇到 DONE_MARK 即 resolve（等待队列串行保证顺序）。
// ⚠️ 脚本内容必须纯 ASCII（base64 内嵌文本），规避 GBK 管道编码问题。
// ============================================================
class PsSession {
    constructor() {
        this.child = null;
        this.buf = '';
        this.waiters = [];
    }

    _ensure() {
        if (this.child && this.child.exitCode === null) return;
        this.buf = '';
        this.child = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (d) => {
            this.buf += d;
            while (true) {
                const i = this.buf.indexOf(DONE_MARK);
                if (i < 0) break;
                this.buf = this.buf.slice(i + DONE_MARK.length);
                const w = this.waiters.shift();
                if (w) { clearTimeout(w.timer); w.resolve(); }
            }
        });
        this.child.stderr.on('data', () => {});
        this.child.on('exit', () => {
            const ws = this.waiters.splice(0);
            for (const w of ws) { clearTimeout(w.timer); w.reject(new Error('PS session exited')); }
        });
    }

    /**
     * 执行单行脚本（; 连接），等待 DONE_MARK 返回
     */
    exec(script, timeoutMs = 8000) {
        this._ensure();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = this.waiters.findIndex((w) => w.timer === timer);
                if (i >= 0) this.waiters.splice(i, 1);
                reject(new Error('PS session timeout'));
            }, timeoutMs);
            this.waiters.push({ timer, resolve, reject });
            this.child.stdin.write(script + `\nWrite-Output '${DONE_MARK}'\n`);
        });
    }

    close() {
        if (this.child && this.child.exitCode === null) {
            try { this.child.stdin.end(); } catch { /* ignore */ }
            try { this.child.kill(); } catch { /* ignore */ }
        }
        this.child = null;
    }
}

export class TextInjector {
    constructor() {
        this._ps = new PsSession();
    }

    /**
     * 执行 PS 脚本：优先常驻会话，异常时 fallback 单次进程（session 可能挂掉/超时）
     */
    async _runScript(script) {
        try {
            await this._ps.exec(script);
        } catch (e) {
            const enc = Buffer.from(script, 'utf16le').toString('base64');
            await execFileAsync(PS, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { timeout: 5000 });
        }
    }

    /**
     * 粘贴 + 回车（完整发送）
     */
    async injectAndEnter(text) {
        await this._inject(text, true);
    }

    /**
     * 仅粘贴，不回车（多段累积时用）
     */
    async injectOnly(text) {
        await this._inject(text, false);
    }

    /**
     * 单次 PowerShell 会话完成注入（写入→粘贴→[回车]）
     * 文本经 base64 传递，规避中文/引号/特殊字符编码问题。
     * Phase 8 优化（2026-08-15 晚）：去掉 Get-Clipboard 备份/恢复——
     *   该步骤在剪贴板被目标应用占用时会卡住 → 8s 超时 → 注入失败（用户反馈"奇慢/超时"）。
     *   语音注入场景接受剪贴板被覆盖；注入耗时目标 <1s。
     */
    async _inject(text, pressEnter) {
        const textB64 = Buffer.from(text, 'utf8').toString('base64');
        const keysB64 = Buffer.from(pressEnter ? '^v{ENTER}' : '^v', 'utf8').toString('base64');
        // ⚠️ 最短路径：写入剪贴板 → SendKeys 粘贴 → [回车]（常驻 PS 会话执行）
        const script =
            `$ErrorActionPreference='SilentlyContinue';` +
            `$b=[Convert]::FromBase64String('${textB64}');` +
            `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString($b));` +
            `$w=New-Object -ComObject WScript.Shell;` +
            `Start-Sleep -Milliseconds 30;` +
            `$keys=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${keysB64}'));` +
            `$w.SendKeys($keys);` +
            `Start-Sleep -Milliseconds 40`;
        await this._runScript(script);
    }

    async getClipboard() {
        // PowerShell 5.1 stdout 走系统代码页（GBK），直接输出文本会乱码；
        // 改为在 PS 端转 UTF-8 base64，Node 端解码，彻底规避编码问题。
        const { stdout } = await execFileAsync(PS, ['-NoProfile', '-Command',
            '$t=Get-Clipboard -Raw; [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t))']);
        return Buffer.from(stdout.trim(), 'base64').toString('utf8');
    }

    /**
     * 激活目标窗口 + 注入（单次 PowerShell 会话，Phase 8 优化）
     * 替代 activateWindow() + injectOnly() 两步（省一次 PS 启动 ~400ms）。
     * @param {string} title 窗口标题关键字（AppActivate 模糊匹配）
     * @param {string} text 注入文本
     * @param {boolean} pressEnter 是否回车发送
     */
    async injectToWindow(title, text, pressEnter) {
        const tB64 = Buffer.from(title, 'utf8').toString('base64');
        const textB64 = Buffer.from(text, 'utf8').toString('base64');
        const keysB64 = Buffer.from(pressEnter ? '^v{ENTER}' : '^v', 'utf8').toString('base64');
        const script =
            `$ErrorActionPreference='SilentlyContinue';` +
            `$w=New-Object -ComObject WScript.Shell;` +
            `$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${tB64}'));` +
            `$w.AppActivate($t) | Out-Null;` +
            `Start-Sleep -Milliseconds 180;` +
            `$b=[Convert]::FromBase64String('${textB64}');` +
            `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString($b));` +
            `Start-Sleep -Milliseconds 20;` +
            `$keys=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${keysB64}'));` +
            `$w.SendKeys($keys);` +
            `Start-Sleep -Milliseconds 40`;
        await this._runScript(script);
    }

    /**
     * 激活前台窗口（WScript.Shell AppActivate，按窗口标题模糊匹配）
     * @param {string} title 窗口标题关键字（如 'WorkBuddy'）
     * @returns {boolean} 是否激活成功
     */
    async activateWindow(title) {
        if (!title) return false;
        const tB64 = Buffer.from(title, 'utf8').toString('base64');
        const script =
            `$w=New-Object -ComObject WScript.Shell;` +
            `$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${tB64}'));` +
            `$ok=$w.AppActivate($t);` +
            `if($ok){Start-Sleep -Milliseconds 300};` +
            `Write-Output $ok`;
        const { stdout } = await execFileAsync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 });
        return stdout.trim().toLowerCase() === 'true';
    }

    async setClipboard(text) {
        const b64 = Buffer.from(text, 'utf8').toString('base64');
        const script =
            `$b=[Convert]::FromBase64String('${b64}');` +
            `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString($b))`;
        await execFileAsync(PS, ['-NoProfile', '-Command', script]);
    }

    /**
     * 发送按键序列（WScript.Shell SendKeys 语法）
     * ⚠️ 2026-08-16：改走常驻 PS 会话（_runScript）——之前用 execFileAsync
     *    冷启动 PowerShell 400-500ms，撤销（Ctrl+Z）明显卡顿
     * @param {string} keys e.g. '^v' | '{ENTER}' | '{ESC}'
     */
    async sendKeys(keys) {
        // 参数经 base64 传递，避免引号/特殊字符转义地狱
        const b64 = Buffer.from(keys, 'utf8').toString('base64');
        const script =
            `$w=New-Object -ComObject WScript.Shell;` +
            `$w.SendKeys([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
        await this._runScript(script);
    }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
