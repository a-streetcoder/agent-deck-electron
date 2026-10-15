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

### Event log cut-over (A1d)

The rule is **move readers, not stores**. A store keeps its own writes; its readers move to a
projection of the event log (`<dataDir>/events/YYYY-MM-DD.jsonl`) one store at a time, and the
store keeps supplying detail by id. Loop runs and subagent runs stay authoritative for run
detail (outputs, validation stdio, definitionSnapshot, ownership proofs); checkpoints never move.

- **Plan history** (`GET /sessions/:id/plan-events`) takes its membership from `projectPlans`,
  without the store's 100-per-session cap. Items come from the store for the events it still
  holds (the log copy is capped and redacted), from the log for older ones.
- **Supervisor requests** (`list_supervisor_requests`) take membership and status from
  `projectSupervisor`. The memory log still holds this process's requests and their full
  text. The restart rule: a request still pending at a later `server.started` reads as
  `interrupted`, so it is never offered for an answer again.
- Both readers fall back to the store when the log is read-only (another process holds
  `writer.lock`) or disabled (`apps/server/src/eventReaders.ts`).

At startup the server logs one `[events] equivalence` line: the subagent and loop reconcile
counts, `planReconciled` (store plan events the log lacked, imported with origin `reconcile`
and their own time: history from before A1, or a lost append) and `mismatches`. A clean boot
reports zero. The supervisor store is memory-only, so it has nothing to compare. A store is
ready for its readers to move after 7 days of two-user use with zero mismatches.

Measured on one synthetic busy day (`apps/server/test/eventCutover.test.ts`; 10 sessions,
5,212 events of every kind written through the real log, Windows dev machine, 2026-10-15):

| Measure                                                                     | Value                        |
| --------------------------------------------------------------------------- | ---------------------------- |
| Segment size                                                                | 3.6 MB (725 bytes per event) |
| Replay of the whole log into the four projections                           | 156 ms                       |
| Cold startup (open the log, reconcile both run stores and the plan history) | 341 ms                       |

Startup replays all history (two passes: the run-store reconcile and the readers), so its cost
grows with every day the log keeps. Projection snapshots become due when startup reconcile
exceeds about 1 s: at this rate about 10 MB of log, or three busy days, well before the
~50 MB first estimated.

## Collaboration

The shared server (Cloudflare Access identity, per-user provider sign-in, credentials,
server-owned clones and per-session worktrees) is documented with the live setup in
[remote-server-poc.md](remote-server-poc.md) and decided in
[ADR 0003](adr/0003-shared-server-trust-model.md).
