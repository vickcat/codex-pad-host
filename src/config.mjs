// ============================================================
// config.mjs —— 配置加载（Phase 3）
//
// 读取顺序：config.env 文件 > 环境变量 > 默认值
// ============================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
    const envFile = path.join(ROOT, 'config.env');
    if (!fs.existsSync(envFile)) return {};
    const vars = {};
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return vars;
}

const env = { ...loadDotEnv(), ...process.env };

const hostname = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 16);

export const config = {
    wsPort: parseInt(env.LAN_VOICE_PORT || '8765', 10),
    udpPort: parseInt(env.LAN_DISCOVERY_PORT || '8766', 10),
    discoveryEnabled: (env.LAN_DISCOVERY_ENABLED || '1') === '1',
    sharedSecret: env.LAN_SHARED_SECRET || 'codex-peripheral-dev-secret-2026',
    hostId: env.HOST_ID || `pc-${hostname}`,

    // ===== 火山引擎 ASR（大模型语音识别-闪速版） =====
    asr: {
        provider: env.ASR_PROVIDER || 'volcengine',   // volcengine | mock
        enabled: env.VOLCENGINE_API_KEY ? true : false,
        apiKey: env.VOLCENGINE_API_KEY || '',         // 豆包语音单字段 API Key（UUID 格式）
        resourceId: env.VOLCENGINE_RESOURCE_ID || 'volc.bigasr.auc_turbo',
        // 闪速版：一次请求返回结果（无需 submit/query 轮询）
        url: env.VOLCENGINE_ASR_URL || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
        requestTimeoutMs: parseInt(env.VOLCENGINE_ASR_TIMEOUT_MS || '30000', 10),
        // 调试：把收到的 PCM 存为 WAV（tmp/rec_<ts>.wav）
        saveDebugWav: (env.SAVE_DEBUG_WAV || '0') === '1',
    },

    // ===== CLI 会话托管（Phase 5） =====
    cli: {
        // 默认 Agent：设备端 transcript_confirm 未带 agentId 时投递目标
        defaultAgentId: env.CLI_DEFAULT_AGENT || 'agent-1',
        codexCommand: env.CODEX_COMMAND || '',
        claudeCommand: env.CLAUDE_COMMAND || '',
        // codex 模型覆盖（config.toml 模型名可能无效/别名，如 agnes-2.0-flash → deepseek-v4-flash）
        codexModel: env.CODEX_MODEL || '',
        // codex sandbox：read-only(默认安全) | workspace-write(允许改工作区) | danger-full-access
        codexSandbox: env.CODEX_SANDBOX || 'read-only',

        // 默认 Agent 池（可用 CLI_AGENTS 覆盖，格式：逗号分隔的 id:type:name:cwd）
        agents: parseAgents(env.CLI_AGENTS, [
            { id: 'agent-1', type: env.CLI_AGENT1_TYPE || 'codex', name: 'Codex 主 Agent', cwd: env.CODEX_CWD || process.cwd(), model: env.CODEX_MODEL || '', sandbox: env.CODEX_SANDBOX || 'read-only' },
            { id: 'agent-2', type: env.CLI_AGENT2_TYPE || 'claude', name: 'Claude 副 Agent', cwd: env.CLAUDE_CWD || process.cwd() },
            { id: 'agent-3', type: 'mock', name: 'Mock 演示 Agent', cwd: process.cwd() },
        ]),
    },

    // ===== 文本投递模式（Phase 5） =====
    delivery: {
        // cli: 转写确认后送入 Agent 会话托管（默认）
        // inject: 转写确认后剪贴板注入到前台窗口
        mode: env.TRANSCRIPT_DELIVERY_MODE || 'cli',
    },

    // ===== 目标应用路由（Phase 7） =====
    target: {
        // codex   —— Codex 桌面应用 CDP 深控（会话枚举/切换/注入）
        // generic —— 剪贴板注入兜底（WorkBuddy/Trae/任意前台窗口）
        app: env.TARGET_APP || 'codex',
        // Codex 桌面 CDP 调试端口
        cdpPort: parseInt(env.CODEX_CDP_PORT || '9229', 10),
        // 在 Codex 会话列表末尾追加的剪贴板注入目标（如 WorkBuddy/Trae）
        // 格式：name（显示名），空则不加。语音确认后走剪贴板粘贴+回车到前台窗口
        extraTarget: env.EXTRA_TARGET || 'WorkBuddy',
        // 注入前自动激活的目标窗口标题/进程名（解决"剪贴板注入到非前台窗口"问题，
        // 空=不激活，跟随前台窗口注入。如 WorkBuddy / Trae）
        // ⚠️ Phase 8（2026-08-15）：去掉 'WorkBuddy' 默认值——空字符串必须保持空
        //    （"通用注入"语义 = 跟随前台；默认值会导致用户配了空值仍被拽回 WorkBuddy）
        extraActivate: (env.EXTRA_ACTIVATE || '').trim(),
    },
};

// 解析 CLI_AGENTS：id:type:name:cwd,id2:type2:name2:cwd2
function parseAgents(raw, defaults) {
    if (!raw || !raw.trim()) return defaults;
    return raw.split(',').map((part, i) => {
        const [id, type, ...rest] = part.trim().split(':');
        const name = rest.length ? rest.join(':') : `Agent ${id || i + 1}`;
        return { id: id || `agent-${i + 1}`, type: type || 'mock', name, cwd: process.cwd() };
    });
}
