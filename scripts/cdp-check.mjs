// cdp-check.mjs —— 检查 Codex 当前会话消息尾部（开发调试）
import { CodexController } from '../src/codex/cdp_client.mjs';

const c = new CodexController();
try {
    await c.connect();
    const tail = await c.evaluate(`(() => {
        const main = document.querySelector('main') || document.body;
        const t = (main.innerText || '');
        return t.slice(-700);
    })()`);
    console.log('MAIN TAIL >>>');
    console.log(tail);
    console.log('<<< END');
} catch (e) {
    console.error('ERR:', e.message);
}
await c.close();
process.exit(0);
