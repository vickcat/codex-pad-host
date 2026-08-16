# Codex Peripheral Host Bridge — 跨 PC 部署指南

PC 端主机服务：让 Codex Pad 语音外设（ESP32-S3）通过局域网把语音转写/按键指令
注入本机的 Codex 桌面应用（或 CLI 会话）。**本目录拷贝到任意 Windows PC 即可部署**，
本机已配好的服务不依赖特定机器。

---

## 1. 前置要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11（64 位） |
| Node.js | **20+**（`node --version` 检查；没有则 setup.ps1 会自动装） |
| 网络 | **与设备同一 WiFi/局域网**（设备通过 UDP 广播发现本机） |
| Codex 桌面 app | 已登录并保持运行（CDP 深控模式需要，默认端口 9229） |
| 防火墙 | 首次启动允许 Node 监听 8765/8766（弹窗点"允许"） |

> 提示：如果设备换过网络（不同 WiFi），需先在设备上重新配网：
> 设备上电后若 15s 连不上 WiFi 会自动开热点 `CodexPad-XXXX`，手机/PC 连上后
> 浏览器打开 `http://192.168.4.1` 选网络并保存，设备会自动重启连网。

---

## 2. 一键安装（新 PC）

把整个 `host-bridge/` 文件夹拷贝到新 PC（如 `D:\codex-peripheral\host-bridge`），然后：

```powershell
cd D:\codex-peripheral\host-bridge\scripts
powershell -ExecutionPolicy Bypass -File setup.ps1 -Start
```

`setup.ps1` 会依次：
1. 检查/安装 Node.js 20+（winget 自动装，装完会刷新 PATH）
2. `npm install` 安装运行依赖（需要联网）
3. 从 `config.env.example` 生成 `config.env`（已存在则跳过；**首次会问 ASR API Key**）
4. 启动服务（WS 8765 + UDP 8766）

> 可选参数：`-SkipNode`（Node 已装）、`-Autostart`（注册开机自启）、`-InstallCli`（顺带装 CLI）

---

## 3. 配置 `config.env`（关键）

`host-bridge/config.env` 是本服务唯一配置（含密钥，**不要提交 git**）。

### 必须项

```ini
# 局域网共享密钥 —— ⚠️ 必须与固件 config.h 的 LAN_SHARED_SECRET 完全一致！
LAN_SHARED_SECRET=codex-peripheral-dev-secret-2026

# 火山引擎 ASR（豆包语音控制台 → API Key 管理 → 单字段 UUID）
ASR_PROVIDER=volcengine
VOLCENGINE_API_KEY=你的_单字段_API_Key
VOLCENGINE_RESOURCE_ID=volc.bigasr.auc_turbo
```

### 投递模式（二选一）

**A. CDP 深控（默认，推荐）—— 语音注入 Codex 桌面 app**

```ini
TARGET_APP=codex
TRANSCRIPT_DELIVERY_MODE=inject
# CDP 端口（Codex 桌面 app 的 remote-debugging-port，默认 9229）
CODEX_CDP_PORT=9229
```

- 要求：Codex 桌面 app 运行中，且已开 CDP（`codex++` 启动参数带 `--remote-debugging-port=9229`）
- 启动时 host 会打印 `[CDP] ✅ Codex CDP 已连接`；`http://127.0.0.1:9229/json` 能打开即正常
- 设备点击卡片 = 在 Codex 侧边栏切换会话（会话列表来自 CDP 实时读取）

**B. CLI 会话托管 —— 语音送入 codex/claude 命令行会话**

```ini
TRANSCRIPT_DELIVERY_MODE=cli
CLI_AGENT1_TYPE=codex
CLI_AGENT2_TYPE=claude
CLI_AGENT3_TYPE=mock
CODEX_MODEL=deepseek-v4-flash
```

- 需要已安装 CLI：`npm i -g @openai/codex @anthropic-ai/claude-code`（或 setup.ps1 -InstallCli）
- `CODEX_CWD` 指定工作目录（不配则用当前目录）

---

## 4. 启动 / 停止

```bat
:: 启动（窗口显示日志）
host-bridge\start.bat
```

或 PowerShell：

```powershell
node host-bridge\src\server.mjs
```

- 看到 `[WS] server listening on :8765` + `[UDP] discovery beacon on :8766` 即服务就绪
- 关闭窗口即停止
- 开机自启（可选）：`setup.ps1 -Autostart`

---

## 5. 设备连接流程（开机顺序建议）

1. 先启动本机 host（8765/8766 监听）
2. 给设备上电（同一 WiFi）
3. 设备自动：连 WiFi → UDP 广播找 host → 收到响应 → WebSocket 连上 8765
4. 本机验证：`netstat -ano | findstr 192.168.5.46`（设备 IP）能看到 `ESTABLISHED`；
   host 窗口出现设备 hello 日志；设备屏幕"主机在线"胶囊点亮

---

## 6. 多 PC / 切换机器的注意事项

- **同时只跑一个 host**：设备一次只连一个 host（UDP 发现先到先得）。
  换机器前先关掉旧机器的 host，再在新机器启动。
- **同一 WiFi**：设备已配的 WiFi 与目标 PC 必须同网段（如都在 192.168.5.x）。
- **设备无需重烧**：换 PC 只是换 host，设备固件不变。
- **共享密钥必须一致**：换机器部署时 `config.env` 的 `LAN_SHARED_SECRET`
  要与设备固件里的值一致，否则 UDP 发现被拒（HMAC 校验失败）。

---

## 7. 排错速查

| 现象 | 处理 |
|---|---|
| `[CDP]` 连不上 | Codex 桌面 app 是否运行？9229 端口是否开启？`http://127.0.0.1:9229/json` 测试 |
| 设备屏幕"主机离线" | host 是否启动？防火墙放行 8765/8766？两台设备同网段？ |
| 说话无转写 | config.env 的 `VOLCENGINE_API_KEY` 是否有效（单字段 UUID）；`SAVE_DEBUG_WAV=1` 开调试 |
| 转写成功但没注入 | 投递模式是否与目标匹配（inject vs cli）；目标窗口是否在前台 |
| 设备连不上 WiFi | 设备 15s 未连会进 AP 配网模式，按上文重新配网 |
| 端口被占用 | `netstat -ano | findstr 8765` 找到 PID 结束旧 host 进程 |

---

## 8. 目录结构

```
host-bridge/
├── start.bat              # 双击启动（前台窗口）
├── config.env             # 本机配置（含密钥，勿提交）
├── config.env.example     # 配置模板
├── package.json
├── src/
│   └── server.mjs         # 主服务（WS + UDP + ASR + 投递）
└── scripts/
    ├── setup.ps1          # 一键安装（Node/依赖/配置）
    ├── start.bat          # 隐藏自启用启动脚本（日志 → host.log）
    ├── cdp-check.mjs      # CDP 连通性检查
    └── cdp-probe.mjs      # CDP 会话探测
```

---

## 9. 固件侧对应配置（只需知道，不用动）

- 共享密钥：`firmware/src/config.h` → `LAN_SHARED_SECRET`（与 config.env 一致）
- WiFi 凭据：设备 NVS（配网写入）> config.h fallback
- 烧录固件：按住 BOOT 插 USB 进下载模式（详情见固件 README / dev plan）
