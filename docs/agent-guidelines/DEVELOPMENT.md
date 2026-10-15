# Development guidance

Run commands from the repository root with Node.js 22.19+ and pnpm.

```sh
pnpm install
pnpm build:native
pnpm dev
pnpm build
```

`pnpm dev` runs the normal full-stack loop: Vite hot-reloads renderer changes, the server restarts under `node --watch` with the tsx loader, and Electron restarts for main-process or preload changes.

Server warnings and errors go through `apps/server/src/serverLog.ts` (fastify runs with `logger: false`) as one `[scope]` line on stderr: the terminal locally, `journalctl --user -u agent-deck-server` on the VM. Set `AGENT_DECK_DEBUG=1` to add stacks.

Useful focused commands:

```sh
pnpm build:native
pnpm build:web
pnpm build:backend
pnpm --filter <workspace-name> <script>
```

Loop catalog definition CRUD requires the pinned Rust 1.88.0 N-API addon. There is no JavaScript fallback: build it for the current Node platform and architecture before server, resource, Pi, or E2E tests. Registered Loop worktrees are retained for review and are not recursively removed by this addon or the Loop route.

Skill storage separately requires the prebuilt private `@a-streetcoder/skill-engine-native` addon pinned in `apps/server/package.json`; there is no JavaScript fallback, and `pnpm build:native` does not build it. Installing needs GitHub Packages access as described in [the skill-store contract](../skill-store-contract.md). For addon behavior or an upgrade, inspect the sibling Syncr source at `/Users/andrea/Documents/GitHub/Syncr`, verify the pinned package's actual exports, and keep `apps/server/src/skills/skillEngineNative.ts` synchronized. Do not replace real-addon checks with an injected fake.

Prefer a workspace's existing scripts and nearby patterns over introducing new tooling. Keep shared behavior in the appropriate package rather than coupling runtime layers.
