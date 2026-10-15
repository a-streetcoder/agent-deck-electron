---
id: ade-m5ku
status: closed
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

## Notes

**2026-10-14T23:43:20Z**

2026-10-15 approved by the owner (lane A tree, reply: 'the rest is approved'); dispatch in dependency order.

**2026-10-15T02:47:09Z**

2026-10-15 merged (wt/ade-m5ku: 7744e4f, merge a18c80d, review round 0ba8119). Contrarian + GPT review24 applied: dispatch only on live agent intent in this process (restores/forks/restarts settle only, explicit settle pass after restore), Stop revokes ownership, per-generation dispatch history (plan event id), re-sent unchanged items keep state, optional task field (title = prompt otherwise), one assigned item at a time in the checkout / isolated items in worktrees in parallel, fan-in caps 2,000/20,000, skipped dependency satisfied, cap means wait, plan change mid-pass skips the rest, passes on slot release and delegation change, durable verifier runs with plan.item.verified and REJECT reason in note, stale verdicts discarded, parent cannot self-mark verified items, system actor with causation on server writes, assignee refused when delegation off or log read-only (new/changed only), null clears fields, case-insensitive name check, UI grouped by step with Show run via navigationRequest. Architect confirmed the three developer decisions. Tests: domain 61, server 55 (+1 POSIX skip), web 42, real-Pi plan-dispatch 2 (verifier REJECT end to end; restart mid-run settles on resume) + session-plan 1 + persist 1 + spawn 2 + delta 1. Known: parent is not prompted on completion (by design); verifier for an isolated item runs in the checkout; restart during verification waits for the agent to touch the plan; reassignment does not cancel the running child.
