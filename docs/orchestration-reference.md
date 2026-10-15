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

### Loop role launch defaults

Each Loop role child launches with a tool policy and a fallback outcome contract from
`loopRoleLaunchDefaults` (`apps/server/src/loopEngine.ts`). An agent's own `tools:` list is
filtered by the policy; with no `tools:` the child gets the set in the table. An agent's own
`defaultExpectedOutcome` always wins over the fallback outcome.

| Role (loop write target)                                                     | Tool policy  | No `tools:` frontmatter      | Fallback outcome      |
| ---------------------------------------------------------------------------- | ------------ | ---------------------------- | --------------------- |
| Maker / single agent, pipeline stage (checkout or worktree)                  | `configured` | Pi defaults                  | `directProjectWrites` |
| Triage (checkout or worktree)                                                | `configured` | `read`, `grep`, `find`, `ls` | `reportOnly`          |
| Checker (also gets `checker_shell`, below)                                   | `readOnly`   | `read`, `grep`, `find`, `ls` | `reportOnly`          |
| Any other non-evaluator role in an `artifactMarkdown` loop (branches always) | `readOnly`   | `read`, `grep`, `find`, `ls` | `reportOnly`          |
| Evaluator                                                                    | `none`       | none                         | `reportOnly`          |

Pi's default `bash` and file tools are not sandboxed to the loop checkout or worktree: a child
can reach the main checkout through absolute paths, and an authored `tools:` list is the way to
narrow it.

`managed_subagent` and `managed_parallel` children are unchanged: no policy, Pi defaults without
`tools:`, and `reportOnly` when the agent sets no outcome.

### Loop checker and verdicts

In `makerChecker` the order is maker, validation, checker, evaluator. The validation command
runs before the checker decides, and its result (passed or failed, classification, exit code,
command, and the last 2,000 characters of the last 16 KiB of stdout and stderr) is part of the
checker's prompt. A validation `spawnError` or `timeout` ends the run as `toolFailed` before any
checker or evaluator call.

A checker `FAIL` against a passed validation does not end the run. The evaluator is skipped (the
checker keeps its veto on success), the checker's report becomes the next maker's feedback, and
the timeline says "checker FAIL although validation passed; evaluator skipped, next iteration";
on the last iteration the run ends `notAchieved` (`maxIterationsReached`). This diverges from the
native app, where a checker `FAIL` is terminal: one wrong judge costs an iteration, not the run. A
checker `FAIL` with no validation configured, or after a failed validation, still ends the run as
`agentFailed`.

Besides its read-only tools the checker has `checker_shell` (`apps/server/src/checkerShell.ts`, a
Pi extension written per launch). It runs only `git status`, `git diff`, `git log` and `git show`
in the loop's working directory, without a shell, with options from an exact allowlist (no
abbreviations): `status --porcelain --short -s --branch`; `diff --stat --numstat --name-only
--name-status --cached -U<n> --unified=<n>`; `log --oneline -n <k> --max-count=<k> --stat
--name-only --format=oneline|short|medium`; `show --stat --name-only --format=…`; plus plain
revisions and repository-relative paths (no absolute paths, no `..`). Git runs with every
`GIT_*` variable removed, `GIT_CONFIG_NOSYSTEM=1`, an empty global config, empty hooks and
attributes files, `--no-pager --no-optional-locks`, `core.fsmonitor=false`, `diff.external=`,
`log.showSignature=false`, and `--no-ext-diff --no-textconv` on `diff`, `log` and `show`. It is
refused when the repository config defines `filter.*`, `diff.*` or `merge.*` entries, or a
`.gitattributes` file (or `info/attributes`) mentions `filter=`, `diff=`, `merge=` or `textconv`.
Every other command or option is refused before it executes, and the refusal is the tool's error
result. It does not run the validation command: the engine's result is already in the prompt.
Timeouts (30 s) and cancellation kill the git process tree (`processTree.ts`, shared with the
engine's validation run) and wait for it to exit.

Decision lines (checker and evaluator) are read by `parseVerdict`. The exact first non-empty line
is `strict`. Otherwise, on the first non-empty line or one of the next three, with markdown
emphasis removed, `lenient` accepts in order: the token alone (trailing punctuation trimmed);
`Verdict:` or `Decision:` followed by the token; an upper-case token starting the line followed by
a separator (`SUCCESS - …`); and, on the first line only, an upper-case token ending it right after
a sentence terminator (`…report the decision.SUCCESS`). A token inside or at the end of a sentence
(`not yet a SUCCESS`) is `missing`. Iterations record `goalVerdictParse` (evaluator) and
`checkerVerdictParse`. A missing verdict, from either role, is read as `CONTINUE`, and both a
lenient read and a missing verdict add a timeline note.

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
It returns `{results, timedOut}`, one structured result per id, built from the
caller's private run record (the owning parent gets the full summary and error with
real paths; the event log keeps the capped, redacted public view): `id`, `status`,
`summary`, `error`, `tokens`, `durationMs`, `model`; ids the session did not start are
`not_found`. On timeout (default 120 s, clamped to 240 s, under the bridge fetch's 300 s
headers timeout) unfinished runs report their current status. `cancel_subagent` aborts
the child's delegation signal, waits for its scope finalizer, and returns `{status}`
(`stopped`, or the final status of a finished run); a run still active afterwards
(a `managed_parallel` child, or one owned by another server process) or an unknown id
returns `{ok: false, reason}`. `managed_subagent` is spawn plus an in-process await of
the same child, so its tool result is unchanged.

