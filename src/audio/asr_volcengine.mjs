// ============================================================
// asr_volcengine.mjs —— 火山引擎 ASR（大模型语音识别-闪速版）
//
// 接口：POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
//   一次请求返回结果（音频 base64 内联），无需 submit/query 轮询。
//
// 鉴权（新版控制台 API Key）：
//   X-Api-Key: <key_id>.<key_secret>      （控制台"API Key 管理"获取，ID.Secret 拼接）
//   X-Api-Resource-Id: volc.bigasr.auc_turbo
//   X-Api-Request-Id: <uuid>
//   X-Api-Sequence: -1
//
// 请求体（audio.data 为 WAV base64）：
//   { "audio": { "data": "<base64>", "format": "wav" },
//     "request": { "model_name": "bigmodel", "enable_itn": true,
//                  "enable_punc": true, "enable_ddc": true } }
//
// 成功判定：响应 header X-Api-Status-Code == "20000000"，文本在 body.result.text。
// 已知状态码：20000000 成功 / 20000003 静音 / 45000001 参数无效 / 45000002 空音频 ...
// ============================================================
import crypto from 'crypto';

export class AsrVolcengine {
    constructor(config) {
        this.config = config;
    }

    get ready() {
        return !!this.config.apiKey;
    }

    /**
     * PCM16 单声道 16kHz → 转写文本
     * ⚠️ 2026-08-16：错误统一带 code 分类（供设备端 toast 结构化显示）：
     *    NO_KEY / TOO_SHORT / NETWORK / API_<statusCode> / TIMEOUT
     * @param {Buffer} pcm 原始 PCM（little-endian int16，16kHz 单声道）
     * @returns {Promise<{text: string, durationMs: number}>}
     */
    async transcribe(pcm) {
        if (!this.ready) {
            const e = new Error('ASR 未配置：config.env 缺少 VOLCENGINE_API_KEY');
            e.code = 'NO_KEY';
            throw e;
        }
        if (!pcm || pcm.length < 640) {   // <20ms 音频直接拒绝
            const e = new Error('ASR 音频过短（<20ms）');
            e.code = 'TOO_SHORT';
            throw e;
        }

        const wav = this.pcmToWav(pcm);
        const body = {
            audio: { data: wav.toString('base64'), format: 'wav' },
            request: {
                model_name: 'bigmodel',
                enable_itn: true,     // 逆文本归一化：一百 → 100
                enable_punc: true,    // 自动标点
                enable_ddc: true,     // 数字转换
            },
        };

        const headers = {
            'Content-Type': 'application/json',
            'X-Api-Key': this.config.apiKey,
            'X-Api-Resource-Id': this.config.resourceId,
            'X-Api-Request-Id': crypto.randomUUID(),
            'X-Api-Sequence': '-1',
        };

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
        // ⚠️ Phase 8（2026-08-15）：真实转写耗时（墙钟）——之前 durationMs 误用音频时长，
        //    日志"转写完成 xx ms"一直是假象，掩盖了真实转写延迟
        const t0 = Date.now();
        let resp;
        try {
            resp = await fetch(this.config.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: ac.signal,
            });
        } catch (e) {
            const err = new Error(`ASR 网络请求失败: ${e.message}`);
            err.code = e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
            throw err;
        } finally {
            clearTimeout(timer);
        }

        const statusCode = resp.headers.get('x-api-status-code') || '';
        const apiMessage = resp.headers.get('x-api-message') || '';
        const logid = resp.headers.get('x-tt-logid') || '';

        let json = null;
        try { json = await resp.json(); } catch { /* 非 JSON 响应 */ }

        if (statusCode !== '20000000') {
            const detail = json?.result?.text || apiMessage || resp.statusText;
            const e = new Error(`ASR 失败 code=${statusCode} msg=${detail} logid=${logid}`);
            e.code = `API_${statusCode}`;
            throw e;
        }

        const text = (json?.result?.text || '').trim();
        const durationMs = Date.now() - t0;   // 真实转写耗时（墙钟，含网络 RTT + 服务处理）
        return { text, durationMs };
    }

    /**
     * PCM16 单声道 16kHz → WAV（44 字节 RIFF 头）
     */
    pcmToWav(pcm) {
        const sampleRate = 16000, channels = 1, bits = 16;
        const dataSize = pcm.length;
        const buf = Buffer.alloc(44 + dataSize);
        buf.write('RIFF', 0);
        buf.writeUInt32LE(36 + dataSize, 4);
        buf.write('WAVE', 8);
        buf.write('fmt ', 12);
        buf.writeUInt32LE(16, 16);                    // fmt chunk size
        buf.writeUInt16LE(1, 20);                     // PCM
        buf.writeUInt16LE(channels, 22);
        buf.writeUInt32LE(sampleRate, 24);
        buf.writeUInt32LE(sampleRate * channels * bits / 8, 28); // byte rate
        buf.writeUInt16LE(channels * bits / 8, 32);   // block align
        buf.writeUInt16LE(bits, 34);
        buf.write('data', 36);
        buf.writeUInt32LE(dataSize, 40);
        pcm.copy(buf, 44);
        return buf;
    }
}
