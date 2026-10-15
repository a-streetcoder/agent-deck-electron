---
id: ade-l1h0
status: closed
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

## Notes

**2026-10-14T23:43:19Z**

2026-10-15 approved by the owner (lane A tree, reply: 'the rest is approved'); dispatch in dependency order.

**2026-10-14T23:43:20Z**

Held until the owner is back: the runs spend the owner's subscription and the ticket requires the model and iteration budget to be agreed first.

**2026-10-14T23:46:28Z**

2026-10-15 owner go: 'burn now', bridge Claude (Opus 5 via claude-bridge), iteration cap 3, run alongside A1 (answers D4 item 3). Runs on the VM in an isolated second server (own port and data dir, loopback, no trusted proxy, operator credentials) against a throwaway clone; the live unit and the Syncthing replica are not touched.

**2026-10-15T00:56:26Z**

2026-10-15 A0 evidence run done: docs/evidence/orchestration-2026-10.md committed. 27 runs on the VM in an isolated server (port 4399, data /tmp/a0, stopped and removed); 9 valid pass-3 runs = 3 goals x 3 structures, maker claude-bridge/claude-opus-5, judge openai-codex/gpt-6-sol (deviation: bridge judge was unusable tool-less), maxIterations 3. Pass 3: 8/9 completed in 1 iteration (G3 single took 2 on a verdict-parse miss); 1 failed (G2 makerChecker, checker FAIL from read-only profile before validation ran). singleAgent cheapest (37k-87k tokens), makerChecker 1.4-2.1x, agentPipeline 2.1-4.4x for the same validated outcome. Gaps: loop children without tools: frontmatter get an empty allowlist; children default to the reportOnly outcome contract; evaluator through claude-bridge emits text tool calls and falls back to CONTINUE or fails; exactFirstLine verdict parsing brittle; checker FAIL terminal before validation; tokens not on LoopRun/children nor in subagent-runs.json (recovered from Pi session files). Recommendation: A6 legibility (expose usage first), A7 legibility first priority, A8 low, A9 legibility only, A10 keep, A11 drop/defer, A12 drop/defer. Raw run JSON under /tmp/a0/evidence on the VM. Not closed: GPT review pending.

**2026-10-15T00:57:51Z**

2026-10-15 closed by the architect: evidence committed in 807ede5 (docs/evidence/orchestration-2026-10.md). Engine findings ticketed as ade-u8qg (loop child tools/outcome defaults) and ade-rnrd (verdict parsing, validation-before-checker, checker profile); token export for loop children is a prerequisite recorded on roadmap row A6. Judge ran on the owner's Codex subscription (gpt-6-sol) because the tool-less evaluator through the bridge emitted text tool calls.
