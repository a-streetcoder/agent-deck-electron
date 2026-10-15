---
id: ade-k7s3
status: open
deps: [ade-shxc, ade-gfs4]
links: []
created: 2026-10-15T07:37:07Z
type: feature
priority: 3
assignee: almoretti
---
# SRV-12c3: session move v3: return trip, the server session comes back to the device (snapshot push with the owner GitHub connection, merge as PR on the server)


Reverse of v1: 'Bring back' on the mirrored session: the server makes the snapshot commit with the session owner's SRV-06 connection, pushes the transfer ref, the device fetches, restores the worktree and resets HEAD~1, imports the transcript with the cwd rewritten back; the server copy becomes the pointer. Also makes the server-side merge a push + PR as the session owner (the oracle's note: the server merge must become push + PR on the shared server) so shared work lands through GitHub, not a local merge on the VM.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths; no secrets or tokens in docs, tickets or logs. Contrarian pass before signoff; GPT review before merge. Parent epic ade-aier (SRV-12) holds the owner answers and the oracle memo: read its notes first. Depends on SRV-12c1 and SRV-06. Shares the export/import code with v1 (one module, direction parameter).

## Acceptance Criteria

Real-Pi test of a round trip local -> server -> local keeping the conversation and the working tree; the server merge opens a PR as the owner; tsc, eslint, prettier clean.
