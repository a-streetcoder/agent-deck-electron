# Windows development and packaging

How to develop Agent Deck on Windows while using Agent Deck itself. There is no Windows installer, signing, or auto-update yet; the stable copy is an unpacked build promoted by hand.

## Two copies, side by side

|         | Stable (daily driver)                         | Dev (under test)                                        |
| ------- | --------------------------------------------- | ------------------------------------------------------- |
| What    | unpacked build, run from outside the checkout | `win\Agent Deck Dev.cmd` (`pnpm dev`) from the checkout |
| Data    | `%APPDATA%\Agent Deck`                        | `%LOCALAPPDATA%\agent-deck-electron`                    |
| Backend | ephemeral loopback port                       | `127.0.0.1:4200`, Vite on `5199`                        |

They share no app data and no ports, so both can run at once. They do share Pi's own configuration in `~/.pi/agent` (auth, extensions, session files, `claude-bridge.json`). Project and session lists are separate, so the dev instance starts mostly empty.

## The loop

1. **Work in the stable app.** Open this repository as a project and run agent sessions there, preferably with session-worktree isolation so edits land on their own branch and folder.
2. **Test in the dev instance.** Check the branch out in the main checkout and start `win\Agent Deck Dev.cmd`. Renderer edits hot-reload; backend edits restart the server under `node --watch`; main-process and preload edits restart Electron.
3. **Promote deliberately.** Close the dev instance, run `pnpm pack:win`, run `node scripts/smoke-packaged-loop-catalog.mjs release`, then copy `release\win-unpacked` over the stable install folder (for example `%LOCALAPPDATA%\Programs\Agent Deck`). Keep the previous folder as a rollback.

## Rules that prevent real breakage

- **Never run the stable app from `release\win-unpacked`.** `pnpm pack:win` clears that folder; packing while an app runs from it deletes files underneath it (the bundled Pi runtime goes first) and new sessions then fail until restart.
- **Close the dev instance before `pnpm build:native`, `pnpm build`, or `pnpm pack:win`.** A running backend holds `loop-catalog-native.win32-x64.node`, and the rebuild fails with `EPERM`.
- **Do not run agent sessions in the folder the dev instance runs from.** Every saved backend file restarts its server and interrupts that instance's active turns. Worktree sessions avoid this.
- **Start the dev instance from its own terminal window** and stop it with Ctrl+C there. A backend orphaned from its console cannot spawn Pi: sessions fail with `pi exited (code=3221225794)` (`0xC0000142`). Closing only the app window stops the dev servers too (`concurrently --kill-others`); a window whose servers died reports `TypeError: Failed to fetch` on every action.
- **If a change breaks session launch or the Pi bridge in the stable app,** you cannot fix it from inside that app. Roll back to the previous folder, or use plain `pi` or another coding agent in a terminal.

## Machine setup

- `pnpm install` and the build need `GITHUB_TOKEN` for the private `@a-streetcoder/skill-engine-native` package. `gh auth token` works when the login has `read:packages`: `$env:GITHUB_TOKEN = gh auth token` (PowerShell) or `export GITHUB_TOKEN=$(gh auth token)` (Git Bash). Running the app does not need it.
- Claude models through a Claude subscription come from the bundled `pi-claude-bridge`, which drives the user's own Claude Code install. Claude Code is a prerequisite and is never bundled. On Windows only a native `claude.exe` (on `PATH` or in `~\.local\bin`) is detected; without it the `claude-bridge` models are simply not offered.
- The launch-resource fingerprint test that creates symlinks fails with `EPERM` unless Windows Developer Mode is on or the shell is elevated. That failure is environmental.

## Pitfalls already handled

CI never exercises these (its checkout path has no spaces, and it does not run `pnpm dev`). They are fixed, but are the first place to look when something works in CI and fails locally:

- `pack:win` passes `-c.npmRebuild=false`: node-pty's winpty gyp step breaks on a checkout path with spaces, and the shipped N-API prebuilds are used instead.
- `scripts/build-pi-runtime.mjs` quotes the deploy target because `shell: true` joins arguments unquoted, which split a path with spaces.
- `dev:watch` uses `node --watch --import tsx`, not `tsx watch`: under `concurrently`'s piped stdin, `tsx watch` stalls the backend before it listens, and Electron then waits on the health check forever (a terminal, but no window).
