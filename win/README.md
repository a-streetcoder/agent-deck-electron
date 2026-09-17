# Windows development launcher

Double-click **Agent Deck Dev.cmd** to run Agent Deck from this checkout with live UI updates. No packaging step is needed. Keep the terminal open for logs; press **Ctrl+C** in it to stop the development processes (confirm termination if Windows asks). Closing only the app window may leave the development servers running.

Double-click **Create Dev Shortcut.cmd** once to create an **Agent Deck Dev** desktop shortcut. Recreate it if you move this repository. Keep the launcher in this folder: it resolves the repository relative to itself, not the current working directory.

## Prerequisites

- Node.js 22.19+ and the pnpm version specified in `package.json`, available on PATH.
- Dependencies installed with `pnpm install`, including access to the private skill-engine package.
- The native build prerequisites described in the repository development guides: `pnpm dev` runs `pnpm build:native` before starting.

The launcher does not install dependencies or change the packaged application. Startup errors remain visible in the terminal.

## Development versus packaged app

Close the packaged app before starting development, and run only one development launcher at a time. UI edits hot-reload; backend and Electron edits restart their respective processes and can interrupt active agent work. This launcher does not create a separate data sandbox or copy packaged-app data into development.

The stable Windows build is separate, under `release/win-unpacked` after running `pnpm pack:win`. Do not move these development launchers into that generated directory; it can be replaced during packaging.
