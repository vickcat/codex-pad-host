// ============================================================
// test_ws.mjs —— WebSocket 服务器自动化测试（Phase 3）
//
// 跳过 UDP，直接连接 WS 验证 hello/ping/echo 三件事。
// 用法：先启动 server（npm start），再 node test/test_ws.mjs
// ============================================================
import WebSocket from 'ws';
import { config } from '../src/config.mjs';

const url = `ws://127.0.0.1:${config.wsPort}`;
const results = [];

function check(name, cond) {
    results.push({ name, pass: !!cond });
    console.log(`${cond ? '✓' : '✗'} ${name}`);
}

function waitMessage(ws, type, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting ${type}`)), timeoutMs);
        const onMsg = (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === type) {
                clearTimeout(timer);
                ws.off('message', onMsg);
                resolve(msg);
            }
        };
        ws.on('message', onMsg);
    });
}

const ws = new WebSocket(url);

ws.on('open', async () => {
    console.log(`[test] connected ${url}`);

    try {
        // 1. hello → hello_ack
        const ackP = waitMessage(ws, 'hello_ack');
        ws.send(JSON.stringify({ type: 'hello', deviceId: 'test-device', fw: 'test' }));
        const ack = await ackP;
        check('hello → hello_ack', ack.hostId && ack.serverTime);

        // 2. ping → pong
        const pongP = waitMessage(ws, 'pong');
        ws.send(JSON.stringify({ type: 'ping', t: 12345 }));
        const pong = await pongP;
        check('ping → pong', pong.t === 12345);

        // 3. echo_test → echo_reply
        const echoP = waitMessage(ws, 'echo_reply');
        ws.send(JSON.stringify({ type: 'echo_test', msg: 'ping-echo-check' }));
        const echo = await echoP;
        check('echo_test → echo_reply', echo.msg === 'ping-echo-check');

        // 4. 未知类型 → error
        const errP = waitMessage(ws, 'error');
        ws.send(JSON.stringify({ type: 'bogus' }));
        const err = await errP;
        check('unknown type → error', err.code === 'UNKNOWN_TYPE');
    } catch (e) {
        check(`exception: ${e.message}`, false);
    }

    ws.close();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n[test] ${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
});

ws.on('error', (err) => {
    console.error('[test] connection error:', err.message);
    console.error('      请先启动 server：npm start');
    process.exit(1);
});
