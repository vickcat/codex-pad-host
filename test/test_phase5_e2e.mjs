// ============================================================
// test_phase5_e2e.mjs —— Phase 5 端到端验收（模拟设备视角）
//
// 前提：server.mjs 已启动（node src/server.mjs）
//
// 流程：
//   1. UDP 发现 → WS 连接 → hello → 期望收到 agent_list（Agent 池）
//   2. transcript_confirm 不带 agentId → 默认投递 agent-1(codex)
//      → 期望收到 transcript_ack + agent_state_update（真实 CLI 未就绪时走 error 路径）
//   3. transcript_confirm agentId=agent-3(mock) "创建一个 hello world 函数"
//      → 期望收到 thinking → running → done 完整状态流
//   4. agent_list_request / agent_select 验证
//
// 运行：node test/test_phase5_e2e.mjs
// ============================================================
import dgram from 'dgram';
import WebSocket from 'ws';
import crypto from 'crypto';
import { config } from '../src/config.mjs';

const secret = process.env.LAN_SHARED_SECRET || config.sharedSecret;
const udpPort = config.udpPort;
const DEVICE_ID = 'phase5-e2e-mock';

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
        sock.on('message', (msg, rinfo) => {
            if (done) return;
            let data;
            try { data = JSON.parse(msg.toString('utf8')); } catch { return; }
            if (data.type !== 'discovery_reply') return;
            const payload = `${data.hostId}:${data.wsPort}:${data.counter}`;
            if (sign(payload) !== data.signature) { console.error('sig mismatch'); return; }
            done = true; clearTimeout(timeout); sock.close();
            resolve(data);
        });
        const counter = Math.floor(Date.now() / 1000) % 100000;
        const payload = `${DEVICE_ID}:${counter}`;
        const discovery = JSON.stringify({ type: 'discovery', deviceId: DEVICE_ID, counter, signature: sign(payload) });
        sock.send(discovery, udpPort, '255.255.255.255');
        sock.send(discovery, udpPort, '127.0.0.1');   // Windows 广播不回环，补单播
    });
}

