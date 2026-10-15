---
id: ade-2jry
status: in_progress
deps: []
links: []
created: 2026-10-15T08:01:14Z
type: feature
priority: 2
assignee: almoretti
---
# SRV-15a: a fork follows the forker: createdBy = requester on both fork paths, model checked against the forker's catalog, authors copied, Loop sessions refused, shared-checkout notice


Design pass finding: today a fork keeps the source owner on purpose (SessionManager.ts ~2088 'SRV-11: a fork keeps the source owner, and so its credentials'; docs/remote-server-poc.md ~391-394), so Bob forking Alice's session spends Alice's quota and pushes with her GitHub token. Owner decision in SRV-15: the fork of another member's session gets the forker as createdBy and runs on the forker's credentials (ADR 0003 decision 4 gets a one-line amendment in this ticket; remote-server-poc.md updated). Changes: (1) sessions.fork() takes the requester and sets createdBy (routes/sessions.ts already has it: forkAnnounce logs the requester); (2) materializeHistoryFork (historyActions.ts ~326 passes originalMeta) does the same; (3) model check: the inherited model must be in the forker's catalog (reuse the ownerModels guard from the drafts path, routes/sessions.ts ~300-315); otherwise 409 'pick a model' (today the fork launches and fails on the first prompt when e.g. the source ran on the owner's Codex login); (4) server.ts ~788-791 copies images and pastes into the fork but not sessionAuthors: copy the author store too so inherited turns keep the source author's label; (5) refuse forks of Loop review sessions (loopReviewRunId) and 'Loop ·' sessions with 409 (plain fork leaves a writable session inside a read-only review worktree; history fork breaks the diff gateway); (6) the fork shares the owner's checkout and blocks their merge while it exists (worktreeOwnerSessionId): the fork action in the UI says 'shares <owner>'s checkout'. Only the plain fork is offered on another member's session from the list; entry-level fork/rerun/edit on another member's session stay out of scope (they destroy the source runtime). MCP sign-ins do not carry over (per-agent-dir mcp-auth.json): document as intended.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths; no secrets or tokens in docs, tickets or logs. Contrarian pass before signoff; GPT review before merge. Parent ade-vlld (SRV-15, approved 2026-10-15) holds the design pass; read its notes first. Owner stance: on the shared server everything is visible to every member and that visibility is the advantage; build tools to use sessions, do not hide them. No dependencies; can start now. No store schema change; the identity plumbing already follows meta.createdBy at launch (SessionManager.ts ~1319-1329), resume, subagent and Loop children.

## Acceptance Criteria

Server tests: forker's createdBy, PI_CODING_AGENT_DIR and GH_TOKEN env in the spawn params for both fork paths; 409 for a model outside the forker's catalog; 409 for Loop review and 'Loop ·' sessions; authors survive the fork; no-identity (desktop) fork keeps today's behaviour. Web test for the shared-checkout notice. Docs: remote-server-poc.md fork paragraph, ADR 0003 decision 4 amendment dated 2026-10-15. tsc, eslint, prettier clean.

## Notes

**2026-10-15T08:18:57Z**

2026-10-15 contrarian on 04903a0: credential handover clean, merges cleanly against 71b4f95. BLOCKER: claude-bridge forks refused after each restart (ownerModels fetches bridge models only on an empty catalog) -> ensureBridgeCatalog first and new-session leniency. Fix before close: :max suffix, raw JSON 409 in the banner (responseErrorMessage), Fork button on Loop sessions, message-level fork reads the last model not the one at the fork point and lacks the PRV-01 swap, agent --model patterns wrongly refused, merge-blocking message wording. Follow-ups: per-message Fork/Re-run buttons show on every session (destroy the source runtime) -> hide for non-owners or correct the docs (ade-wruf); Bob's uncommitted work swept into Alice's merge auto-commit (co-author lines only from her session); Activity cannot yet say 'Bob forked Alice's session' (plain fork has no provenance card; ade-wruf); Loop forks refused also on the desktop (a fix: the copy was a fake Loop session), owner may want a 'continue this Loop conversation' path later.
