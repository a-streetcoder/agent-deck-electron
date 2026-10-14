---
id: ade-l1h0
status: open
deps: []
links: []
created: 2026-10-14T23:39:29Z
type: task
priority: 2
assignee: almoretti
---
# A0: evidence run: the same goals as singleAgent, makerChecker and agentPipeline with the loop engine


Lane A row A0 (docs/roadmap.md), principle 8 of VISION_ORCHESTRATION.md: evidence before orchestration depth. Pick three or four real goals from this repository (a small bug fix with a failing test, a doc restructure, a cross-package refactor) and run each as singleAgent, makerChecker and agentPipeline through the existing loop engine (apps/server/src/loopEngine.ts) with validation evidence on, same model, on the VM or locally one at a time. Record per run: validation outcome, iterations, tokens, wall time, checker decisions; write docs/evidence/orchestration-2026-10.md with the table and a one-paragraph reading. The result decides how much of A6-A12 is about topology versus legibility.

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. No code change expected; if the engine needs a flag to export token counts, that is a one-line change in this ticket. Spend cap: agree the model and iteration budget with the owner before running (uses the owner's subscription).

## Acceptance Criteria

The evidence document with at least three goals times three structures, raw run ids kept, and a recommendation line per A6-A12 row (topology / legibility / drop).
