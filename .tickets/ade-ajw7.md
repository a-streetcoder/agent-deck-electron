---
id: ade-ajw7
status: open
deps: [ade-mmgh, ade-qy2d, ade-dwdc]
links: []
created: 2026-10-14T23:54:53Z
type: chore
priority: 2
assignee: almoretti
---
# A1d: cut-over of the cheap stores (plan history, supervisor) to log projections; equivalence report; busy-day measurements


Sub-ticket of A1 (ade-c5h8), after A1b1, A1b2, A1c. Readers move, stores do not get rewritten: plan history (planEvents, today capped at 100 per session) and the supervisor view (memory-only today) read from the log projections, with the restart rule (requests pending at server.started are closed as interrupted). Loop-run and subagent-run stores STAY authoritative for run detail (outputs, validation stdio, definitionSnapshot, ownership proofs); the log holds facts and references (architect default pending the owner, D4 decision 5; one-sentence ADR 0004 amendment when confirmed). Checkpoints never move (capability records). Equivalence report: the startup diff counts, logged; a store is ready for its readers to move after 7 days of two-user use with zero mismatches (A2 moves the subagent/loop readers). Measure and record in the epic: file size and replay time for one busy day; projection snapshots become due when startup reconcile exceeds ~1 s (~50 MB). Document the rule "move readers, not stores" in ARCHITECTURE.md (or the orchestration reference from D2).

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only touched paths. Pure logic in packages/domain, IO in apps/server (VISION_ORCHESTRATION principle 2); no new dependency (principle 9). Keep the plan-history and supervisor write paths; only their read paths change. Remove the plan history cap only if the projection replaces the read.

## Acceptance Criteria

Plan panel and supervisor views read from projections with their existing tests passing; restart closes pending supervisor requests as interrupted (test); equivalence report test (zero on clean boot); measurements recorded in the epic note; docs updated.
