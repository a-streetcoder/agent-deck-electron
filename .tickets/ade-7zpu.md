---
id: ade-7zpu
status: open
deps: []
links: []
created: 2026-10-14T18:16:28Z
type: task
priority: 1
assignee: almoretti
---
# PI-01: move Pi from 0.82.0 to 1.2.0 (pin bump, compile fixes, test literals)


Owner decision 2026-10-14: use the latest Pi (1.2.0, released 2026-10-12; 24 releases after our 0.82.0 of 2026-07-24) and adopt its new features and native MCP. This ticket is the pin bump only; feature adoption is PI-02/03/04.

Pins to change to 1.2.0: `@earendil-works/pi-coding-agent` in packages/pi-host/package.json, build/pi-runtime/package.json (deploy copy of pi-host, keep identical), apps/server/package.json, packages/domain/package.json; `@earendil-works/pi-ai` in apps/server/package.json and packages/resources/package.json; then `pnpm install` (lockfile). Check `pi-claude-bridge` 0.7.0 (packages/pi-host/package.json) against Pi 1.2: bump to the compatible release or record why it still works (its extension registers the mcp proxy tool and the bridge tools; Pi 0.83 removed deprecated TypeBox `Type.*` APIs and 0.99 renamed built-ins to `builtin:<name>`).

Compile fixes expected from the changelog: `ModelRuntime.create` / `ModelRegistry.getApiKeyAndHeaders` (headers string|null), `refresh()`/`setRuntimeApiKey` signatures (packages/resources/src/providerLogin.ts, providers.ts), `getSupportedThinkingLevels` from pi-ai (apps/server/src/routes/sessions.ts ~271,301), `SessionEntry` union gained `context_edit` (packages/domain/src/ingest.ts switch has a default, so compile only; PI-02 handles it), `RpcCommand`/`RpcResponse` unions in packages/domain/src/pi-types.ts and packages/pi-host/src/rpcProtocol.ts (0.84 `message_update` carries only `assistantMessageEvent`, which ingest.ts ~502 already reads; 0.99 per-input disposition on prompt/steer/follow_up; 1.1 `aborted` flag on `agent_settled`).

Version literals to update: e2e/tests/onboarding.spec.ts ~212,329, packages/pi-host/test/doctor.test.ts ~521, build/pi-runtime/test/doctor.test.ts ~521, packages/contracts/test/protocol-parity.test.ts ~187 (name only). Refresh `PROVIDER_CREDENTIAL_ENV_KEYS` in apps/server/src/routes/settings.ts from pi-ai 1.2 env-api-keys (and its comment). Provider id `azure-openai-responses` became `azure` in 1.0.3: apps/web/src/assets/providerLogos.ts ~51 keeps both keys; stored-config migration is PI-04. Docs: docs/agent-guidelines/ARCHITECTURE.md and DEVELOPMENT.md wherever the Pi version or RPC shape is described.

## Design

GUARDRAILS: this checkout is mirrored live to the VM and is its server working tree; never git checkout/switch/stash/reset; do not run `pnpm install` in the main checkout while the VM server is running (Syncthing excludes node_modules, but package.json and lockfile changes reach the VM at once and the VM needs its own `pnpm install` before the next restart). Work in a git worktree `E:\agent-deck-wt\<ticket>` on branch `wt/<ticket>` (see docs/agent-guidelines/WINDOWS.md), run `pnpm install` there, then typecheck per package (`pnpm --filter <pkg> exec tsc --noEmit`) and single test files; no full suites, no Playwright, no pack:win (low memory). Real-Pi tests (`*.pi.test.ts`) run one file at a time only after the typecheck is clean.

Deploy order after merge (architect): wait for Syncthing, `pnpm install --frozen-lockfile` on the VM, `pnpm build:web`, restart the unit, check `/health`, create one session end to end. Rollback: re-pin and reinstall. Record every signature change adapted in the ticket note; PI-02/03/04 start from that list.

## Acceptance Criteria

All package typechecks pass (packages/resources, packages/domain, packages/pi-host, apps/server, apps/web, e2e); pnpm-lock resolves pi-coding-agent, pi-ai, pi-agent-core and pi-tui at 1.2.0 and no 0.82.0 remains (grep); doctor.test.ts and protocol-parity.test.ts pass; one real-Pi test file (apps/server/test/injected-commands.pi.test.ts) passes against the 1.2 binary; a session created on the VM after deploy streams a reply, runs one tool call and settles; the ticket note lists the adapted signatures and the pi-claude-bridge decision.

## Notes

**2026-10-14T18:21:11Z**

2026-10-14 contrarian amendments (supersede the description where they differ): (1) pi-claude-bridge is an external npm package whose 0.7.0 reads context.systemPrompt and context.tools, removed in Pi 0.86, so on 1.2 Claude Code sessions would silently lose prompt and tools: bump to 0.9.3 (peer >=0.86.1) and verify once with Claude Code installed. The mcp proxy tool is NOT in that package; it is Agent Deck own generated bridge extension (packages/pi-host/src/bridge.ts). (2) Extension code generated as strings is not typechecked: guard the recall hook in bridge.ts ~188-201 with event.messageType === "user" (1.2 made before_agent_start a union on messageType and event.prompt is absent on custom-message runs); confirm injectedCommands.ts sendUserMessage needs no deliverAs. (3) --no-extensions (launchPlan.ts:86) since 0.99 also disables Pi built-in extensions including native MCP; keep it in PI-01 (no behaviour change), PI-03 decides. (4) Acceptance replaces the single real-Pi file with: injected-commands.pi.test.ts, packages/pi-host/test/bridge.pi.test.ts, mcp.pi.test.ts and one streaming or abort file, one at a time, on the VM in a separate rsync copy with its own pnpm install (never the served tree; check free -m first). (5) Deploy: stop the unit BEFORE the merge reaches the VM (Syncthing delivers package.json, lockfile and source out of order and pnpm install under a live server can hand a new Pi process a half-replaced store); after the sync completes run pnpm install --frozen-lockfile, pnpm build:web, start, /health, one session; the owner Windows checkout also needs pnpm install after the merge; rollback by re-pinning is valid only before any 1.2 session has written entries such as context_edit. (6) Open: whether 1.2 validation rejects the Agent Deck-only mcp.json fields (toolApproval, bearerTokenEnvVar); check and record.
