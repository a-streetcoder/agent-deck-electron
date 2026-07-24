# Agent Deck

The cross-platform Agent Deck desktop app for macOS, Windows, and Linux. It uses an
Electron shell around a React interface and a Node/TypeScript core that hosts
[`pi`](https://github.com/earendil-works/pi) subprocesses in JSONL RPC mode.

The original native macOS implementation remains available in the public
[`a-streetcoder/agent-deck`](https://github.com/a-streetcoder/agent-deck) repository and
serves as the product reference when bringing features to parity.

## Architecture

```
Browser (React)  ⇄ WebSocket (typed domain events, per-session seq)  ⇄ apps/server (Fastify)
                                                                          │
                                                              packages/pi-host (spawn pi --mode rpc)
                                                                          │ JSONL over stdio
                                                                     pi subprocess(es)
```

- `packages/domain` — pure: entities, transcript reducer, pi-event → domain-event ingestion, wire schemas.
- `packages/pi-host` — pi binary discovery, JSONL framing, subprocess lifecycle, RPC correlation, launch-flag assembly.
- `packages/resources` — `~/.pi/agent/` + `PROJECT/.pi/` scanning/watching, frontmatter, edit safety.
- `packages/testkit` — mock OpenAI-compatible streaming provider so tests run REAL pi with zero API keys.
- `apps/server` — session manager, ordered push bus, persistence, REST + WS.
- `apps/web` — React UI.

## Non-negotiables (enforced by permanent CI tests, not convention)

1. **Streaming is real**: `text_delta` events flow to the UI live. A CI test asserts ≥2 distinct
   deltas are observed before a message finalizes.
2. **Every milestone slice is verified against a real `pi` binary** before the next slice starts.

Protocol types are imported from the pinned `@earendil-works/pi-coding-agent` package — never
hand-rolled. The pi launch contract is documented in
[`docs/pi-rpc-launch-flags.md`](./docs/pi-rpc-launch-flags.md).

## Development

Requires Node.js 22.19 or newer. This matches the minimum required by the pinned
Electron toolchain.

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # pure tests
pnpm test:pi                               # integration tests against a real pi binary
pnpm test:e2e                              # full Playwright browser + Electron suite
```

Build the web interface and launch the Electron desktop app:

```sh
pnpm dev
```

The development command runs the complete hot-reload stack:

- React and CSS updates are applied immediately through Vite HMR.
- Server changes restart the watched Node process.
- Electron main-process and preload changes restart the Electron window.

Use `pnpm --filter @agent-deck/desktop dev:build` when you want the previous
production-style flow that builds the renderer once before launching Electron.

## macOS packaging

Create an unsigned Apple Silicon `.app` for local production-layout testing:

```sh
pnpm pack:mac
```

The result is `release/mac-arm64/Agent Deck.app`. It contains the compiled web
interface, a bundled backend, immutable built-in agents, the pinned Pi runtime,
and the Electron-rebuilt `node-pty` native module. Packaged builds run Pi with
Electron's embedded Node runtime, so users do not need to install Node, npm, or Pi separately.

The manually triggered **Release macOS** GitHub workflow builds either an arm64
or x64 DMG, signs the application with Developer ID, notarizes both the
application and DMG, staples their tickets, runs Gatekeeper/signature validation,
and uploads the DMG as a workflow artifact. It requires these secrets:

- `APPLE_DEVELOPER_ID_CERTIFICATE`
- `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD`
- `APPLE_NOTARY_API_KEY`
- `APPLE_NOTARY_KEY_ID`
- `APPLE_NOTARY_ISSUER_ID`
- `APPLE_TEAM_ID`

Organization-level Actions secrets are not available to private repositories on
GitHub Free. On that plan, add the same names as repository-level secrets; on
GitHub Team or Enterprise, the existing organization secrets can be granted to
this repository.

Validate a downloaded release again on a Mac with:

```sh
pnpm validate:mac -- /path/to/Agent-Deck-0.0.1-arm64.dmg
```
