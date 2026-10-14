@echo off
setlocal
title Agent Deck Remote (cloudflare)
cd /d "%~dp0.."

REM POC (docs/remote-server-poc.md): the Agent Deck SERVER runs on the Linux VM behind a
REM Cloudflare Tunnel + Cloudflare Access (GitHub sign-in) at https://deck.moretti.cc.
REM This starts only the Electron shell, attached to that origin: no local backend, no SSH
REM tunnel. The first launch shows the Cloudflare Access login inside the window; the Access
REM cookie is kept by Electron's session, so later launches open straight into the app.

if not exist "node_modules\" (
  echo Dependencies are missing. Run pnpm install in the repository first.
  pause
  exit /b 1
)

set AGENT_DECK_REMOTE_SERVER_URL=https://deck.moretti.cc
REM Lets main.js pin the login round-trip to this team's Access pages (optional).
set AGENT_DECK_CF_ACCESS_TEAM_DOMAIN=streetcoding-collective.cloudflareaccess.com
REM Proven 2026-10-14 (ade-1vjx): sign in through the system browser via cloudflared instead of
REM the in-window Access login. Uncomment to use it (docs/remote-server-poc.md, Desktop login).
REM set "AGENT_DECK_CLOUDFLARED=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
REM Optional: the same value the VM service exports, so "Reveal" actions that need the
REM desktop recovery token keep working against the remote server.
REM set AGENT_DECK_DESKTOP_RECOVERY_TOKEN=

echo Starting Agent Deck against %AGENT_DECK_REMOTE_SERVER_URL% ...
cd apps\desktop
REM Extra arguments reach Electron unchanged (for example --remote-debugging-port=9222).
call ..\..\node_modules\.bin\electron.cmd . %*
endlocal
