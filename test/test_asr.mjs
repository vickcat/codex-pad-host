// ============================================================
// test_asr.mjs —— 火山引擎 ASR 独立测试
//
// 用法：
//   node test/test_asr.mjs                     # 合成 3s 测试音（验证鉴权链路）
//   node test/test_asr.mjs path/to/voice.wav   # 转写已有 WAV（16k 16bit 单声道）
//
// 鉴权成功的标志：
//   - 合成音（非语音）→ 通常返回 20000003（静音）或空文本，但状态码不是鉴权错误
//   - 鉴权失败 → code=401 类 / X-Api-Status-Code 非 200xxxx
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config.mjs';
import { AsrVolcengine } from '../src/audio/asr_volcengine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.resolve(__dirname, '../tmp');
fs.mkdirSync(TMP, { recursive: true });

const asr = new AsrVolcengine(config.asr);

console.log(`[ASR] enabled=${config.asr.enabled} resourceId=${config.asr.resourceId}`);
if (!asr.ready) {
    console.error('[ASR] ❌ 未配置 API Key，请在 config.env 填 VOLCENGINE_API_KEY_ID/SECRET');
    process.exit(1);
}
console.log(`[ASR] apiKey=${config.asr.apiKey.slice(0, 8)}... (${config.asr.apiKey.length} chars)`);

// ---- 生成/读取测试音频 ----
let pcm = null;
let srcName = '';

const argFile = process.argv[2];
if (argFile && fs.existsSync(argFile)) {
    // 已存在 WAV：剥掉 44 字节头取 PCM
    const wav = fs.readFileSync(argFile);
    pcm = wav.subarray(44);
    srcName = path.basename(argFile);
    console.log(`[ASR] 读取 WAV: ${argFile} (pcm ${pcm.length}B, ${(pcm.length / 2 / 16000).toFixed(1)}s)`);
} else {
    // 合成 3s 测试音：1kHz 正弦波 + 噪声扫频（能触发服务端处理，验证鉴权）
    const seconds = 3, rate = 16000;
    pcm = Buffer.alloc(seconds * rate * 2);
    for (let i = 0; i < seconds * rate; i++) {
        const t = i / rate;
        const env = 0.5 * (1 - Math.exp(-t * 3));            // 淡入
        const s = Math.sin(2 * Math.PI * (500 + 200 * t) * t); // 扫频
        pcm.writeInt16LE(Math.round(s * 12000 * env), i * 2);
    }
    srcName = 'synthetic-3s.wav';
    const wavPath = path.join(TMP, srcName);
    fs.writeFileSync(wavPath, asr.pcmToWav(pcm));
    console.log(`[ASR] 合成测试音 → ${wavPath} (纯音，预期"静音/空文本"，主要验证鉴权)`);
}

// ---- 调 ASR ----
console.log('[ASR] 请求转写中...');
try {
    const t0 = Date.now();
    const { text, durationMs } = await asr.transcribe(pcm);
    const dt = Date.now() - t0;
    console.log(`[ASR] ✅ 完成 音频 ${durationMs}ms 耗时 ${dt}ms`);
    console.log(`[ASR] 转写文本: "${text}"`);
    if (!text) console.log('[ASR] （空文本：合成音无语音内容，属预期。用真实语音 WAV 测试即可）');
} catch (e) {
    console.error(`[ASR] ❌ ${e.message}`);
    process.exit(1);
}
