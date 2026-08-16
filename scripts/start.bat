@echo off
rem ============================================================
rem start.bat - Codex Peripheral Host Bridge 启动脚本
rem 供开机自启（Startup 文件夹 .vbs 隐藏调用）或手动双击使用
rem 日志追加到 host-bridge/host.log，便于排查
rem ============================================================
cd /d "D:\AgentDevice\codex-peripheral\host-bridge"
echo [%date% %time%] host start >> host.log 2>&1
node src/server.mjs >> host.log 2>&1
