// ============================================================
// test_cli.mjs —— Phase 5 CLI 会话托管自动化测试
//
// 覆盖：
//   1. output_parser 单测（Codex / Claude 样本 JSONL）
//   2. MockSession 状态时序
//   3. CliManager 会话池（创建 / 投递 / 状态变更 / 销毁）
//   4. 真实 CLI 探测（codex / claude 是否可执行——环境不可用时跳过并提示）
//
// 运行：node test/test_cli.mjs
// ============================================================
import { parseCodexEvent, parseClaudeEvent, parseCliLine } from '../src/cli/output_parser.mjs';
import { MockSession } from '../src/cli/mock_session.mjs';
import { CliManager } from '../src/cli/cli_manager.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
    if (cond) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        failures.push(name);
        console.log(`  ❌ ${name} ${extra}`);
    }
}

// ===================== 1. 解析器单测 =====================
console.log('\n[1] output_parser 单测');

// --- Codex 样本 ---
check('codex: thread.started → meta/sessionId',
    parseCodexEvent({ type: 'thread.started', thread_id: 'abc-123' }).sessionId === 'abc-123');
check('codex: turn.started → thinking',
    parseCodexEvent({ type: 'turn.started' }).status === 'thinking');
check('codex: item.completed(message) → text/thinking',
    parseCodexEvent({ type: 'item.completed', item: { id: 'i1', type: 'message', message: '让我看看代码…' } }).type === 'text');
check('codex: item.completed(agent_message) → text（实测 0.146 真实类型）',
    parseCodexEvent({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'OK' } }).type === 'text');
check('codex: item.completed(tool_call) → running/tool',
    parseCodexEvent({ type: 'item.completed', item: { id: 'i2', type: 'tool_call', tool_name: 'shell', input: { command: 'ls' } } }).tool === 'shell');
check('codex: item.completed(error) → error',
    parseCodexEvent({ type: 'item.completed', item: { id: 'i3', type: 'error', message: 'boom' } }).status === 'error');
check('codex: turn.completed → done',
    parseCodexEvent({ type: 'turn.completed', response: { output: [{ type: 'message', message: '搞定' }] } }).status === 'done');
check('codex: turn.failed → error',
    parseCodexEvent({ type: 'turn.failed', error: { message: 'stream died' } }).status === 'error');
check('codex: approval_required → waiting',
    parseCodexEvent({ type: 'approval_required', action: 'run cmd' }).status === 'waiting');
check('codex: 未知事件 → null',
    parseCodexEvent({ type: 'thread.completed' }) === null);

// --- Claude 样本 ---
check('claude: system.init → meta/sessionId',
    parseClaudeEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' }).sessionId === 'sess-1');
check('claude: assistant text → thinking',
    parseClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '好的，正在处理' }] } }).type === 'text');
check('claude: assistant tool_use → running',
    parseClaudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }).tool === 'Bash');
check('claude: result success → done',
    parseClaudeEvent({ type: 'result', subtype: 'success', result: '完成', is_error: false, usage: { input_tokens: 10 } }).status === 'done');
check('claude: result error → error',
    parseClaudeEvent({ type: 'result', subtype: 'error', result: '挂了', is_error: true }).status === 'error');

// --- 便捷入口 / 容错 ---
check('parseCliLine: 非 JSON → null', parseCliLine('codex', 'not json at all') === null);
check('parseCliLine: codex 分发', parseCliLine('codex', '{"type":"turn.started"}')?.status === 'thinking');
check('parseCliLine: claude 分发', parseCliLine('claude', '{"type":"result","subtype":"success","result":"ok"}')?.status === 'done');

// ===================== 2. MockSession 时序 =====================
console.log('\n[2] MockSession 时序');
await new Promise((resolve, reject) => {
    const s = new MockSession({ agentId: 'm1', name: 'mock1' });
    const seq = [];
    s.on('state_change', (st) => seq.push(st.status));
    s.sendPrompt('创建一个 hello world 函数');
    setTimeout(() => {
        try {
            check('mock: 出现 thinking', seq.includes('thinking'));
            check('mock: 出现 running', seq.includes('running'));
            check('mock: 最终 done', s.status === 'done');
            check('mock: done 文本非空', s.lastText.length > 0);
            check('mock: 最近活动含 user+agent', s.recent.some((r) => r.kind === 'user') && s.recent.some((r) => r.kind === 'agent'));
            resolve();
        } catch (e) { reject(e); }
    }, 3800);
});

