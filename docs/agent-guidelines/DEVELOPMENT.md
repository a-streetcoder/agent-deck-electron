# Development guidance

Run commands from the repository root with Node.js 22.19+ and pnpm.

```sh
pnpm install
pnpm build:native
pnpm dev
pnpm build
```

`pnpm dev` runs the normal full-stack loop: Vite hot-reloads renderer changes, the server restarts under `tsx watch`, and Electron restarts for main-process or preload changes.

Useful focused commands:

```sh
pnpm build:native
pnpm build:web
pnpm build:backend
pnpm --filter <workspace-name> <script>
```

Loop catalog definition CRUD requires the pinned Rust 1.88.0 N-API addon. There is no JavaScript fallback: build it for the current Node platform and architecture before server, resource, Pi, or E2E tests. Registered Loop worktrees are retained for review and are not recursively removed by this addon or the Loop route.

Prefer a workspace's existing scripts and nearby patterns over introducing new tooling. Keep shared behavior in the appropriate package rather than coupling runtime layers.
