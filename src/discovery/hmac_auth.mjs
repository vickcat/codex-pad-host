// ============================================================
// hmac_auth.mjs —— HMAC-SHA256 认证（Phase 3）
//
// 与固件端 protocol.h 的 hmac_sha256_hex 算法保持一致：
//   signature = hex(HMAC-SHA256(secret, payload))
// ============================================================
import crypto from 'crypto';

export class HmacAuth {
    constructor(secret) {
        this.secret = secret;
    }

    // 计算签名
    sign(payload) {
        return crypto.createHmac('sha256', this.secret).update(payload).digest('hex');
    }

    // 验证签名是否匹配（constant-time 比较防时序攻击）
    verify(payload, signature) {
        const expected = this.sign(payload);
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(signature || '', 'utf8');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
}
