// ============================================================
// test_phase7_e2e.mjs —— Phase 7 端到端验收（Codex 深度集成）
//
// 前提：server.mjs 已启动（node src/server.mjs），且 Codex 桌面
//       已开 CDP 9229（codex++ --debug-port 9229）。
//
// 验收点（对应开发计划 Phase 7）：
//   1. hello → agent_list：会话列表来自 CDP（含 target 字段）
//   2. agent_list_request → 会话列表（≥1，标题可读）
//   3. agent_select → CDP 切换会话（真实 Codex 界面激活会话变化）
//   4. transcript_confirm → CDP 注入（输入框填入 + 发送）
//   5. 注入后会话状态更新（running 标记）
//   6. TargetRouter 降级：无 CDP 时 generic 剪贴板注入
//
// 运行：node test/test_phase7_e2e.mjs
// ============================================================
import dgram from 'dgram';
import WebSocket from 'ws';
import crypto from 'crypto';
import { config } from '../src/config.mjs';
import { CodexController } from '../src/codex/cdp_client.mjs';

const secret = process.env.LAN_SHARED_SECRET || config.sharedSecret;
const udpPort = config.udpPort;
const DEVICE_ID = 'phase7-e2e-mock';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function discover() {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        let done = false;
        const timeout = setTimeout(() => { if (!done) { done = true; sock.close(); reject(new Error('UDP discovery timeout')); } }, 8000);
        sock.on('message', (msg) => {
            if (done) return;
            let data;
            try { data = JSON.parse(msg.toString('utf8')); } catch { return; }
            if (data.type !== 'discovery_reply') return;
            const payload = `${data.hostId}:${data.wsPort}:${data.counter}`;
            if (sign(payload) !== data.signature) return;
            done = true; clearTimeout(timeout); sock.close();
            resolve(data);
        });
        const counter = Math.floor(Date.now() / 1000) % 100000;
        const payload = `${DEVICE_ID}:${counter}`;
        const discovery = JSON.stringify({ type: 'discovery', deviceId: DEVICE_ID, counter, signature: sign(payload) });
        sock.send(discovery, udpPort, '255.255.255.255');
        sock.send(discovery, udpPort, '127.0.0.1');
    });
}

