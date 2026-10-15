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
  copy, marked `source: "log"` (titles capped at 200 characters, paths redacted, and only id,
  title and status per item: a richer panel must widen the `plan.changed` whitelist first).
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

## Collaboration

The shared server (Cloudflare Access identity, per-user provider sign-in, credentials,
server-owned clones and per-session worktrees) is documented with the live setup in
[remote-server-poc.md](remote-server-poc.md) and decided in
[ADR 0003](adr/0003-shared-server-trust-model.md).
