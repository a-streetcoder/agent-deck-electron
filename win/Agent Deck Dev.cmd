@echo off
setlocal
 title Agent Deck Dev
cd /d "%~dp0.."
if errorlevel 1 goto :failed

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.19 or newer is required. Install it and try again.
  goto :failed
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22 || major===22 && minor>=19 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 22.19 or newer is required.
  goto :failed
)
where pnpm >nul 2>&1
if errorlevel 1 (
  echo pnpm is required. Install the version specified in package.json and try again.
  goto :failed
)
if not exist "node_modules\" (
  echo Dependencies are missing. Run pnpm install in the repository first.
  goto :failed
)

echo Starting Agent Deck in development mode...
echo Keep this window open for logs. Press Ctrl+C here to stop development.
echo The packaged app can stay open. Backend changes may interrupt active responses here.
echo.
call pnpm dev
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo Agent Deck Dev could not start or stopped with an error. See the details above.
pause
exit /b 1
