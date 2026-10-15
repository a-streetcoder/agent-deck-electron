---
id: ade-icbb
status: in_progress
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
