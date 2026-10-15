---
id: ade-icbb
status: closed
deps: []
links: []
created: 2026-10-15T02:16:56Z
type: bug
priority: 1
assignee: almoretti
---
# A4-fix: continuing a spawn_subagent run with managed_subagent throws 'Subagent transcript already registered'


Found by A3 (ade-mw03) while writing its real-Pi test: a run started by spawn_subagent (A4, ade-oili) cannot be continued with managed_subagent({continueSubagentID}): subagentRunStore.ts (~line 456) throws "Subagent transcript already registered: <runId>", which suggests the detached run's live transcript registration is never released when the spawned child finishes (the managed_subagent path releases it inside the tool call). Fix: release the live transcript registration when a spawned child settles (same place the parking re-arm from A4 runs), and make the registration idempotent for a continuation of the same run; real-Pi test: spawn_subagent -> await_subagents -> managed_subagent continue -> result; and spawn -> await -> spawn_subagent continue. Also check the reverse: a managed_subagent run continued by spawn_subagent.

## Design

GUARDRAILS as every ticket (worktree, single test files, real-Pi one at a time, no builds, no ssh, no push). Keep the edit in subagentRunStore.ts / SessionManager.ts spawn settle path.

## Acceptance Criteria

Both continuation directions work in a real-Pi test; existing subagent-spawn.pi and subagent-continuation.pi tests stay green; tsc, eslint, prettier clean.

## Notes

**2026-10-15T02:33:54Z**

2026-10-15 merged (wt/ade-icbb: 68a2143 + review round 05cfc6d). Root cause: the child's live transcript was released at scope close, after the terminal status that wakes await; fixed by releasing it in the terminal write step; the store's 'already registered' throw is kept as the regression guard (proved: the real-Pi test fails with the release reverted and the old await). Also: awaitSubagentRuns counts an in-process run finished only after its scope closes (no second Pi on the same session file), the continuation claim belongs to its caller and is released at acceptance (chain of continuations test with delayed teardown). Tests: store 34, await 6, continuation 19, sessionManager 120, real-Pi spawn 3 + continuation 1 + delta 1. Known: the transcript route can still read the session file during the old Pi's shutdown.
