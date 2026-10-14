---
id: ade-mmgh
status: open
deps: [ade-x3gn]
links: []
created: 2026-10-14T23:54:52Z
type: feature
priority: 1
assignee: almoretti
---
# A1b1: simple producers at call sites: session, turn, plan, checkpoint, supervisor, server.started; explicit user actors


Sub-ticket of A1 (ade-c5h8), after A1a. Emit at the existing single commit points (never by subscribing to the push bus): session.created / session.removed (sessions index; payload SessionMeta subset title, agentName, createdBy; session.removed is the tombstone, nothing else is deleted from the log); session.turn.completed at the idle reconcile where entry ids become stable (services/sessionManager.ts ~1284-1288; payload {entryIds[], toolCalls: {id, name, isError}[], label}, REFERENCES to Pi entries, never copies) for parent AND child sessions (verify child Pi runs reach the idle/getEntries reconcile; if not, add it: A3 depends on it) and turn.prompted {actor: user} where the RPC handler stages the author (sessionAuthors) so later agent events in that turn carry causationId; plan.changed from planEvents.record (SessionPlanEvent minus id/sessionId/at); checkpoint.created / checkpoint.rolledBack from checkpoints.capture / prepareRollback (CheckpointInfo plus gitRef; never sessionSnapshotPath or cwd); supervisor.request.opened / answered / cancelled from the bridge supervisor record/mark* points (SupervisorRequest; parent = subagentRun:cellId); server.started at boot (the restart boundary: the supervisor projection closes requests still pending at it, mirroring the memory-only SupervisorLog today). Explicit actor passed at the user action sites: answer supervisor, start/stop/apply/discard a loop, rollback, create session; everything else system or agent. No AsyncLocalStorage.

## Design

GUARDRAILS: worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (Syncthing-mirrored to the VM); single vitest files, eslint, prettier, per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only touched paths. Pure logic in packages/domain, IO in apps/server (VISION_ORCHESTRATION principle 2); no new dependency (principle 9). Payloads are whitelists: add a test that scans a recorded log for CAPABILITY_FIELDS keys, artifactRootToken, absolute data-dir paths and raw stdout and finds none. Stores stay authoritative and unchanged (dual-write).

## Acceptance Criteria

One unit test per producer; a real-Pi run records packages/domain/test/fixtures/events/plan.jsonl (plan + turn + checkpoint events) kept as a fixture for A2/A3; the child-session turn question answered in the note; the secrets scan test; tsc/eslint/prettier clean.
