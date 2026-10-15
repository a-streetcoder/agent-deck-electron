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
command, last 2,000 characters of stdout and stderr) is part of the checker's prompt. A checker
`FAIL` still ends the run as `agentFailed` (the checker may fail on scope), but the iteration
keeps `validationPassed` and `validationEvidence` next to `checkerDecision`, and the timeline
says "checker FAIL although validation passed" when they disagree.

Besides its read-only tools the checker has `checker_shell` (`apps/server/src/checkerShell.ts`, a
Pi extension generated per launch). It runs, in the loop's working directory, only:

- the loop's configured validation command, exact text, through the platform shell;
- `git status`, `git diff`, `git log` or `git show` with plain arguments, without a shell, with
  `--no-pager`, `core.fsmonitor=false` and, except for `status`, `--no-ext-diff --no-textconv`.
  Arguments with shell characters or spaces inside one argument, and `--output`, `--ext-diff`,
  `--textconv`, `--exec`, `--upload-pack` and `--receive-pack`, are refused.

Anything else is refused before it executes, and the refusal is the tool's error result. Git
filters and attributes configured in the repository still apply to `status` and `diff`.

Decision lines (checker and evaluator) are read by `parseVerdict`: the exact first non-empty line
is `strict`; otherwise the first of the next three lines that is a decision token once markdown
emphasis (`*`, `_`, `` ` ``, `#`, `>`) and trailing punctuation are trimmed is `lenient`; else
`missing`. Iterations record `verdictParse` (evaluator) and `checkerVerdictParse`. A missing
evaluator verdict continues as before (`CONTINUE`); a missing checker verdict still fails the
run. Both a lenient read and a missing verdict add a timeline note.

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

## Collaboration

The shared server (Cloudflare Access identity, per-user provider sign-in, credentials,
server-owned clones and per-session worktrees) is documented with the live setup in
[remote-server-poc.md](remote-server-poc.md) and decided in
[ADR 0003](adr/0003-shared-server-trust-model.md).
