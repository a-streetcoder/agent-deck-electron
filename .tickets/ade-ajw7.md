---
id: ade-ajw7
status: closed
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

## Notes

**2026-10-15T01:46:41Z**

2026-10-15 merged (wt/ade-ajw7: de30e63 + review round dcc2467). Contrarian + GPT review20 applied: log order for logged transitions with imports anchored after their store predecessor (afterId), reads not gated on the writer lock, writer.acquired boundary on promotion, one fold for all projections + parsed-segment cache (cold startup reconcile 341 ms -> 93 ms; snapshots due at ~35 MB / ten busy days), source: log on redacted plan copies, pure merges and equivalence in domain, equivalence line always logged with planImported/planContentMismatches/failures, measurement opt-in (AGENT_DECK_MEASURE=1) with temp cleanup, plan import inside try/catch. Tests: server event tests 47 (+2 skips: measurement, POSIX mode), domain 46, real-Pi session-plan-persist + subagent-supervisor-list + eventProducers.pi 4. For A5: widen plan.changed (dependsOn, assignee, verifiedBy) before its panel renders log history. Snapshot ticket: projectPlans never drops deleted sessions; /plan-events unpaged.
