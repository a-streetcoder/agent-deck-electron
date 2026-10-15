---
id: ade-scu0
status: closed
deps: []
links: []
created: 2026-10-15T01:04:56Z
type: bug
priority: 2
assignee: almoretti
---
# D8: a corrupt loop-runs.json crashes startServer (warn callbacks reference fastify before declaration)


Found during A1b2 (ade-qy2d): when loop-runs.json (or the loop session snapshot store file) is corrupt at boot, the LoopEngine / LoopSessionSnapshotStore warn callbacks in apps/server/src/server.ts call `fastify.log.warn` before `fastify` is declared, so startServer throws instead of quarantining the file and starting with an empty store. Fix: capture the logger lazily (a small `warn` function that buffers until fastify exists, or construct fastify first), add a server test that boots with a corrupt loop-runs.json and asserts the server starts, the file is renamed aside, and the A1b2 reconcile emits no *.removed (quarantine guard). Also cover the "boot after the quarantine boot" case the A1b2 note lists: a missing store file after a quarantine must not report every logged run as removed (persist a quarantine marker next to the renamed file or treat a missing-but-logged store as empty-without-removals once).

## Design

GUARDRAILS as every ticket. Smallest fix in server.ts startup order; one test file.

## Acceptance Criteria

Test above green; existing eventReconcile tests green; tsc, eslint, prettier clean.

## Notes

**2026-10-15T02:57:38Z**

2026-10-15 merged (wt/ade-scu0: e3fdce5 + simplification ae74c2c). Contrarian + GPT review26 converged on the marker file being the risk; decision: no marker, a missing store file sets storeQuarantined (removals suppressed while missing or quarantined this boot; the first clean write recreates the file and the next boot reconciles normally). Crash fix: warn callbacks use console.warn (fastify created later with logger: false). Tests: eventReconcile 5 (three-boot scenario through startServer + valid-store-never-quarantined), loopEngine + subagentRunStore 103 (+1 skip). Known: the unrecorded-artifact warning is silent while subagent-runs.json is missing; outside deletion of a store defers removals by one write+boot. Follow-up D9 (ade-p5ik): silenced route warnings.
