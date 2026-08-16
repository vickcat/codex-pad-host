# ============================================================
# setup.ps1 - Codex Peripheral Host Bridge one-click installer (Windows)
#
# What it does:
#   1. Check/install Node.js 20+ (via winget, auto-refresh PATH)
#   2. npm install (runtime deps only)
#   3. Generate config.env from example (if missing; asks for ASR key)
#   4. Detect codex / claude CLI (optional, only needed for 'cli' delivery mode)
#   5. Optional: register startup autostart, start server
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -InstallCli
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Autostart
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Start
#   (combine flags freely)
#
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads .ps1 as ANSI).
# ============================================================
param(
    [switch]$InstallCli,     # also install codex + claude CLI via npm
    [switch]$Autostart,      # register "start on boot" (Startup folder)
    [switch]$Start,          # start the server after setup
    [switch]$SkipNode        # skip Node.js check/install
)

$ErrorActionPreference = 'Stop'
# 脚本所在目录（绝对路径，兼容相对路径/双击调用）
$Root = (Get-Item $MyInvocation.MyCommand.Path).DirectoryName
# ⚠️ 修复（2026-08-15）：$Root=scripts 目录（DirectoryInfo 对象），而工程文件（package.json/config.env/src）在上一级
#    host-bridge 根目录 → 引入 $AppRoot，业务路径一律用 $AppRoot
$AppRoot = $Root.Parent.FullName
Set-Location $AppRoot

function Log($msg) { Write-Host "[setup] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }

Log "Codex Peripheral Host Bridge installer"
Log "Root: $AppRoot"

# ------------------------------------------------------------
# 0. Sanity: is this really the host-bridge directory?
# ------------------------------------------------------------
if (-not (Test-Path "$AppRoot\package.json") -or -not (Test-Path "$AppRoot\src\server.mjs")) {
    Write-Host "[setup] ERROR: package.json / src/server.mjs not found in $AppRoot" -ForegroundColor Red
    Write-Host "[setup] Please run this script from inside the host-bridge folder (or copy the whole folder to this PC first)." -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------
# 1. Node.js check / install
# ------------------------------------------------------------
if (-not $SkipNode) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $nodeOk = $false
    if ($node) {
        try {
            $ver = & node --version 2>$null
            if ($ver -match '^v(\d+)') {
                if ([int]$Matches[1] -ge 20) { $nodeOk = $true; Ok "Node.js $ver found" }
                else { Warn "Node.js $ver is too old (need v20+)" }
            }
        } catch {}
    }
    if (-not $nodeOk) {
        Write-Host "[setup] Node.js not found or too old - installing via winget..." -ForegroundColor Yellow
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if (-not $winget) {
            Write-Host "[setup] ERROR: winget not available. Install Node.js 20+ manually from https://nodejs.org then rerun." -ForegroundColor Red
            exit 1
        }
        & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[setup] ERROR: Node.js install failed. Install it manually from https://nodejs.org and rerun." -ForegroundColor Red
            exit 1
        }
        # Refresh PATH for this session (new installs land in Program Files)
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
        Ok "Node.js installed. (PATH refreshed for this session; new terminals pick it up automatically)"
    }
}

# ------------------------------------------------------------
# 2. npm install
# ------------------------------------------------------------
Log "Installing dependencies (npm install)..."
& npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] ERROR: npm install failed" -ForegroundColor Red; exit 1 }
Ok "dependencies installed"

# ------------------------------------------------------------
# 3. config.env generation
# ------------------------------------------------------------
if (-not (Test-Path "$AppRoot\config.env")) {
    Log "config.env not found - creating from example..."
    Copy-Item "$AppRoot\config.env.example" "$AppRoot\config.env"
    Ok "config.env created (default shared secret + ports)"
    Write-Host ""
    Write-Host "  >>> Next: open $AppRoot\config.env and set VOLCENGINE_API_KEY" -ForegroundColor Yellow
    Write-Host "  >>> (Voice ASR key from Volcengine console; leave ASR_PROVIDER=mock to test without it)" -ForegroundColor Yellow
    Write-Host ""
} else {
    Ok "config.env already exists (kept as-is)"
}

# ------------------------------------------------------------
# 4. Optional: codex / claude CLI detection or install
# ------------------------------------------------------------
$codex = Get-Command codex -ErrorAction SilentlyContinue
$claude = Get-Command claude -ErrorAction SilentlyContinue

if ($codex) { Ok "codex CLI found: $((& codex --version 2>$null))" }
else {
    if ($InstallCli) {
        Log "Installing codex CLI (npm global)..."
        & npm install -g @openai/codex
        if ($LASTEXITCODE -eq 0) { Ok "codex CLI installed" } else { Warn "codex install failed (see error above)" }
    } else {
        Warn "codex CLI NOT found (only needed for 'cli' delivery mode; inject mode works without it)"
    }
}

if ($claude) { Ok "claude CLI found: $((& claude --version 2>$null))" }
else {
    if ($InstallCli) {
        Log "Installing claude CLI (npm global)..."
        & npm install -g @anthropic-ai/claude-code
        if ($LASTEXITCODE -eq 0) { Ok "claude CLI installed" } else { Warn "claude install failed (see error above)" }
    } else {
        Warn "claude CLI NOT found (only needed for 'cli' delivery mode)"
    }
}

# ------------------------------------------------------------
# 5. Optional: startup autostart (Startup folder shortcut)
# ------------------------------------------------------------
if ($Autostart) {
    Log "Registering autostart..."
    $startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
    $vbs = Join-Path $startupDir 'codex-peripheral-host-bridge.vbs'
    $bat = Join-Path $Root 'start.bat'
    if (-not (Test-Path $bat)) {
        # fallback: point directly at node（cd 到 host-bridge 根目录）
        $bat = Join-Path $env:TEMP 'codex-host-start.bat'
        Set-Content -Path $bat -Value "@echo off`r`ncd /d `"$AppRoot`"`r`nnode src/server.mjs" -Encoding ASCII
    }
    # hidden launcher so no console window pops on login
    $vbsContent = "Set ws = CreateObject(`"WScript.Shell`")`r`nws.Run `"`"`"$bat`"`"`", 0, False"
    Set-Content -Path $vbs -Value $vbsContent -Encoding ASCII
    Ok "autostart registered: $vbs (starts hidden on login)"
}

# ------------------------------------------------------------
# 6. Optional: start server now
# ------------------------------------------------------------
if ($Start) {
    Log "Starting host bridge server (WS 8765 + UDP 8766)..."
    Start-Process -FilePath 'node' -ArgumentList 'src/server.mjs' -WorkingDirectory $AppRoot -WindowStyle Hidden
    Ok "server started (hidden window). Devices should auto-discover it."
} else {
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor Green
    Write-Host "    - Start server : double-click start.bat  (or: node src/server.mjs)" -ForegroundColor Green
    Write-Host "    - Test         : node test/test_ws.mjs" -ForegroundColor Green
    Write-Host "    - Device       : ESP32 must be on the SAME WiFi network as this PC" -ForegroundColor Green
}

Log "Setup finished."
