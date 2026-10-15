---
id: ade-t77e
status: open
deps: [ade-wgkk]
links: []
created: 2026-10-15T07:37:06Z
type: feature
priority: 2
assignee: almoretti
---
# SRV-12b: Make shared: the desktop app turns a local project into a shared one through the configured remote server and keeps the link


Desktop (local backend): a 'Make shared' action on a local project reads origin (git remote get-url origin), refuses when there is no origin or the host is not github.com, and calls the configured remote server's POST /projects { repo } (SRV-12a) through the user's Access session (the remote server URL and the Access cookie or service token the desktop already uses for remote mode); stores sharedTo { serverOrigin, projectId, repoId } on the local project (persistence layer, not bundled resources) and shows a badge 'shared on <server>' with Open on server. The local project list also marks shared projects on the server that match a local origin (same repoId), so the user sees local and shared side by side. The remote call layer (a small client for the server REST with the Access identity) is built here and reused by SRV-12c.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths; no secrets or tokens in docs, tickets or logs. Contrarian pass before signoff; GPT review before merge. Parent epic ade-aier (SRV-12) holds the owner answers and the oracle memo: read its notes first. Depends on SRV-12a. The desktop talks to one backend at a time (oracle): the remote call is an explicit fetch to the server origin, not a backend switch. No new dependency.

## Acceptance Criteria

Tests: Make shared with and without origin, non-GitHub origin refused, link stored and badge shown; the client handles 401 (not signed in on the server) with a sign-in hint; tsc, eslint, prettier clean.