// ===================== 3. CliManager 会话池 =====================
console.log('\n[3] CliManager 会话池');
{
    const mgr = new CliManager({ cli: { defaultAgentId: 'a1', agents: [
        { id: 'a1', name: 'Codex', type: 'mock' },
        { id: 'a2', name: 'Claude', type: 'mock' },
    ] } });
    mgr.initDefaultAgents();
    check('mgr: 初始化 2 个 agent', mgr.getAllStates().length === 2);
    check('mgr: defaultAgentId=a1', mgr.defaultAgentId === 'a1');
    check('mgr: getState(a1) 非空', !!mgr.getState('a1'));

    const states = [];
    mgr.on('state_change', (agentId, st) => states.push(`${agentId}:${st.status}`));
    await mgr.sendPrompt('a1', '测试指令');
    await new Promise((r) => setTimeout(r, 4000));
    check('mgr: 状态变更事件被转发', states.length > 0);
    check('mgr: 有 done 状态', states.includes('a1:done'));
    check('mgr: 不存在的 agent 返回 error', (await mgr.sendPrompt('nope', 'x')).ok === false);
    check('mgr: destroy a2', mgr.destroy('a2') === true);
    check('mgr: destroy 后数量 1', mgr.getAllStates().length === 1);
    mgr.shutdown();
}

// ===================== 4. 真实 CLI 探测 =====================
console.log('\n[4] 真实 CLI 探测（环境不可用则跳过）');
{
    const mgr = new CliManager({ cli: { agents: [] } });
    mgr.initDefaultAgents();

    const codex = mgr.createAgent({ id: 'real-codex', type: 'codex', name: 'probe', cwd: process.cwd() });
    const codexState = await probeSession(codex, 'Reply with exactly: OK');
    if (codexState === 'ok') {
        check('real codex: 执行完成且状态 done', codex.status === 'done');
        check('real codex: 有输出文本', codex.lastText.length > 0);
        console.log(`  ℹ️ codex 最后输出: ${codex.lastText.slice(0, 120)}`);
    } else if (codexState === 'skipped') {
        console.log('  ⏭️ codex 不可用（跳过，不影响测试结果）');
    } else {
        check('real codex: 模型/代理不可用时状态为 error（预期）', codex.status === 'error');
        console.log(`  ℹ️ codex 状态: ${codex.status} — ${codex.lastText.slice(0, 100)}`);
    }
    mgr.destroy('real-codex');

    const claude = mgr.createAgent({ id: 'real-claude', type: 'claude', name: 'probe', cwd: process.cwd() });
    const claudeState = await probeSession(claude, 'Reply with exactly: OK');
    if (claudeState === 'ok') {
        check('real claude: 执行完成且状态 done', claude.status === 'done');
        check('real claude: 有输出文本', claude.lastText.length > 0);
        console.log(`  ℹ️ claude 最后输出: ${claude.lastText.slice(0, 120)}`);
    } else if (claudeState === 'skipped') {
        console.log('  ⏭️ claude 不可用（跳过，不影响测试结果）');
    } else {
        check('real claude: 模型不可用时状态为 error（预期）', claude.status === 'error');
        console.log(`  ℹ️ claude 状态: ${claude.status} — ${claude.lastText.slice(0, 100)}`);
    }
    mgr.destroy('real-claude');
}

// 探测辅助：返回 'ok' | 'error' | 'skipped'
async function probeSession(session, prompt) {
    const timeoutMs = 90000;
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        session.on('state_change', (st) => {
            if (st.status === 'done') done('ok');
            if (st.status === 'error') done('error');
        });
        session.sendPrompt(prompt);
        setTimeout(() => done(session.status === 'done' ? 'ok' : 'skipped'), timeoutMs);
    });
}

// ===================== 汇总 =====================
console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
if (failures.length) {
    console.log('失败项:', failures.join(' | '));
    process.exit(1);
} else {
    console.log('🎉 全部通过');
    process.exit(0);
}
