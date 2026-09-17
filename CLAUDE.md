@AGENTS.md

# Claude Code notes

`AGENTS.md` and the guides it links are the source of truth for every agent. This file adds only what is specific to driving this repository from Claude Code; do not duplicate guide content here.

- **Parity register work** (rows such as SKL/PRM/EXT/DST) goes through the `parity-loop` skill in `.claude/skills/`, not an ad-hoc flow.
- **On Windows, read [docs/agent-guidelines/WINDOWS.md](docs/agent-guidelines/WINDOWS.md) before running, building, or packaging.** It explains the stable-versus-dev setup and the failures that look like code bugs but are not.
- **Never start the app as a harness background task.** The harness kills background tasks under memory pressure and orphans the process tree; the orphaned backend then cannot spawn Pi. Launch it in its own terminal window (`win\Agent Deck Dev.cmd`, or `Start-Process` a script), and stop it there.
- **Never kill processes by image name** (`node.exe`, `electron.exe`, `Agent Deck.exe`). The user runs other Node projects and may be working inside the stable app. Kill by PID, found from the listening port or the command line, and check whether the stable app is running before `pnpm pack:win`.
- **For API or launch experiments, start a separate backend** (`PORT=4311 npx tsx apps/server/src/index.ts`) rather than using the user's instance on 4200, and delete any test sessions afterwards: it shares the dev data directory.
- **Shell syntax differs per tool.** The Bash tool is Git Bash (`export GITHUB_TOKEN=$(gh auth token)`); the PowerShell tool needs `$env:GITHUB_TOKEN = gh auth token`. In Git Bash, pass Windows paths in JSON bodies with forward slashes; backslashes are mangled.
