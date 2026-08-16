// ============================================================
// test_voice.mjs —— 语音全链路测试（模拟设备）
//
// 流程：WS 连接 → hello → voice_start → 发 2s 合成 PCM 帧 → voice_end
//       → 等待 transcript 回传 → 打印结果
//
// 依赖 server 已启动（node src/server.mjs）。
// 用法：node test/test_voice.mjs [ws://host:port]
// ============================================================
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://127.0.0.1:8765';
const ws = new WebSocket(url);

let step = 0;
const log = (s) => console.log(`[test] ${s}`);

function sendJson(obj) {
    ws.send(JSON.stringify(obj));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

ws.on('open', async () => {
    log(`connected to ${url}`);
    sendJson({ type: 'hello', deviceId: 'test-voice-mock', fw: '0.4.0-test' });
    await sleep(300);

    // ---- 2s 合成 PCM（1kHz 扫频） ----
    sendJson({ type: 'voice_start', agentId: 'agent-1' });
    log('voice_start sent');
    await sleep(100);

    const rate = 16000, sec = 2;
    const pcm = Buffer.alloc(sec * rate * 2);
    for (let i = 0; i < sec * rate; i++) {
        pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (400 + 300 * i / (sec * rate)) * i / rate) * 9000), i * 2);
    }
    // 分成 100ms 块发送（模拟设备实时流）
    const chunk = 1600;   // 100ms = 1600 samples = 3200B
    for (let off = 0; off < pcm.length; off += chunk * 2) {
        ws.send(pcm.subarray(off, off + chunk * 2));
        await sleep(20);
    }
    log(`sent ${sec}s PCM in chunks`);

    sendJson({ type: 'voice_end' });
    log('voice_end sent, waiting transcript...');
});

ws.on('message', (data) => {
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
        case 'hello_ack':
            log(`hello_ack hostId=${msg.hostId}`);
            break;
        case 'voice_start_ack':
            log('voice_start_ack OK');
            break;
        case 'transcript': {
            log('────────────────────────────────────');
            if (msg.error) {
                log(`❌ transcript error: ${msg.error}`);
            } else {
                log(`✅ transcript (${msg.durationMs}ms): "${msg.text}"`);
            }
            log('────────────────────────────────────');
            ws.close();
            process.exit(msg.error ? 1 : 0);
            break;
        }
        default:
            break;
    }
});

ws.on('error', (e) => {
    console.error('[test] WS error:', e.message);
    process.exit(1);
});

// 15s 超时兜底
setTimeout(() => {
    console.error('[test] TIMEOUT: 15s 内未收到 transcript');
    process.exit(1);
}, 15000);
