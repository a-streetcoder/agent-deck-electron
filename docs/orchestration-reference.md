# Orchestration reference

Behaviour of delegation, managed children, merge cleanup and Loop snapshots, recorded as each
ticket landed. It is grouped under the views of [VISION_ORCHESTRATION.md](../VISION_ORCHESTRATION.md)
(task organisation, agent coordination, runtime state, collaboration). The architecture map and
its invariants are in [ARCHITECTURE.md](agent-guidelines/ARCHITECTURE.md); when this file and an
ADR disagree, the ADR wins.

## Task organisation

Loop structures, `managed_parallel` and the session plan are listed in
[VISION_ORCHESTRATION.md](../VISION_ORCHESTRATION.md#what-exists-today-by-view); the code is in
`packages/domain/src/loops.ts`, `apps/server/src/loopEngine.ts` and
`apps/server/src/bridgeTools.ts`. How a Loop's children end and what its snapshots keep is under
[Stopped child cards and Loop snapshots](#stopped-child-cards-and-loop-snapshots).

## Agent coordination

### Delegation cancellation

Composer Stop propagates each aborted bridge call's signal to its owned managed
children (including continuations), settles their supervisor waits, and prevents
queued parallel tasks from allocating; unrelated children and the parent session
remain alive. Cancellation waits for owned acquisition/process cleanup and retains
durable run/worktree identity; it is not session destruction or worktree deletion.

### Spawn, await and cancel

`spawn_subagent` returns `{runId}` once the child's run record is committed; the
parent's turn continues while the child runs in the parent session scope with its own
Pi process, worktree (`worktree: true`, fresh children only) and policy, exactly as a
`managed_subagent` child. `await_subagents({runIds, timeoutMs?})` subscribes to the
event log first and then reads the store, so a `subagent.run.finished` landing in
between is not missed; an in-process settle also wakes it when the log is read-only.
It returns `{results, timedOut}`, one structured result per id (`id`, `status`, the
4,000-character `summary` head with `summaryBytes`, `error`, `tokens`, `durationMs`,
`model`, `artifacts` (empty until runs record any), `checkpointRef` omitted while runs
record none); on timeout (default 120 s, maximum 240 s, under the bridge fetch's 300 s
headers timeout) unfinished runs report their current status. `cancel_subagent` aborts
the child's delegation signal, waits for its scope finalizer, and returns the run's
status (`stopped`, or the final status of a finished run). `managed_subagent` is spawn
plus an in-process await of the same child, so its tool result is unchanged.

Orphans: a parent abort (composer Stop) cancels every child of that parent still
running, awaited or not; a child spawned in an earlier turn keeps running until it
finishes, is cancelled, or the parent stops. At most 8 spawned children (the
`managed_parallel` maximum) run per parent at once; spawn refuses the ninth.

### Managed child provider settlement

Managed children consume the pinned Pi 1.2.0 stream through `agent_settled`,
not the first `agent_end`. `agent_end.willRetry` describes Pi's next provider
retry; `auto_retry_end.success` can arrive before the final low-level run ends
(and even after an aborted assistant). Neither event alone proves completion.
The latest assistant stop reason and failed retry result determine success only
at settlement. Terminal provider errors, including partial-text errors, persist
failed runs, finalize error cards, and reach the parent bridge as `isError: true`.
Recovered retries return the real final assistant text. Deltas, retry projections,
model/usage accounting, and the child continuation file remain live throughout;
the existing overall timeout and call-owned cancellation still reap the scope.

`agent_settled.aborted` (Pi 1.1) marks a settled child run as aborted even when
no aborted assistant message preceded it, such as an abort during a tool call;
the assistant stop-reason inference stays as the fallback.

## Runtime state

### Session merge cleanup

When merge retention is off, a committed merge stops the parent runtime and waits
for its children, then reaps owned child worktrees **before** removing the session
checkout used as their Git ownership anchor. Merge cleanup retains child history,
artifacts, and single-child continuation handles; it is not session deletion.
All children preflight before any physical removal. Starting/running children
fail closed, with current status checked again immediately before removal.
Replaced/unowned checkouts,
local files (including ignored files), or child commits not reachable from the
session HEAD prevent automatic merge cleanup. Keep-worktree retains both parent
and child checkouts for review without running this cleanup.

Cleanup failure remains a successful merge with typed `cleanup.status: failed`
and `worktree_remove_failed`; the parent checkout and metadata stay available.
Partial physical cleanup has durable retry markers. Review/save child work before
retrying session deletion, which retains its existing explicit-discard semantics.
Merge's allocation claim is temporary, so a retained parent stays usable. Session
DELETE holds child allocation denial through child cleanup, parent worktree/branch
cleanup, and index removal. Its scoped completion handle rolls back only its own
claim when the resumable index row survives, before releasing the delete mutation
lock; successful session deletion retains the denial. Repeated/stale completion
cannot clear an active or previously committed claim. Partial cleanup markers and
ownership proofs remain available for safe retry, without restoring removed children.

The session manager owns the mutation claims shared with HTTP routes. Resume
(including parked wake, resource refresh, and rollback) holds a claim throughout
async launch/preflight/history seeding, excluding merge/delete in both directions.
Coalesced resumes share that transaction; history actions may resume within their
existing claim. Merge also rechecks runtime ownership after child cleanup before
removing the parent checkout. The claim is released on success and failure.

### Stopped child cards and Loop snapshots

Child-scope cleanup terminalizes every interrupted open subagent card exactly
once, including constrained Loop children without a generic durable run sink.
The ordered live event retains partial output and collected model/usage metadata;
transcript reduction retains supervisor progress. Generic runs also persist
`stopped`. Completed/error cards are not rewritten, and unopened fresh runs do
not acquire synthetic cards (accepted continuations still replace their stable
card on startup failure/interruption).

Parent stop/destroy joins child finalizers before returning. Loop cancellation
uses that teardown before disposing snapshot tracking, so the final snapshot and
subsequent history restore contain stopped cards, not dead running work. This
fix does not retroactively reinterpret older snapshots or change crash recovery.

## Collaboration

The shared server (Cloudflare Access identity, per-user provider sign-in, credentials,
server-owned clones and per-session worktrees) is documented with the live setup in
[remote-server-poc.md](remote-server-poc.md) and decided in
[ADR 0003](adr/0003-shared-server-trust-model.md).
