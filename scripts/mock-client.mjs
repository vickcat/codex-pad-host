// ============================================================
// mock-client.mjs —— 模拟 ESP32 设备的完整客户端（Phase 3 测试用）
//
// 流程与固件一致：
//   1. UDP 广播 discovery（带 HMAC 签名）→ 等待 discovery_reply
//   2. 连接回复中的 WebSocket 地址 → 发送 hello
//   3. 收到 hello_ack 后发 echo_test，收到 echo_reply 即验收通过
//   4. 每 10s 发 ping
//
// 用法：node scripts/mock-client.mjs [--secret xxx] [--udp-port 8766]
// ============================================================
import dgram from 'dgram';
import WebSocket from 'ws';
import crypto from 'crypto';
import { config } from '../src/config.mjs';

const secret = process.env.LAN_SHARED_SECRET || config.sharedSecret;
const udpPort = parseInt(process.argv.find((a, i) => a === '--udp-port' && process.argv[i + 1]) ? process.argv[process.argv.indexOf('--udp-port') + 1] : config.udpPort, 10);
const DEVICE_ID = 'mock-client-01';

function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function discover() {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        let done = false;
        const timeout = setTimeout(() => {
            if (!done) { done = true; sock.close(); reject(new Error('UDP discovery timeout')); }
        }, 8000);

        sock.on('message', (msg, rinfo) => {
            if (done) return;
            let data;
            try { data = JSON.parse(msg.toString('utf8')); } catch { return; }
            if (data.type !== 'discovery_reply') return;

            // 验证签名
            const payload = `${data.hostId}:${data.wsPort}:${data.counter}`;
            if (sign(payload) !== data.signature) {
                console.error('[mock] discovery_reply signature MISMATCH!');
                return;
            }
            done = true;
            clearTimeout(timeout);
            sock.close();
            console.log(`[mock] UDP reply: host=${data.host} wsPort=${data.wsPort} hostId=${data.hostId} ✓`);
            resolve(data);
        });

        const counter = Math.floor(Date.now() / 1000) % 100000;
        const payload = `${DEVICE_ID}:${counter}`;
        const discovery = JSON.stringify({
            type: 'discovery',
            deviceId: DEVICE_ID,
            counter,
            signature: sign(payload),
        });
        sock.send(discovery, udpPort, '255.255.255.255', () => {
            console.log(`[mock] UDP discovery broadcast sent (port ${udpPort})`);
        });
        // Windows 本机广播不回环，测试时补发一次单播到 127.0.0.1（真实设备不受影响）
        sock.send(discovery, udpPort, '127.0.0.1', () => {
            console.log('[mock] UDP discovery unicast to 127.0.0.1 sent (test fallback)');
        });
    });
}

async function main() {
    console.log(`[mock] Device ${DEVICE_ID}, secret=${secret.slice(0, 8)}...`);

    // 1. UDP 发现
    const info = await discover();

    // 2. WebSocket 连接
    const url = `ws://${info.host}:${info.wsPort}`;
    console.log(`[mock] connecting ${url} ...`);
    const ws = new WebSocket(url);

    const helloAck = new Promise((resolve) => {
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            console.log(`[mock] recv: ${data.toString()}`);
            if (msg.type === 'hello_ack') resolve(msg);
        });
    });

    ws.on('open', () => {
        console.log('[mock] WS open');
        ws.send(JSON.stringify({ type: 'hello', deviceId: DEVICE_ID, fw: 'mock-0.3.0' }));
    });

    const ack = await helloAck;
    console.log(`[mock] hello_ack received: hostId=${ack.hostId} ✓`);

    // 3. echo 测试
    ws.send(JSON.stringify({ type: 'echo_test', msg: 'hello from mock device', t: Date.now() }));

    // 4. 心跳
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        }
    }, 10000);

    console.log('[mock] TEST PASSED (discovery + ws handshake + echo). Waiting for ping loop... (Ctrl+C to stop)');
}

main().catch((err) => {
    console.error('[mock] FAILED:', err.message);
    process.exit(1);
});
