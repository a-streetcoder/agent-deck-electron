@echo off
setlocal
set "AGENT_DECK_DEV_LAUNCHER=%~dp0Agent Deck Dev.cmd"
set "AGENT_DECK_DEV_ROOT=%~dp0.."
powershell.exe -NoProfile -Command "$ErrorActionPreference = 'Stop'; $shell = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath('Desktop'); $shortcut = $shell.CreateShortcut((Join-Path $desktop 'Agent Deck Dev.lnk')); $shortcut.TargetPath = $env:AGENT_DECK_DEV_LAUNCHER; $shortcut.WorkingDirectory = [IO.Path]::GetFullPath($env:AGENT_DECK_DEV_ROOT); $shortcut.Description = 'Agent Deck live development checkout'; $icon = Join-Path $shortcut.WorkingDirectory 'build\icon.ico'; if (Test-Path $icon) { $shortcut.IconLocation = $icon }; $shortcut.Save()"
if errorlevel 1 (
  echo Could not create the desktop shortcut.
  pause
  exit /b 1
)
echo Created Agent Deck Dev on your desktop.
echo Re-run this script if you move the repository.
pause