async function main() {
    console.log(`[e2e] device=${DEVICE_ID} 开始 Phase 5 端到端验收\n`);

    // 1. 发现 + 连接 + hello
    const info = await discover();
    console.log(`[e2e] UDP 发现成功: host=${info.host} wsPort=${info.wsPort}`);
    const ws = new WebSocket(`ws://${info.host}:${info.wsPort}`);

    const inbox = [];          // 所有消息（含广播）
    const waiters = [];        // {type, resolve}
    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        inbox.push(msg);
        const w = waiters.find((x) => x.type === msg.type);
        if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    });
    const waitFor = (type, timeoutMs = 15000) => new Promise((resolve) => {
        const hit = inbox.find((m) => m.type === type);
        if (hit) return resolve(hit);
        const w = { type, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(null); }, timeoutMs);
    });

    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', deviceId: DEVICE_ID, fw: 'e2e-0.5.0' }));

    const helloAck = await waitFor('hello_ack');
    check('hello_ack 收到', !!helloAck);

    const agentList1 = await waitFor('agent_list');
    check('hello 后收到 agent_list', !!agentList1 && Array.isArray(agentList1.agents));
    if (agentList1) {
        console.log(`  ℹ️ Agent 池: ${agentList1.agents.map((a) => `${a.agentId}(${a.type}/${a.name})`).join(', ')}`);
        check('Agent 池 ≥3 个', agentList1.agents.length >= 3);
        check('agent-3 为 mock', agentList1.agents.find((a) => a.agentId === 'agent-3')?.type === 'mock');
    }

    // 2. 默认投递（不带 agentId → agent-1 codex，真实 CLI 执行长任务）
    console.log('\n[2] transcript_confirm 默认投递 → agent-1(codex)');
    ws.send(JSON.stringify({ type: 'transcript_confirm', text: '创建一个 hello world 函数' }));
    const ack1 = await waitFor('transcript_ack', 8000);
    check('transcript_ack 立即返回 ok=true', ack1?.ok === true);
    check('ack 带 agentId=agent-1', ack1?.agentId === 'agent-1');
    // 收集 agent-1 状态流：先验证投递成功（出现 thinking），再尽力等待 done（长任务 ≤120s）
    const st1 = await new Promise((resolve) => {
        const samples = [];
        const t0 = Date.now();
        const timer = setInterval(() => {
            const hits = inbox.filter((m) => m.type === 'agent_state_update' && m.agentId === 'agent-1');
            for (const h of hits) samples.push(h.state);
            const last = samples[samples.length - 1];
            if ((last && last.status === 'done') || Date.now() - t0 > 45000) {
                clearInterval(timer);
                resolve({ samples, last });
            }
        }, 100);
    });
    check('收到 agent_state_update(agent-1)', st1.samples.length > 0);
    const statuses1 = [...new Set(st1.samples.map((s) => s.status))];
    console.log(`  ℹ️ agent-1 状态流: ${statuses1.join(' → ')}`);
    check('agent-1 已开始执行（出现 thinking）', statuses1.includes('thinking'));
    const hasRealText = st1.samples.some((s) => s.lastText && s.lastText !== '开始思考…' && s.lastText !== '提交指令…');
    check('agent-1 收到真实模型输出文本', hasRealText);
    if (st1.last) {
        console.log(`  ℹ️ agent-1 最新状态: ${st1.last.status} — ${(st1.last.lastText || '').slice(0, 90)}`);
        if (st1.last.status === 'done') console.log(`  ℹ️ agent-1 已完成: ${st1.last.lastText.slice(0, 120)}`);
        else console.log(`  ⏳ agent-1 仍在执行（真实 codex 长任务，结果通过后续 agent_state_update 持续推送）`);
    }

    // 3. mock Agent 完整成功链路（验收标准场景）
    console.log('\n[3] transcript_confirm → agent-3(mock) "创建一个 hello world 函数"');
    const seenStates = [];
    const stateListener = (msg) => {
        if (msg.type === 'agent_state_update' && msg.agentId === 'agent-3') seenStates.push(msg.state);
    };
    // 在发送前挂监听（waitFor 的广播轮询不够实时，直接 push 到 inbox 已有）
    ws.send(JSON.stringify({ type: 'transcript_confirm', agentId: 'agent-3', text: '创建一个 hello world 函数' }));
    const ack2 = await waitFor('transcript_ack', 10000);
    check('transcript_ack ok=true', ack2?.ok === true);

    const done = await waitFor('agent_state_update', 15000);
    // 等待 mock 完整跑完（约 3.2s），收集所有状态
    const collect = await new Promise((resolve) => {
        const samples = [];
        const t0 = Date.now();
        const timer = setInterval(() => {
            const hits = inbox.filter((m) => m.type === 'agent_state_update' && m.agentId === 'agent-3');
            for (const h of hits) samples.push(h.state);
            if (Date.now() - t0 > 6000) { clearInterval(timer); resolve(samples); }
        }, 100);
    });
    const statuses = [...new Set(collect.map((s) => s.status))];
    console.log(`  ℹ️ 状态流: ${statuses.join(' → ')}`);
    check('状态流包含 thinking', statuses.includes('thinking'));
    check('状态流包含 running', statuses.includes('running'));
    check('状态流包含 done', statuses.includes('done'));
    const lastState = collect[collect.length - 1];
    check('done 状态有输出文本', lastState?.status === 'done' && (lastState.lastText || '').length > 0);
    if (lastState) console.log(`  ℹ️ agent-3 最终输出: ${lastState.lastText.slice(0, 120)}`);

    // 4. agent_list_request / agent_select
    console.log('\n[4] agent 管理消息');
    ws.send(JSON.stringify({ type: 'agent_list_request' }));
    const list2 = await waitFor('agent_list', 8000);
    check('agent_list_request → agent_list', !!list2);
    ws.send(JSON.stringify({ type: 'agent_select', agentId: 'agent-3' }));
    const sel = await waitFor('agent_state', 8000);
    check('agent_select → agent_state(agent-3)', !!sel && sel.agentId === 'agent-3' && sel.state?.status === 'done');

    console.log(`\n========== E2E 结果: ${passed} 通过, ${failed} 失败 ==========`);
    ws.close();
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error('[e2e] FAILED:', err.message);
    process.exit(1);
});
