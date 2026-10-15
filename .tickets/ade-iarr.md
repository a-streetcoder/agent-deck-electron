---
id: ade-iarr
status: open
deps: [ade-shxc]
links: []
created: 2026-10-15T07:37:07Z
type: feature
priority: 3
assignee: almoretti
---
# SRV-12c2: session move v2: live mirror, the local pointer follows the server session through the event log


The frozen pointer from v1 becomes a live view: the local app reads the server session's events (GET /events?sessionId= from A1c/A2, with a since cursor) through the SRV-12b client and renders the transcript and tree read-only, updating as the server session runs; prompts typed locally are forwarded to the server session (the server runs it on the owner's credentials as today). Requires the event log to carry the session's conversation facts and references the local app can resolve (transcript refs are fetched from the server route); where the log is not enough the local view falls back to polling the server session's transcript route.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths; no secrets or tokens in docs, tickets or logs. Contrarian pass before signoff; GPT review before merge. Parent epic ade-aier (SRV-12) holds the owner answers and the oracle memo: read its notes first. Depends on SRV-12c1. Read-only mirror first; no local write besides the forwarded prompt. Reuse the A2 node tree and the A1c transport; no new store.

## Acceptance Criteria

Tests: the mirror renders the server transcript and follows new turns; a forwarded prompt appears on the server session; an unreachable server shows a clear state; tsc, eslint, prettier clean.
