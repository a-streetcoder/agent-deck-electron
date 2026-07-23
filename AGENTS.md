# Agent guide

This repository is the Electron implementation of Agent Deck for macOS, Windows,
and Linux. The desktop shell is Electron, the interface is React/Vite, and the
Node/TypeScript server runs Pi through its JSONL RPC mode.

Use Node.js 22.19 or newer and pnpm. Install and validate from the repository root:

- `pnpm install`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm test`
- `pnpm test:pi`
- `pnpm test:e2e`
- `pnpm --filter @agent-deck/desktop dev`

Source layout:

- `apps/desktop` — Electron main process and preload bridge.
- `apps/web` — React/Vite renderer.
- `apps/server` — Fastify backend and application services.
- `packages` — shared domain, contracts, runtime, Pi host, resources, MCP, and memory packages.
- `e2e` — Playwright coverage for the web and Electron shells.
- `docs` — architecture history, parity audits, plans, and runtime references.

The public native macOS implementation at
`https://github.com/a-streetcoder/agent-deck` is a product and behavior reference,
not a build dependency. Port features deliberately; do not copy Swift/Xcode
artifacts into this repository.

Never edit bundled built-in resources in place. User edits must go through the
application's override and persistence paths. Keep write targets explicit in the
UI. Preserve real streaming and validate Pi-facing changes against the real
pinned Pi binary.
