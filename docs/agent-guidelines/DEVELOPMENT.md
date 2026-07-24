# Development guidance

Run commands from the repository root with Node.js 22.19+ and pnpm.

```sh
pnpm install
pnpm dev
pnpm build
```

`pnpm dev` runs the normal full-stack loop: Vite hot-reloads renderer changes, the server restarts under `tsx watch`, and Electron restarts for main-process or preload changes.

Useful focused commands:

```sh
pnpm build:web
pnpm build:backend
pnpm --filter <workspace-name> <script>
```

Prefer a workspace's existing scripts and nearby patterns over introducing new tooling. Keep shared behavior in the appropriate package rather than coupling runtime layers.
