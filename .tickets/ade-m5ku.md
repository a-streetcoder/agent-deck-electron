---
id: ade-m5ku
status: open
deps: [ade-74y5, ade-oili]
links: []
created: 2026-10-14T23:39:31Z
type: feature
priority: 2
assignee: almoretti
---
# A5: plan with dependencies and a ready-frontier scheduler


Lane A row A5. SessionPlanItem gains dependsOn, assignee, verifiedBy; a pure ready-frontier scheduler in packages/domain (given plan items and their statuses, return the items ready to run); the server dispatches ready nodes through A4 and re-evaluates on completion or plan rewrite; the plan panel renders a DAG (small: topological lanes, no graph library). set_session_plan / update_session_plan accept the new fields; old flat plans stay valid (no deps = all ready).

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. Depends on A2 and A4. Principles 2 (pure logic) and 9 (no graph database). Contrarian: cycles, items reassigned while running, a verifiedBy item whose verifier is the producer (principle 4: refuse).

## Acceptance Criteria

Scheduler unit tests (chains, diamonds, cycles rejected, blocked/skipped propagation); route tests for the new fields; web test renders the DAG for a fixture; real-Pi test: a parent sets a plan with two independent items and one dependent, the server runs the two then the third.
