---
id: ade-63d3
status: closed
deps: [ade-brgd]
links: []
created: 2026-10-14T00:08:57Z
type: feature
priority: 0
assignee: almoretti
---
# SRV-02: REST origin and CSRF guard mirroring the WebSocket guard

Mutating REST routes have no origin guard while the WS upgrade does (wsHandler.ts isTrustedOrigin); in-app browser content (L2) and, in remote mode, any site can hit them. Add a Fastify onRequest hook for state-changing methods (POST/PUT/PATCH/DELETE) that accepts requests with no Origin (non-browser clients), a loopback Origin matching Host, or AGENT_DECK_PUBLIC_ORIGIN; reject others with 403. Cover /fs/dirs listing with the same rule. Reuse the existing isTrustedOrigin logic (one function, both callers). Keep the change self-contained so it cherry-picks onto main (touch only apps/server, no POC-only imports).

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first. Validation: server unit tests for the new hook plus the existing route suites; focused Playwright on one mutating flow.

## Acceptance Criteria

Route tests: cross-origin POST is 403, same-origin and no-Origin pass, AGENT_DECK_PUBLIC_ORIGIN passes; WS and REST share one origin predicate; e2e mcp and sessions specs still green; the commit applies cleanly on main (verified with git cherry-pick --no-commit in a detached worktree, then aborted).


## Notes

**2026-10-14T00:41:11Z**

Verified: Electron 43 main-process session.defaultSession.fetch sends no Origin (passes); renderer fetch/WS carry the page origin. Patch applies cleanly on main (git apply --check in a detached worktree).
