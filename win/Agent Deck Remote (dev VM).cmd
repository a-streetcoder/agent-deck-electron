@echo off
setlocal
title Agent Deck Remote (dev VM)
cd /d "%~dp0.."

REM POC: the Agent Deck SERVER runs on the dev VM (ssh alias "dev", 10.0.0.12) as a systemd
REM user service on 127.0.0.1:4200. This opens an SSH tunnel so the desktop shell sees it as a
REM loopback server (the only kind main.js accepts), then starts the Electron shell against it.
REM The renderer is served by the VM server (apps/web/dist built there); no local backend runs.

if not exist "node_modules\" (
  echo Dependencies are missing. Run pnpm install in the repository first.
  pause
  exit /b 1
)

echo Opening SSH tunnel 127.0.0.1:4200 -^> dev VM ...
start "Agent Deck tunnel (close to disconnect)" ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 4200:127.0.0.1:4200 dev

echo Waiting for the VM server...
set /a tries=0
:wait
set /a tries+=1
curl -s -o nul -m 3 http://127.0.0.1:4200/health && goto ready
if %tries% geq 20 (
  echo The server on the dev VM is not answering on port 4200.
  echo On the VM: systemctl --user status agent-deck-server
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul
goto wait

:ready
echo Server is up. Starting Agent Deck...
set AGENT_DECK_SERVER_URL=http://127.0.0.1:4200
cd apps\desktop
call ..\..\node_modules\.bin\electron.cmd .
endlocal
