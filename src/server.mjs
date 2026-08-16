// ============================================================
// server.mjs —— 主机桥接服务主入口（Phase 7：Codex 深度集成）
//
// 功能：
//   1. UDP 局域网发现 beacon（8766）
//   2. WebSocket 服务器（8765）：
//      * hello 握手 / ping-pong / echo 测试
//      * voice_start / voice_end + 二进制 PCM 帧 → ASR 转写 → transcript 回传
//      * transcript_confirm → TargetRouter 注入（Codex CDP / 剪贴板）
//      * agent_list_request / agent_select（Codex 会话切换）/ agent_create / agent_destroy
//      * 会话状态变更实时推送（agent_state_update）
//   3. TargetRouter：Codex CDP 深控（会话枚举/切换/注入）+ 剪贴板注入兜底
//
// ASR 提供商：config.asr.provider = volcengine | mock
// 目标应用：config.target.app = codex | generic（Phase 7）
// ============================================================
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { config } from './config.mjs';
import { HmacAuth } from './discovery/hmac_auth.mjs';
import { UdpBeacon } from './discovery/udp_beacon.mjs';
import { AsrVolcengine } from './audio/asr_volcengine.mjs';
import { CliManager } from './cli/cli_manager.mjs';
import { TextInjector } from './inject/text_injector.mjs';
import { TargetRouter } from './target/target_router.mjs';

const auth = new HmacAuth(config.sharedSecret);

// ---- ASR 引擎（provider 切换） ----
const asr = config.asr.provider === 'mock'
    ? {
        ready: true,
        async transcribe(pcm) {
            // 模拟转写：把音频时长和大小回显，验证链路
            const dur = (pcm.length / 2 / 16000).toFixed(1);
            return { text: `[mock] 收到音频 ${dur}s (${(pcm.length / 1024).toFixed(0)}KB)，接入真实凭证后这里显示转写文本`, durationMs: Math.round(dur * 1000) };
        },
      }
    : new AsrVolcengine(config.asr);

// ---- CLI 会话池（Phase 5，Phase 7 降级为 debug 兜底） ----
const cliManager = new CliManager(config);
cliManager.initDefaultAgents();
console.log(`[CLI] Agent 池初始化: ${cliManager.getAllStates().map((s) => `${s.agentId}(${s.type}/${s.name})`).join(', ')}`);

// ---- 文本注入器（投递模式 = inject 时启用） ----
const injector = config.delivery.mode === 'inject' ? new TextInjector() : null;

// ---- 目标应用路由（Phase 7：Codex CDP 深控 / 剪贴板注入兜底） ----
const router = new TargetRouter(config);
router.start().catch((e) => console.warn('[Router] start 失败:', e.message));

// 会话列表变化 → 广播（驱动设备屏幕 4 卡刷新）
router.on('sessions', (sessions) => {
    console.log(`[Router] sessions 变化 → 广播 ${sessions.length} 个会话`);
    broadcast(JSON.stringify({ type: 'agent_list', agents: sessions }));
});

// ⚠️ 2026-08-16：CDP 状态变化 → 广播（设备端提示"Codex 未连接/已连接"）
//    设备端当前忽略未知消息类型（安全）；配合固件 toast 后可直接显示
router.on('status', (st) => {
    console.log(`[Router] status: codex=${st.codex}${st.message ? ' ' + st.message : ''}`);
    broadcast(JSON.stringify({ type: 'system_status', codex: st.codex, message: st.message || '' }));
});

// ---- 设备状态变更 → 广播到所有在线设备（Phase 5 CLI 池，debug 用） ----
cliManager.on('state_change', (agentId, state) => {
    const payload = JSON.stringify({ type: 'agent_state_update', agentId, state });
    broadcast(payload);
    const brief = `${state.status}${state.lastTool ? `/${state.lastTool}` : ''} "${(state.lastText || '').slice(0, 40)}"`;
    console.log(`[CLI] state_change ${agentId}: ${brief}`);
});

function broadcast(raw) {
    wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(raw);
    });
}

const TMP = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../tmp');
fs.mkdirSync(TMP, { recursive: true });

// ===================== WebSocket 服务器 =====================
const wss = new WebSocketServer({ port: config.wsPort });
const devices = new Map();   // ws -> {deviceId, lastSeen}

// 每连接录音状态
const audioState = new Map(); // ws -> {recording, chunks[], agentId}

wss.on('listening', () => {
    console.log(`[WS] server listening on :${config.wsPort}`);
});

