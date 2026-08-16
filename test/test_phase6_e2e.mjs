// ============================================================
// test_phase6_e2e.mjs —— Phase 6 端到端验收（多 Agent 管理视角）
//
// 前提：server.mjs 已启动（node src/server.mjs，mock 池可用即可）
//
// 验收点（对应开发计划 Phase 6）：
//   1. hello → agent_list（Agent 池 ≥3，含 name/type/status 字段）
//   2. agent_select 切换 → agent_state 快照
//   3. agent_create → 新增会话 + 广播 agent_list（数量 +1）
//   4. 向 2 个 Agent 并行发指令 → 两条独立状态流（thinking→running→done）
//   5. done 状态带 usage（input_tokens/output_tokens，供固件 Token 显示）
//   6. agent_destroy → agent_list 数量 -1
//
// 运行：node test/test_phase6_e2e.mjs
// ============================================================
import dgram from 'dgram';
import WebSocket from 'ws';
import crypto from 'crypto';
import { config } from '../src/config.mjs';

const secret = process.env.LAN_SHARED_SECRET || config.sharedSecret;
const udpPort = config.udpPort;
const DEVICE_ID = 'phase6-e2e-mock';

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
        sock.send(discovery, udpPort, '127.0.0.1');   // Windows 广播不回环，补单播
    });
}

async function main() {
    console.log(`[e2e] device=${DEVICE_ID} 开始 Phase 6 端到端验收\n`);

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
            if (i >= 0) inbox.splice(i, 1);   // 被 waiter 消费的消息同时移出 inbox
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
    ws.send(JSON.stringify({ type: 'hello', deviceId: DEVICE_ID, fw: 'e2e-0.6.0' }));

    // ===== 1. hello → agent_list =====
    const helloAck = await waitFor('hello_ack');
    check('hello_ack 收到', !!helloAck);
    const list1 = await waitFor('agent_list');
    check('hello 后收到 agent_list', !!list1 && Array.isArray(list1.agents));
    if (list1) {
        console.log(`  ℹ️ Agent 池: ${list1.agents.map((a) => `${a.agentId}(${a.type}/${a.name})`).join(', ')}`);
        check('Agent 池 ≥3 个', list1.agents.length >= 3);
        const hasFields = list1.agents.every((a) => a.agentId && a.name && a.type && a.status);
        check('每项含 agentId/name/type/status 字段（固件渲染必需）', hasFields);
    }

    // ===== 2. agent_select 切换 =====
    console.log('\n[2] agent_select 切换');
    ws.send(JSON.stringify({ type: 'agent_select', agentId: 'agent-2' }));
    const sel = await waitFor('agent_state', 8000);
    check('agent_select → agent_state(agent-2)', !!sel && sel.agentId === 'agent-2' && sel.state?.status);
    console.log(`  ℹ️ agent-2 状态: ${sel?.state?.status} (${sel?.state?.type})`);

    // ===== 3. agent_create 新增 =====
    console.log('\n[3] agent_create 新增会话');
    const beforeCount = (inbox.find((m) => m.type === 'agent_list') || list1).agents.length;
    ws.send(JSON.stringify({ type: 'agent_create', id: 'agent-6', agentType: 'mock', name: 'Agent 6' }));
    const created = await waitFor('agent_state', 8000);
    check('agent_create → agent_state(agent-6)', !!created && created.agentId === 'agent-6');
    // 等广播 agent_list（数量 +1）
    const listAfter = await new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
            const lists = inbox.filter((m) => m.type === 'agent_list' && m.agents.length > beforeCount);
            if (lists.length > 0 || Date.now() - t0 > 6000) { clearInterval(timer); resolve(lists[lists.length - 1] || null); }
        }, 100);
    });
    check('广播 agent_list 数量 +1', !!listAfter && listAfter.agents.length === beforeCount + 1);
    console.log(`  ℹ️ 新增后池: ${(listAfter?.agents || []).map((a) => a.agentId).join(', ')}`);

    // ===== 4. 并行向两个 Agent 发指令（多会话管理核心） =====
    console.log('\n[4] 并行指令 → agent-3 与 agent-6(mock)');
    ws.send(JSON.stringify({ type: 'transcript_confirm', agentId: 'agent-3', text: '任务A: 整理本周开发计划' }));
    ws.send(JSON.stringify({ type: 'transcript_confirm', agentId: 'agent-6', text: '任务B: 生成测试报告' }));
    const ack3 = await waitFor('transcript_ack', 10000);
    check('agent-3 transcript_ack ok', ack3?.ok === true);

    const collectStates = (agentId, timeoutMs) => new Promise((resolve) => {
        const samples = [];
        const t0 = Date.now();
        const timer = setInterval(() => {
            for (const m of inbox) {
                if (m.type === 'agent_state_update' && m.agentId === agentId) {
                    samples.push(m.state);
                }
            }
            if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(samples); }
        }, 100);
    });
    const [st3, st6] = await Promise.all([collectStates('agent-3', 7000), collectStates('agent-6', 7000)]);
    const statuses3 = [...new Set(st3.map((s) => s.status))];
    const statuses6 = [...new Set(st6.map((s) => s.status))];
    console.log(`  ℹ️ agent-3 状态流: ${statuses3.join(' → ') || '(空)'}`);
    console.log(`  ℹ️ agent-6 状态流: ${statuses6.join(' → ') || '(空)'}`);
    check('agent-3 状态流含 thinking→running→done', ['thinking', 'running', 'done'].every((s) => statuses3.includes(s)));
    check('agent-6 状态流含 thinking→running→done', ['thinking', 'running', 'done'].every((s) => statuses6.includes(s)));

    // ===== 5. done 状态带 usage（Token 显示） =====
    const last3 = st3[st3.length - 1];
    check('agent-3 done 状态含 usage(输入/输出)', !!last3?.usage && (last3.usage.input_tokens > 0 || last3.usage.output_tokens > 0));
    if (last3?.usage) console.log(`  ℹ️ agent-3 usage: 输入 ${last3.usage.input_tokens} / 输出 ${last3.usage.output_tokens} tokens`);
    check('状态含 lastText（卡片摘要渲染用）', !!last3?.lastText && last3.lastText.length > 0);
    check('状态含 recent 数组（详情页最近活动用）', Array.isArray(last3?.recent) && last3.recent.length > 0);
    const last6 = st6[st6.length - 1];
    check('agent-6 done 状态含 lastText', !!last6?.lastText && last6.lastText.length > 0);

    // ===== 6. agent_destroy 清理 =====
    console.log('\n[6] agent_destroy 销毁 agent-6');
    ws.send(JSON.stringify({ type: 'agent_destroy', agentId: 'agent-6' }));
    const listFinal = await new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
            const lists = inbox.filter((m) => m.type === 'agent_list');
            const last = lists[lists.length - 1];
            if ((last && last.agents.length === beforeCount) || Date.now() - t0 > 6000) {
                clearInterval(timer); resolve(last);
            }
        }, 100);
    });
    check('销毁后 agent_list 数量恢复', !!listFinal && listFinal.agents.length === beforeCount);

    console.log(`\n========== Phase 6 E2E 结果: ${passed} 通过, ${failed} 失败 ==========`);
    ws.close();
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error('[e2e] FAILED:', err.message);
    process.exit(1);
});
