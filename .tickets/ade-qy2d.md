---
id: ade-qy2d
status: in_progress
deps: [ade-x3gn]
links: []
created: 2026-10-14T23:54:52Z
type: feature
priority: 1
assignee: almoretti
---
# A1b2: diff-based producers for subagent runs and loop runs; startup reconcile imports history and repairs gaps


Sub-ticket of A1 (ade-c5h8), after A1a (can run beside A1b1). The subagent store (SubagentRunStore.commit) and the loop engine (LoopEngine.persist, which edits runs in place at 15+ sites) emit by DIFFING the public projection before and after each commit: pure diffSubagentRuns(prevPublic, nextPublic) and diffLoopRuns(prevPublic, nextPublic) in packages/domain return the events (subagent.run.created / updated / finished / removed with PublicSubagentRun = record minus CAPABILITY_FIELDS, created adds parentToolCallId which the record must now keep; loop.run.started / updated / finished, loop.iteration.started / updated, loop.timeline.appended, loop.child.upserted, loop.artifact.added, loop.review.changed with LoopRun minus paths and lock keys). *.finished fires on active -> terminal and its payload is A4's structured result (status, summary, error, tokens, durationMs, model, artifactRootId). The loop engine keeps a deep copy of the last public summary per run (in-place edits make prev === next otherwise; the property test catches it). Projections projectSubagentRuns / projectLoopRuns / projectSupervisor / projectPlans in domain. STARTUP RECONCILE: after the log opens and the stores load, emit diff(projection(log), publicView(store)) with origin: "reconcile": the first boot imports history, a crash between store write and log write is repaired, a clean boot emits nothing; boot recovery (interruptActiveRuns, loop interrupt) shows as system events. Loop children live in loopSessionSnapshots, not the subagent store: they become loopChild nodes under loopIteration (two child node kinds until A9; documented).

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only touched paths. Pure logic in packages/domain, IO in apps/server (VISION_ORCHESTRATION principle 2); no new dependency (principle 9). Property test: reduce(project(prev), diff(prev, next)) == project(next) over RECORDED sequences of store states (capture subagent-runs.json and a loop run at every commit during one real-Pi managed_subagent run and one makerChecker loop; save as fixtures). The equivalence report at startup (counts of reconcile events) is logged; zero on a clean boot.

## Acceptance Criteria

Property test green over the recorded sequences; first boot imports with origin reconcile and a second boot emits zero; recovery events present; fixtures packages/domain/test/fixtures/events/{managed-subagent,loop-makerChecker}.jsonl recorded; the secrets scan from A1b1 passes on them; tsc/eslint/prettier clean.
