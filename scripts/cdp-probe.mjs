// ============================================================
// cdp-probe.mjs —— 探查 Codex 桌面应用 DOM 结构（Phase 7 前期）
//
// 用途：连接 http://127.0.0.1:9229/json 列出的 page WebSocket，
//       通过 CDP Runtime.evaluate 读取：
//         * document.title / body.innerText（会话标题、侧边栏分类）
//         * 关键交互元素（输入框 textarea/div[contenteditable]、会话列表项）
//       输出结构供 cdp_client.mjs 的枚举/切换/注入选择器参考。
//
// 用法：node scripts/cdp-probe.mjs [pageIndex] [expression]
//       默认 pageIndex=0（主界面），默认 expression 读取 body 结构
// ============================================================
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:9229';
const pageIndex = parseInt(process.argv[2] || '0', 10);
const expr = process.argv[3] ||
    `JSON.stringify({
        title: document.title,
        url: location.href,
        bodyText: document.body ? document.body.innerText.slice(0, 1500) : '',
    }, null, 1)`;

const pages = await fetch(`${BASE}/json`).then((r) => r.json());
console.log(`[CDP] ${pages.length} pages:`);
pages.forEach((p, i) => console.log(`  [${i}] ${p.title} | ${p.url}`));

if (pages.length === 0) {
    console.error('❌ 无 page（Codex 桌面未启动？）');
    process.exit(1);
}
const target = pages[pageIndex] || pages[0];
console.log(`\n[CDP] connecting to: ${target.webSocketDebuggerUrl}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
}

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
    }
});

ws.on('open', async () => {
    try {
        const res = await send('Runtime.evaluate', {
            expression: expr,
            returnByValue: true,
        });
        if (res.exceptionDetails) {
            console.error('[CDP] exception:', JSON.stringify(res.exceptionDetails, null, 1));
        } else {
            console.log('\n[CDP] result:');
            console.log(res.result.value);
        }
    } catch (e) {
        console.error('[CDP] ❌', e.message);
    } finally {
        ws.close();
        process.exit(0);
    }
});

ws.on('error', (e) => {
    console.error('[CDP] ws error:', e.message);
    process.exit(1);
});

setTimeout(() => {
    console.error('[CDP] timeout');
    process.exit(1);
}, 10000);
