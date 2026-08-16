@echo off
rem ============================================================
rem install-host.bat - Codex Pad Host Bridge 一键部署（新 PC 用）
rem 双击运行：自动 装 Node → 装依赖 → 引导填 ASR Key → 启动
rem 要求：解压本 zip 到任意目录后双击本文件（保持目录结构）
rem ============================================================
title Codex Pad Host 一键部署
cd /d "%~dp0"

echo ============================================
echo   Codex Pad Host Bridge 一键部署
echo   目录: %cd%
echo ============================================
echo.

rem 1. 检测 Node（没有则提示用 setup.ps1 自动装）
node --version >nul 2>&1
if errorlevel 1 (
    echo [1/3] 未检测到 Node.js，用 setup.ps1 自动安装（winget）...
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -SkipNode
) else (
    echo [1/3] Node.js 已就绪： & node --version
)

echo [2/3] 检查依赖并生成配置（首次会询问 ASR API Key）...
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Start
if errorlevel 1 goto err

echo.
echo ============================================
echo   ✅ 部署完成，host 已在后台运行
echo   日志: host.log   （同目录）
echo   开机自启: 可选 setup.ps1 -Autostart
echo ============================================
pause
exit /b 0

:err
echo.
echo   ❌ 安装失败，请查看上方错误信息
echo   常见原因: 网络不通（npm 下载失败）/ ASR Key 格式不对
echo   重试: 再次双击本文件即可（已装部分会跳过）
pause
exit /b 1