async function main() {
    console.log(`[e2e] device=${DEVICE_ID} 开始 Phase 7 端到端验收\n`);

    // ===== 0. 检测 Codex CDP 是否可用 =====
    let cdpOk = false;
    try {
        const c = new CodexController();
        await c.connect();
        cdpOk = true;
        await c.close();
        console.log('[e2e] ✅ Codex CDP 9229 在线（真实集成模式）');
    } catch {
        console.log('[e2e] ⚠️ Codex CDP 9229 离线（降级模式：断言 generic 兜底）');
    }

    const info = await discover();
    console.log(`[e2e] UDP 发现成功: host=${info.host} wsPort=${info.wsPort}`);
    const ws = new WebSocket(`ws://${info.host}:${info.wsPort}`);

    const inbox = [];
    const waiters = [];
    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        inbox.push(msg);
        const w = waiters.find((x) => x.type === msg.type);
        if (w) {
            waiters.splice(waiters.indexOf(w), 1);
            const i = inbox.indexOf(msg);
            if (i >= 0) inbox.splice(i, 1);
            w.resolve(msg);
        }
    });
    const waitFor = (type, timeoutMs = 15000) => new Promise((resolve) => {
        const idx = inbox.findIndex((m) => m.type === type);
        if (idx >= 0) return resolve(inbox.splice(idx, 1)[0]);
        const w = { type, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(null); }, timeoutMs);
    });

    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', deviceId: DEVICE_ID, fw: 'e2e-0.7.0' }));

    // ===== 1. hello → agent_list（CDP 会话） =====
    const helloAck = await waitFor('hello_ack');
    check('hello_ack 收到', !!helloAck);
    const list1 = await waitFor('agent_list');
    check('hello 后收到 agent_list', !!list1 && Array.isArray(list1.agents));
    if (list1) {
        console.log(`  ℹ️ 会话列表: ${list1.agents.map((a) => `${a.agentId}(${a.target}/${a.name})`).join(', ')}`);
        check('会话数 ≥1', list1.agents.length >= 1);
        if (cdpOk) {
            // 真实 CDP 模式：会话来自 Codex（target=codex）+ 可能含追加目标（target-wb）
            const codexOnes = list1.agents.filter((a) => a.target === 'codex');
            const hasExtra = list1.agents.some((a) => a.target !== 'codex');
            check('含 Codex 会话（CDP 深控）', codexOnes.length >= 1);
            check('会话含标题（name 字段）', codexOnes.every((a) => a.name && a.name.length > 0));
            console.log(`  ℹ️ 追加目标卡: ${hasExtra ? list1.agents.filter((a) => a.target !== 'codex').map((a) => a.name).join(',') : '无'}`);
        } else {
            // 降级模式：generic 单目标
            check('降级为 generic 单目标', list1.agents.length === 1 && list1.agents[0].target === 'generic');
        }
    }

    // ===== 2. agent_list_request =====
    console.log('\n[2] agent_list_request');
    ws.send(JSON.stringify({ type: 'agent_list_request' }));
    const list2 = await waitFor('agent_list', 8000);
    check('agent_list_request → agent_list', !!list2 && Array.isArray(list2.agents) && list2.agents.length >= 1);
    check('会话含 running 状态字段（固件状态色）', !!list2?.agents?.every((a) => typeof a.running === 'boolean'));

    // ===== 3. agent_select 切换（真实 CDP 模式） =====
    if (cdpOk && list2?.agents?.length >= 2) {
        console.log('\n[3] agent_select CDP 切换会话');
        const before = await getActiveTitle();
        // ⚠️ 选与会话激活标题不同的 Codex 会话（否则标题不变，切换无法验证）
        const candidates = list2.agents.filter((a) => a.target === 'codex' && a.name !== before);
        const target = candidates.length ? candidates[0] : list2.agents[1];
        ws.send(JSON.stringify({ type: 'agent_select', agentId: target.agentId }));
        await new Promise((r) => setTimeout(r, 1500));
        const after = await getActiveTitle();
        console.log(`  ℹ️ 激活会话: "${before}" → "${after}"（目标=${target.agentId}）`);
        check('CDP 切换会话成功（激活标题变化）', !!after && after.length > 0 && after !== before);
    } else {
        console.log('\n[3] 跳过 agent_select（CDP 离线或无 ≥2 会话）');
    }

    // ===== 4. transcript_confirm 注入 =====
    console.log('\n[4] transcript_confirm 注入');
    const testText = `外设E2E测试 ${Date.now() % 100000}`;
    ws.send(JSON.stringify({ type: 'transcript_confirm', agentId: 's-1', text: testText }));
    const ack = await waitFor('transcript_ack', 15000);
    check('transcript_ack 收到', !!ack);
    check('注入成功 (ok=true)', ack?.ok === true);
    if (ack) console.log(`  ℹ️ 注入结果: phase=${ack.phase}`);

    // ===== 5. 注入后会话状态（CDP 模式：输入框/运行） =====
    if (cdpOk) {
        console.log('\n[5] 注入后 Codex 状态');
        const active = await getActiveTitle();
        console.log(`  ℹ️ 当前激活会话: "${active}"`);
        // ⚠️ Phase 8.2（2026-08-16）：transcript_confirm = 发送（cdp_sent/clipboard_sent），
        //    注入在 transcript 回传时已自动完成（cdp_pasted）
        check('CDP 发送链路完成（回车提交）', ack?.phase === 'cdp_sent' || ack?.phase === 'clipboard_sent');
    }

    console.log(`\n========== Phase 7 E2E 结果: ${passed} 通过, ${failed} 失败 ==========`);
    ws.close();
    process.exit(failed ? 1 : 0);
}

// 读取 Codex 当前激活会话标题（真实 CDP）
async function getActiveTitle() {
    try {
        const c = new CodexController();
        await c.connect();
        const t = await c.getActiveTitle();
        await c.close();
        return t;
    } catch {
        return '';
    }
}

main().catch((err) => {
    console.error('[e2e] FAILED:', err.message);
    process.exit(1);
});
