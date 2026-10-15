---
id: ade-7jiy
status: in_progress
deps: []
links: []
created: 2026-10-15T07:25:21Z
type: feature
priority: 2
assignee: almoretti
---
# A6: capability profiles: pass rate, tokens and duration per agent and role from the run store; Agents screen; list_agents bridge tool


Lane A row A6 (docs/roadmap.md), re-scoped by A0 (docs/evidence/orchestration-2026-10.md): LEGIBILITY first. Aggregate per agent name and role (maker, checker, evaluator, stage, triage, subagent, verifier) from the subagent run store and the loop run store: runs, completed/failed/stopped counts and pass rate, median and p90 tokens (input/output when available) and durationMs, last run time, with a 30-day window and an all-time total. Prerequisite found by A0: loop children do not record tokens (loop children bypass subagent-runs.json): record tokens and model on LoopChildRecord at child settle (the engine already receives Pi usage in the child run result; add the fields to the public view and the A1b2 diff) so the aggregate covers loops too. Pure aggregation in packages/domain (over the public run records and loop runs; also expressible as a projection over the event log so A1e snapshots can carry it later). Server: GET /agents/:name/profile and a batch GET /agents/profiles; bridge tool list_agents returning name, description, role defaults and the profile summary so a parent can choose an agent on reliability (model-facing text capped). Web: the Agents screen shows the profile per agent (small table, no chart library). Relations (substitutes-for, requires) are NOT in scope (data later, not ontology).

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths. Principles in VISION_ORCHESTRATION.md bind the implementation (2 pure logic in domain, 7 legibility before depth, 8 evidence first, 9 files only); contrarian pass before signoff; GPT review before merge. Owner stance 2026-10-15: on the shared server everything is visible to every co-worker by design and that visibility is the advantage; secrets and capability tokens stay out of the log, content does not need hiding. Depends on A1 (closed) and the run stores. Do not change store schemas beyond the two loop child fields; aggregation is pure and tested over the recorded fixtures (packages/domain/test/fixtures/events) plus synthetic records.

## Acceptance Criteria

Domain tests for the aggregation (windows, roles, empty); server route tests; real-Pi test showing a loop child records tokens; web test for the Agents screen profile; the list_agents tool returns profiles for the project's agents; tsc, eslint, prettier clean.
