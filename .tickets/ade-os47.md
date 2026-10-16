---
id: ade-os47
status: in_progress
deps: []
links: []
created: 2026-10-15T23:38:56Z
type: feature
priority: 1
assignee: claude
tags: [contracts, server, web, migration]
---
# SES-01: the session record v2: provenance, location, workspace, launch; explicit lifecycle; migration

Implements ADR 0006 (docs/adr/0006-session-record-and-provenance.md). SessionMeta gains schemaVersion 2 and four grouped objects replacing the loose fields: provenance { kind: created|forked|moved|returned|spawned|imported|reviewed, from?: {sessionId, serverOrigin?} | {device, localSessionId} | {runId}, by: {user}|{agent}|'system', at } (replaces forkProvenance, forkedFrom, sharedFrom, the origin part of returnedFrom, loopReviewRunId, the spawned-child parent link; written once); location { kind: local|server, owner, live?: {serverOrigin, sessionId}|{device, sessionId}, transfer?: {direction, token, ref, until, mergePr?} } (replaces sharedTo, returnPending, mergePr); workspace {...six worktree fields}; launch { plan, resourceConfig, overrides {provider, model, extensions, skills, thinking}, fingerprint, refreshError }. lifecycle becomes draft|running|parked|ended|pointer|moving. transcriptSha256 recorded at move, return and fork. packages/domain gains allowedOperations(record, actor) (every refusal in prompt/steer/rollback/fork/merge/move/return routes goes through it) and lineage(records, id). session-authors.json retired: authors projected from the event log; provenance also emitted as a session.created event. Migration on project load (pure function, one test per old field, unknown fields preserved, written back once); PATCH routes refuse old shapes with 400 once both sides ship.

## Design

Order: (1) contracts + migration function + tests; (2) domain allowedOperations/lineage with the refusal matrix lifted from the existing routes (the ade-q0pz dispositions are the regression net: session_shared, session_moving, share_refused, return_in_progress, owner/operator checks); (3) server: persistence migration on load, routes switched to the grouped objects and to allowedOperations, authors projection from the event log, session-authors.json read as a one-off migration source then deleted; (4) web: SessionMeta consumers (pointer banners, fork chips, SessionShare, MirrorReadOnly, MergePullRequest, Run tree provenance) read the new objects; (5) docs: orchestration-reference 'Session record' section with the lifecycle table, remote-server-poc transfer sections. Single test files only on the Windows checkout; the real-Pi suites sessionMove/sessionReturn/session-worktree one at a time with --config vitest.pi.config.ts. Worktree E:\agent-deck-wt\<ticket>. No new store, no new screen.

## Acceptance Criteria

A project with old records opens, migrates once and is written back once (test with a fixture of every old block); every existing fork/move/return/merge/worktree/pointer test passes on the new shape; allowedOperations has a table test covering every (lifecycle, location, actor) refusal the routes made before, and the routes contain no field-presence checks for these decisions; session-authors.json is no longer written and authors still render; lineage() feeds the fork chip and the pointer banner; typecheck, lint, format and design-system green; GPT review of the full diff before merge; VM deployed with the migration applied to the shared projects and health 200.


## Notes

**2026-10-15T23:39:29Z**

2026-10-16 owner approved (exact word) ADR 0006 + this ticket. Started; worktree E:\agent-deck-wt\ade-os47 (wt/ade-os47).

**2026-10-16T00:38:23Z**

2026-10-16 implemented on wt/ade-os47 as 6313253..4372e87 (4 commits, 75 files): contracts v2 + LegacySessionFields, migrateSessionMeta/sessionLifecycle/allowedOperations(21 ops)/lineage in packages/domain, sessionOperations.ts adapter for every refusal, sessions.json migrated on load with sessions.v1.bak.json backup, web consumers switched, docs. Declared deviations: session-authors.json kept (event log lacks prompt hashes), no PATCH 400, launch has one resourceConfig, location.mergePr on location, transfer carries serverOrigin+sessionId, by={} without sign-in, provenance kept on return. Typecheck/lint/format/design-system/3 required real-Pi suites green. Contrarian + GPT (review60) running.

**2026-10-16T00:49:10Z**

2026-10-16 reviews: GPT (review60) BLOCKED: write-back without lock (downgraded: the store rewrites the whole file on every upsert already), fork winning over sharedFrom/returnedFrom in the migration (downgraded: only old fork-spread data), non-atomic backup, no version refusal (declined, both sides deploy together), location.kind trusted from the file, 'in' on a non-object provenance.from throws, authors store kept, spawned unimplemented. Contrarian: no security regression, refusal parity and missed readers verified; B1 ADR drift (amended in main), B2 legacy keys written by an old build onto a v2 record are ignored; should-fix: persisted location.kind, two owner sources (createdBy vs location.owner), transcriptSha256 means envelope at transfer and file at fork, round trip lineage lives in the event log, bare-id mid-move check lost on rename/plan-retry. Fix round 1 sent (8 items).