wss.on('connection', (ws, req) => {
    const addr = req.socket.remoteAddress;
    console.log(`[WS] device connected: ${addr}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    audioState.set(ws, { recording: false, chunks: [], agentId: null });

    ws.on('message', async (data, isBinary) => {
        if (isBinary) {
            handleAudioFrame(ws, data);
            return;
        }
        handleMessage(ws, data.toString());
    });

    ws.on('close', () => {
        audioState.delete(ws);
        const d = devices.get(ws);
        if (d) {
            console.log(`[WS] device disconnected: ${d.deviceId} (${addr})`);
            devices.delete(ws);
        } else {
            console.log(`[WS] device disconnected: ${addr}`);
        }
    });

    ws.on('error', (err) => {
        console.error('[WS] error:', err.message);
    });
});

// ===================== 音频帧处理 =====================
const MAX_AUDIO_BYTES = 16000 * 2 * 60;   // 60s 上限（16k/16bit/单声道）

function handleAudioFrame(ws, data) {
    const st = audioState.get(ws);
    if (!st || !st.recording) return;      // 非录音状态丢弃
    st.chunks.push(Buffer.from(data));
    // 防内存膨胀：超限丢最旧
    let total = st.chunks.reduce((a, c) => a + c.length, 0);
    while (total > MAX_AUDIO_BYTES && st.chunks.length > 1) {
        st.chunks.shift();
        total = st.chunks.reduce((a, c) => a + c.length, 0);
    }
}

// ===================== 消息处理 =====================
function sendJson(ws, obj) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
    }
}

function getDeviceId(ws, msg) {
    return msg.deviceId || (devices.get(ws) || {}).deviceId || 'unknown';
}

async function handleMessage(ws, raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch {
        console.warn('[WS] non-JSON message ignored');
        return;
    }

    const type = msg.type;
    const deviceId = getDeviceId(ws, msg);
    const st = audioState.get(ws);

    switch (type) {
        case 'hello': {
            devices.set(ws, { deviceId, lastSeen: Date.now() });
            console.log(`[WS] hello from ${deviceId} (fw ${msg.fw || '?'})`);
            sendJson(ws, {
                type: 'hello_ack',
                hostId: config.hostId,
                serverTime: Date.now(),
            });
            // 设备上线即推送当前会话列表
            //   TARGET_APP=codex/generic → TargetRouter（Phase 7：CDP 会话 / 剪贴板目标）
            //   TARGET_APP=cli           → CLI 会话池（Phase 5/6 回归）
            const agents = config.target.app === 'cli'
                ? cliManager.getAllStates()
                : await router.listSessions();
            sendJson(ws, { type: 'agent_list', agents });
            break;
        }

        case 'ping': {
            sendJson(ws, { type: 'pong', t: msg.t });
            break;
        }

        case 'echo_test': {
            console.log(`[WS] echo from ${deviceId}: ${msg.msg}`);
            sendJson(ws, {
                type: 'echo_reply',
                msg: msg.msg,
                serverTime: Date.now(),
            });
            break;
        }

        // ===== Phase 4：语音链路 =====
        case 'voice_start': {
            st.recording = true;
            st.chunks = [];
            st.agentId = msg.agentId || null;
            console.log(`[ASR] voice_start from ${deviceId} (agent=${st.agentId})`);
            sendJson(ws, { type: 'voice_start_ack', ok: true });
            break;
        }

        case 'voice_end': {
            if (!st.recording) {
                sendJson(ws, { type: 'error', code: 'NO_RECORDING', message: 'voice_end without voice_start' });
                break;
            }
            st.recording = false;
            const pcm = Buffer.concat(st.chunks);
            const durMs = Math.round(pcm.length / 2 / 16);   // 16k => ms
            console.log(`[ASR] voice_end from ${deviceId}: ${(pcm.length / 1024).toFixed(1)}KB, ${(durMs / 1000).toFixed(1)}s, 转写中...`);

            // ⚠️ Phase 8（2026-08-15）：录音过短（<0.5s，多为误触/未开口）直接跳过 ASR，
            //    避免火山返回 20000003 静音错误 + 浪费请求（用户屏幕出现"ASR失败"）。
            if (durMs < 500) {
                console.warn(`[ASR] ⚠️ 录音太短(${durMs}ms) 跳过 ASR，回传提示`);
                sendJson(ws, { type: 'transcript', text: '', agentId: st.agentId, error: '录音太短，请按住说话' });
                break;
            }

            if (config.asr.saveDebugWav && pcm.length > 44) {
                const wavPath = path.join(TMP, `rec_${Date.now()}.wav`);
                fs.writeFileSync(wavPath, asr.pcmToWav ? asr.pcmToWav(pcm) : wavFromPcm(pcm));
                console.log(`[ASR] debug wav saved: ${wavPath}`);
            }

            try {
                const { text, durationMs } = await asr.transcribe(pcm);
                console.log(`[ASR] ✅ 转写完成 (${durationMs}ms): "${text}"`);

                // ⚠️ Phase 7.5（2026-08-15）：转写完成 → 自动粘贴到目标窗口（不发送），
                //    省掉手动点"粘贴"按钮的等待；用户核对后按 PWR（HID 回车）发送。
                //    cli 模式（Phase 5 回归）不自动注入，仍走 transcript_confirm。
                let autoInjected = false;
                let injectPhase = '';
                let injectError = '';
                if (text && config.target.app !== 'cli') {
                    try {
                        const r = await router.injectText(text, st.agentId || '', false);
                        autoInjected = true;
                        injectPhase = r.phase;
                        console.log(`[TXT] ✅ 自动粘贴 (${r.target}/${r.phase})`);
                    } catch (e) {
                        injectError = e.message;
                        console.warn(`[TXT] ⚠️ 自动粘贴失败: ${e.message}`);
                    }
                }
                sendJson(ws, {
                    type: 'transcript',
                    text,
                    agentId: st.agentId,
                    durationMs,
                    autoInjected,
                    injectPhase,
                    injectError,
                });
            } catch (e) {
                // ⚠️ 2026-08-16：错误带 code 分类（NO_KEY/TOO_SHORT/NETWORK/TIMEOUT/API_xxx），
                //    设备端 toast 可直接显示分类
                const code = e.code || 'UNKNOWN';
                console.error(`[ASR] ❌ [${code}] ${e.message}`);
                sendJson(ws, {
                    type: 'transcript',
                    text: '',
                    agentId: st.agentId,
                    error: e.message,
                    errorCode: code,
                });
            }
            break;
        }

        case 'transcript_confirm': {
            // Phase 7：投递到 TargetRouter（Codex CDP 注入 / 剪贴板注入兜底）
            // Phase 5 兼容：config.delivery.mode=cli 时走 CLI 会话池
            const agentId = msg.agentId || (config.target.app === 'cli'
                ? cliManager.defaultAgentId : 'generic-1');
            const text = (msg.text || '').trim();
            console.log(`[TXT] confirm agent=${agentId} text="${text.slice(0, 80)}"`);

            if (!text) {
                sendJson(ws, { type: 'transcript_ack', ok: false, error: 'empty text' });
                break;
            }

            if (config.delivery.mode === 'inject' || config.target.app !== 'cli') {
                // Phase 8.2：transcript_confirm = "发送"（注入已自动完成，这里只回车提交）
                try {
                    const r = await router.sendEnter(agentId);
                    console.log(`[TXT] ✅ 已发送 (${r.target}/${r.phase}) agent=${agentId}`);
                    sendJson(ws, { type: 'transcript_ack', ok: true, phase: r.phase, agentId });
                } catch (e) {
                    console.error(`[TXT] ❌ 发送失败: ${e.message}`);
                    sendJson(ws, { type: 'transcript_ack', ok: false, phase: 'send_failed', error: e.message });
                }
                break;
            }

            // CLI 托管模式：非阻塞提交（长任务 ack 立即返回，状态经 agent_state_update 推送）
            const result = cliManager.submitPrompt(agentId, text);
            sendJson(ws, {
                type: 'transcript_ack',
                ok: result.ok,
                phase: result.busy ? 'cli_busy' : 'cli_submitted',
                agentId: result.agentId || agentId,
                status: result.status,
                error: result.error,
            });
            break;
        }

        case 'transcript_cancel': {
            // Phase 8.2：撤销最近注入的文字（CDP Ctrl+Z / 剪贴板 Ctrl+Z）
            const agentId = msg.agentId || '';
            console.log(`[TXT] cancel agent=${agentId} → 撤销输入框`);
            try {
                await router.cancelLastInject(agentId);
            } catch (e) {
                console.warn(`[TXT] 撤销失败: ${e.message}`);
            }
            st.chunks = [];
            sendJson(ws, { type: 'transcript_ack', ok: true, phase: 'cancelled' });
            break;
        }

        // ===== Phase 5/7：会话管理 =====
        case 'agent_list_request': {
            const agents = config.target.app === 'cli'
                ? cliManager.getAllStates()
                : await router.listSessions();
            sendJson(ws, { type: 'agent_list', agents });
            break;
        }

        case 'agent_select': {
            // Phase 7：切换 Codex 会话（CDP 点击侧边栏）；cli 模式走 CLI 池；
            //    WorkBuddy 追加目标（target-wb）无需切换（剪贴板注入到前台）
            const agentId = msg.agentId;
            if (config.target.app !== 'cli' && agentId !== 'target-wb') {
                try {
                    await router.selectSession(agentId);
                    console.log(`[AGENT] select ${agentId} (CDP 切换)`);
                } catch (e) {
                    console.warn(`[AGENT] select ${agentId} 失败: ${e.message}`);
                }
                // 切换后回推当前会话列表（设备端刷新）
                sendJson(ws, { type: 'agent_list', agents: await router.listSessions() });
            } else if (agentId === 'target-wb') {
                console.log('[AGENT] select target-wb (剪贴板注入目标，无需切换)');
            } else {
                const state = cliManager.getState(agentId);
                console.log(`[AGENT] select ${agentId}${state ? '' : ' (不存在)'}`);
                sendJson(ws, { type: 'agent_state', agentId, state });
            }
            break;
        }

        case 'agent_create': {
            // ⚠️ 会话类型字段用 agentType（不能用 type——type 是消息类型，会被 JSON 覆盖）
            const def = {
                id: msg.agentId || msg.id,
                type: msg.agentType || 'mock',
                name: msg.name,
                cwd: msg.cwd,
                replyTemplate: msg.replyTemplate,
            };
            if (!def.id) {
                sendJson(ws, { type: 'error', code: 'BAD_ARGS', message: 'agent_create requires agentId' });
                break;
            }
            try {
                const session = cliManager.createAgent(def);
                console.log(`[AGENT] created ${session.agentId} (${session.type}/${session.name})`);
                sendJson(ws, { type: 'agent_state', agentId: session.agentId, state: session.state });
                broadcast(JSON.stringify({ type: 'agent_list', agents: cliManager.getAllStates() }));
            } catch (e) {
                sendJson(ws, { type: 'error', code: 'CREATE_FAILED', message: e.message });
            }
            break;
        }

        case 'agent_destroy': {
            const ok = cliManager.destroy(msg.agentId);
            console.log(`[AGENT] destroy ${msg.agentId} → ${ok ? 'ok' : 'not found'}`);
            broadcast(JSON.stringify({ type: 'agent_list', agents: cliManager.getAllStates() }));
            sendJson(ws, { type: 'transcript_ack', ok, phase: 'agent_destroyed' });
            break;
        }

        default:
            console.log(`[WS] unknown message type: ${type} (from ${deviceId})`);
            sendJson(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `unknown: ${type}` });
            break;
    }
}

// mock 模式下 pcmToWav 不存在时的兜底（同 AsrVolcengine 的实现）
function wavFromPcm(pcm) {
    const b = Buffer.alloc(44 + pcm.length);
    b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(pcm.length, 40); pcm.copy(b, 44);
    return b;
}

// ===================== 心跳检测（服务端探活） =====================
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ===================== UDP 发现 =====================
let beacon = null;
if (config.discoveryEnabled) {
    beacon = new UdpBeacon({
        port: config.udpPort,
        wsPort: config.wsPort,
        hostId: config.hostId,
        auth,
        onDeviceFound: (deviceId, addr) => {
            console.log(`[Discovery] ${deviceId} found @ ${addr}, reply sent`);
        },
    });
    beacon.start();
}

// ===================== 优雅退出 =====================
function shutdown() {
    console.log('\n[Host] shutting down...');
    if (beacon) beacon.stop();
    router.stop().catch(() => {});
    cliManager.shutdown();
    wss.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const asrProvider = config.asr.provider || 'volcengine';
console.log(`[Host] Codex Peripheral Bridge v0.7.0 (hostId=${config.hostId})`);
console.log(`[Host] ASR provider=${asrProvider}${asrProvider === 'volcengine' && !asr.ready ? ' (⚠️ 未配置有效凭证)' : ''}`);
console.log(`[Host] target app=${config.target.app} (codex=CDP 深控 / generic=剪贴板注入)`);
console.log(`[Host] delivery mode=${config.delivery.mode} (inject=注入 / cli=CLI 会话托管)`);
console.log(`[Host] sharedSecret=${config.sharedSecret.slice(0, 8)}... (from config)`);
