@echo off
setlocal EnableExtensions
title Cuko Quick API Gateway
cd /d "%~dp0"

set "ROOT=%CD%"
set "LOG_DIR=%ROOT%\data\logs"
set "PID_FILE=%ROOT%\data\gateway.pid"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo ============================================
echo  Cuko Quick API Gateway - one click start
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18 or newer.
  pause
  exit /b 1
)

rem Port 3000 already listening? Do not start a second instance.
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo [INFO] Gateway is already running.
  echo [INFO] Admin: http://127.0.0.1:3000/
  start "" "http://127.0.0.1:3000/"
  exit /b 0
)

if not exist "%ROOT%\node_modules\chrome-remote-interface" (
  echo [INFO] Dependencies not found. Running npm install...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Starting gateway in background...
set "CUKO_ROOT=%ROOT%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = $env:CUKO_ROOT; $node = (Get-Command node).Source; $out = Join-Path $root 'data\logs\console.out.log'; $err = Join-Path $root 'data\logs\console.err.log'; $p = Start-Process -FilePath $node -ArgumentList 'bridge/index.js' -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru; Set-Content -LiteralPath (Join-Path $root 'data\gateway.pid') -Value $p.Id"

set /a WAIT_SECONDS=0
:wait_for_gateway
curl -s -o nul --max-time 2 http://127.0.0.1:3000/openai/v1/models
if not errorlevel 1 goto gateway_ready
set /a WAIT_SECONDS+=1
if %WAIT_SECONDS% GEQ 30 goto gateway_timeout
ping -n 2 127.0.0.1 >nul
goto wait_for_gateway

:gateway_ready
echo.
echo [OK] Gateway is ready.
echo [OK] Admin:  http://127.0.0.1:3000/
echo [OK] OpenAI: http://127.0.0.1:3000/openai/v1
echo [OK] Model:  aws
echo [INFO] The admin page is opened automatically by the gateway.
exit /b 0

:gateway_timeout
echo.
echo [ERROR] Gateway did not become ready within 30 seconds.
echo ---- stdout ----
powershell -NoProfile -Command "Get-Content -LiteralPath (Join-Path $env:CUKO_ROOT 'data\logs\console.out.log') -Tail 30 -ErrorAction SilentlyContinue"
echo ---- stderr ----
powershell -NoProfile -Command "Get-Content -LiteralPath (Join-Path $env:CUKO_ROOT 'data\logs\console.err.log') -Tail 30 -ErrorAction SilentlyContinue"
pause
exit /b 1
