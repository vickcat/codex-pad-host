// ============================================================
// udp_beacon.mjs —— UDP 局域网发现广播服务（Phase 3）
//
// 协议（与开发计划 §6.3 / 固件 udp_discovery 一致）：
//   设备 → 广播: {"type":"discovery","deviceId","counter","signature"}
//   主机 → 设备: {"type":"discovery_reply","host","wsPort","hostId","counter","signature"}
// 签名 payload：设备侧 sign(deviceId:counter)，主机侧 sign(hostId:wsPort:counter)
// ============================================================
import dgram from 'dgram';

export class UdpBeacon {
    constructor({ port, wsPort, hostId, auth, onDeviceFound = null }) {
        this.port = port;
        this.wsPort = wsPort;
        this.hostId = hostId;
        this.auth = auth;
        this.onDeviceFound = onDeviceFound;
        this.socket = dgram.createSocket('udp4');
        this.seen = new Map();   // deviceId -> lastSeen
    }

    start() {
        this.socket.on('message', (msg, rinfo) => {
            this.handleMessage(msg, rinfo);
        });
        this.socket.on('error', (err) => {
            console.error('[UDP] error:', err.message);
        });
        this.socket.bind(this.port, () => {
            this.socket.setBroadcast(true);
            console.log(`[UDP] discovery beacon on :${this.port} (ws port ${this.wsPort})`);
        });
    }

    stop() {
        this.socket.close();
    }

    handleMessage(msg, rinfo) {
        let data;
        try {
            data = JSON.parse(msg.toString('utf8'));
        } catch {
            return;   // 非 JSON 忽略
        }
        if (data.type !== 'discovery') return;

        const deviceId = String(data.deviceId || '');
        const counter = data.counter;
        if (!deviceId) return;

        // 验证签名：HMAC(secret, deviceId:counter)
        const payload = `${deviceId}:${counter}`;
        if (!this.auth.verify(payload, data.signature)) {
            console.warn(`[UDP] discovery from ${rinfo.address} signature MISMATCH (device=${deviceId})`);
            console.warn(`[UDP]   expected=${this.auth.sign(payload)} got=${data.signature} payload="${payload}"`);
            return;
        }

        // 同一设备去重（10s 窗口）
        const now = Date.now();
        const last = this.seen.get(deviceId) || 0;
        if (now - last < 10000) return;
        this.seen.set(deviceId, now);

        console.log(`[UDP] device found: ${deviceId} @ ${rinfo.address}`);

        // 回复 discovery_reply（发送回设备的源地址/端口）
        const replyPayload = `${this.hostId}:${this.wsPort}:${counter}`;
        const reply = JSON.stringify({
            type: 'discovery_reply',
            host: rinfo.address,
            wsPort: this.wsPort,
            hostId: this.hostId,
            counter,
            signature: this.auth.sign(replyPayload),
        });
        this.socket.send(reply, rinfo.port, rinfo.address, (err) => {
            if (err) console.error('[UDP] reply send failed:', err.message);
        });

        if (this.onDeviceFound) this.onDeviceFound(deviceId, rinfo.address);
    }
}
