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
pnpm --filter @agent-deck/desktop dev
```