Orphans: a parent abort (composer Stop) cancels every child of that parent still
running or still launching, awaited or not, including children spawned in earlier
turns; otherwise a spawned child keeps running after the turn until it finishes or is
cancelled. At most 8 spawned children (the `managed_parallel` maximum) run per parent at
once; spawn refuses the ninth. A running spawned child keeps its idle parent from
parking or refreshing resources; when the last one ends, the idle-parking deadline and
any deferred resource refresh are armed again.

### Plan dependencies and dispatch

A plan item may carry `dependsOn` (item ids), `assignee` and `verifiedBy` (agent names, compared
case-insensitively), `task` (the assignee's prompt; without it the title is the whole prompt) and
`isolated`. `set_session_plan` / `update_session_plan` refuse a cycle, an unknown or self
dependency, an unknown agent, `verifiedBy` equal to `assignee`, a parent marking a `verifiedBy`
item done (only its verifier's APPROVE does), and a new assignment while delegation is off or the
event log is read-only. `update_session_plan` clears `assignee`, `verifiedBy` or `task` with
`null`. A plan without `dependsOn` is the old checklist. The graph logic is pure
(`packages/domain/src/planScheduler.ts`): an item is ready when it is `todo` and every dependency
is `done` or `skipped` (skipped means not needed); a `blocked` item marks its `todo` dependants
`blocked`.

Plan generations: a plan event that sets a whole plan (`created`, `replaced`) starts a
generation; `plan.item.dispatched {itemId, runId, agentName, generation}` counts only within its
generation, so reused ids in a new plan start fresh. Re-sending an item with the same id, title,
task and assignee and no stated status keeps its `done` (or running `in_progress`) state, runId
and note, so adding an item does not re-run finished work and an in-flight run or verification
survives the rewrite.

The dispatcher (`apps/server/src/planDispatcher.ts`) runs a pass on each `plan.changed`,
`subagent.run.finished` and `subagent.run.removed` of a session, when a detached child slot is
released, when a plan is restored (reopen, fork, resume), and for every live session when the
delegation setting changes. A pass first settles: a completed run makes the item `done`, any
other end (failed, stopped, interrupted by a restart, record gone) `blocked`; with
`verifiedBy`, a completed run is reviewed by that agent as a durable read-only run (the Loop
checker profile: read-only tools plus git-only `checker_shell`; task `verify: <title>` with the
item task, the producer's summary up to 4,000 characters and, for an isolated item, the files
changed in its worktree), whose first-line verdict (D7 `parseVerdict`) is logged as
`plan.item.verified {itemId, runId, producerRunId, verdict, reason}`: `APPROVE` makes the item
`done`, anything else `blocked` with the reason as its `note`. A verdict for an item rewritten,
reassigned or given another verifier meanwhile is discarded and recomputed. Then it dispatches
the ready frontier through the `spawn_subagent` path (detached, the 8-child cap, the delegation
setting): one assigned item at a time in the session's checkout, isolated items in their own
worktrees alongside; the task is the item task plus its dependencies' summaries (2,000
characters each, 20,000 in all). At the child cap it waits for the next pass; if the plan changed
during the pass it leaves the rest to the next one. Server-written plan updates and dispatch
events are `system` and caused by the event that triggered the pass.

Only live intent dispatches: a session whose own agent set or updated the plan in this process.
Restores, forks, reopens and restarts settle but spawn nothing, and a run the user stopped
revokes it until the agent touches the plan again. The parent is not prompted when items finish:
it reads the plan on its next turn. The plan panel groups a plan with dependencies by depth and
shows each item's agents, verdict note and a Show run link (a toast when the card is hidden).

Not covered: a verifier of an isolated item runs in the session's checkout and sees the
worktree only through the listed files; reassigning a running item does not cancel its run (the
result is discarded and the item re-dispatched once the run ends); a run launched just as the
plan was replaced is recorded but not adopted by the new plan.

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

One fold of the log (`apps/server/src/eventReaders.ts`) feeds all four projections (subagent
runs, loop runs, supervisor requests, plan history): the startup reconcile, the after-gap
resync and both readers share it, and each read first folds what was appended since the last.
A read-only process (another one holds `writer.lock`) reads the writer's files the same way;
only the disabled log (it could not open) falls back to the stores. The merges are pure, in
`packages/domain/src/eventDiffs.ts`.

- **Plan history** (`GET /sessions/:id/plan-events`) takes membership and order from
  `projectPlans`, without the store's 100-per-session cap. Logged transitions keep log order;
  imported entries sit after their store predecessor (recorded as `afterId`); no clock orders
  anything. Items come from the store for the events it still holds; older ones are the log's
  copy, marked `source: "log"` (titles capped at 200 characters, paths redacted; per item id,
  title, status and, since A5, `dependsOn`, `assignee`, `verifiedBy`, `isolated` and `runId`;
  an item's `task` and `note` stay out of the log).
- **Supervisor requests** (`list_supervisor_requests`) take membership and status from
  `projectSupervisor`; this process's own requests stay exact (full text, live status), and
  one whose append failed is placed by `createdAt`. The restart rule: a request still pending
  at a later `server.started`, or at `writer.acquired` (a read-only process became the writer
  after the previous one died), reads as `interrupted` and is never offered for an answer.

At every boot the server logs one `[events] equivalence` line: `readOnly`, `failures`
(reconcile steps that threw), the subagent and loop reconcile and recovery counts,
`planImported` (plan history older than the log, imported once), `planReconciled` (store
entries the log lacked, written back), `planContentMismatches` (same id, different kind, item
ids or statuses) and `mismatches`. A clean boot reports zero mismatches. The supervisor store
is memory-only, so it has nothing to compare. A store is ready for its readers to move after
7 days of two-user use with zero mismatches.

Measured on one synthetic busy day (`AGENT_DECK_MEASURE=1`, `apps/server/test/eventCutover.test.ts`;
10 sessions, 5,212 events of every kind written through the real log, Windows dev machine,
2026-10-15, two runs):

| Measure                                                                     | Value                        |
| --------------------------------------------------------------------------- | ---------------------------- |
| Segment size                                                                | 3.6 MB (725 bytes per event) |
| Fold into the four projections from the writer's in-memory ring             | 2 to 3 ms                    |
| Fold from disk (a read-only open: parse the segment, then fold)             | 93 to 95 ms                  |
| Cold startup (open the log, reconcile both run stores and the plan history) | 93 to 95 ms                  |

Startup cost is dominated by parsing, and it grows with every day the log keeps. Projection
snapshots become due when startup reconcile exceeds about 1 s: at this rate about 35 MB of
log, or ten busy days.

### Human nodes (A8)

Three interactions that wait on a person are one node kind, `human`, in the event log and
the Run tree. The existing events, cards and answer paths stay; the human events are written
next to them (`packages/domain/src/humanNode.ts` maps each request shape).

| Kind           | Opens from                                       | Answered through                            | Parent in the tree       |
| -------------- | ------------------------------------------------ | ------------------------------------------- | ------------------------ |
| `loopApproval` | a Human Approval loop run at its checkpoint      | `POST /loops/runs/:id/resolve`              | the loop run             |
| `decision`     | a child's `need_decision` / `interview_request`  | `POST /supervisor/:id/answer`               | the child's subagent run |
| `askUser`      | the parent's `ask_user` tool                     | `POST /sessions/:id/asks/:requestId/answer` | the turn Pi is running   |
| `askUser`      | a Pi extension's blocking `extension_ui_request` | the `ui_response` RPC                       | the turn Pi is running   |

Events: `human.requested` (kind, prompt, options, timeout policy, `expiresAt`),
`human.answered` (`by`: the member who answered, and the answer), `human.expired` (the
policy fired), `human.cancelled` (closed without an answer: a tool's own wait ran out, the
subagent or session ended, a person cancelled). Prompts and answers are redacted and capped;
an MCP sign-in paste box's answer is withheld. On the shared server every member sees open
requests (Activity lists them first; the Run tree pins them at the top) and any member may
answer; the answer event records who did. A server restart interrupts every open human node
except a loop approval, which is durable.

Timeout policy, per request, default none (nothing expires that did not before):

- `askUser` from the `ask_user` tool: opt-in `timeoutPolicy: { afterMinutes, then, default? }`,
  at most 10 minutes, replacing `timeout`. `then: "default"` answers with the default (an
  offered title selects it, else free text) and the turn continues; `then: "blocked"` returns
  `timed_out` and marks the node blocked.
- `askUser` from an extension: none; the extension owns its wait.
- `decision`: none; the channel's fixed 110 s wait closes the request as cancelled, which
  the child already receives as an error.
- `loopApproval`: none; the checkpoint survives restarts, so a timer needs a stored policy
  on the loop definition first.

Desktop attention: the session kinds raise the session's attention marker (and so the
desktop notification). A loop approval has no session: the app announces it in-app only.

## Collaboration

The shared server (Cloudflare Access identity, per-user provider sign-in, credentials,
server-owned clones and per-session worktrees) is documented with the live setup in
[remote-server-poc.md](remote-server-poc.md) and decided in
[ADR 0003](adr/0003-shared-server-trust-model.md).
