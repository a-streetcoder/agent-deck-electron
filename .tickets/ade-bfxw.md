---
id: ade-bfxw
status: in_progress
deps: []
links: []
created: 2026-10-15T07:25:22Z
type: feature
priority: 2
assignee: almoretti
---
# A7: verifier role for ad-hoc orchestration: read-only profile, typed verdict, validation evidence first; shared with the plan dispatcher


Lane A row A7, re-scoped by A0: LEGIBILITY first, the producer never grades itself (principle 4). Today A5's plan dispatcher spawns a verifier with the loop checker profile ad hoc. Make the verifier a first-class role:  /  accept  with a target run id (the producer's run) and the item/task; the verifier runs with the read-only profile from D6/D7 (read, grep, find, ls, git-only checker_shell), gets the producer's summary (capped), the changed-files list (A3 reader) and, when a validation command is configured for the project or given in the call, the VALIDATION RESULT FIRST (run by the server before the verifier starts, as D7 does for loops); its verdict is typed (reuse LoopCheckerDecision and D7's parseVerdict: APPROVE/REJECT/CONTINUE/ASK_HUMAN with a reason) and recorded as an event  and on the run record; the A5 dispatcher switches to this role instead of its ad-hoc spawn. UI: the verdict shows on the subagent result card and in the Run tree (A2) as a chip with the reason; the Deck row shows the verifier as a child of the producer.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright; real-Pi files one at a time with --config vitest.pi.config.ts); no ssh, no push; stage only touched paths. Principles in VISION_ORCHESTRATION.md bind the implementation (2 pure logic in domain, 7 legibility before depth, 8 evidence first, 9 files only); contrarian pass before signoff; GPT review before merge. Owner stance 2026-10-15: on the shared server everything is visible to every co-worker by design and that visibility is the advantage; secrets and capability tokens stay out of the log, content does not need hiding. Depends on A4, A5 (closed) and D7's checker profile. One verifier implementation for loops, plan items and ad-hoc calls: factor the checker launch from loopEngine into a shared  used by the loop engine, the plan dispatcher and the bridge tool (no behaviour change for loops: the loops.pi tests must stay green). The verifier never writes (tests prove a write attempt is refused).

## Acceptance Criteria

Real-Pi tests: an ad-hoc verify call returns a typed verdict and records the event; a REJECT shows the reason on the card; the plan dispatcher uses the shared role (plan-dispatch.pi stays green); loops.pi green; unit tests for the verdict mapping; web tests for the chip; tsc, eslint, prettier clean.

## Notes

**2026-10-15T07:52:50Z**

2026-10-15 contrarian on 488e4c8: loop parity confirmed (prompt and parsing identical); dispatcher change is an improvement. BLOCKER: validationCommand lets a parent agent without bash run arbitrary shell -> gate on the parent's tools including bash (or undefined) and check the child cap before validating. Fix before close: verifier cwd/revisions for worktree targets; no verdict on a run continued since launch; cancelled verifier must not overwrite a verdict with 'missing'; subagent.run.verified must not reset latestIsFinished in subagentDelta; dispatcher catch path unchanged() guard + event; unit test pinning the loop checker prompt. Follow-ups: CONTINUE/ASK_HUMAN on plan items only block (legibility); verifier node linked to its tool call; A6 profiles should map role verify to checker; plan-dispatch.pi flake predates A7 (timing). Fix round sent to the developer; GPT review32 pending.

**2026-10-15T08:02:03Z**

2026-10-15 fix round ac5576a (amended trailer 342d2f4) covers the contrarian list; GPT review32 of the first commit: items 1,3,4,7 already covered; remaining 2 (validation runs with the session owner's env), 5 (verdict per verifier run), 6 (redactSecrets on validation command/output) sent as the final round.
