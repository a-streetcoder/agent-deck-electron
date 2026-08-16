# Native functional parity audit — 2026-07-24 — Ale

> **Owner/scope:** Ale owns the 8 active P1/P2/P3 rows in this register (7 parity gaps plus DEF-01, a defect found while restoring CI), including all active prompt gaps alongside skills, instructions, and extensions. For the fixed baseline, taxonomy, shared evidence and corrections, historical closed/present rows, dependencies, limitations, and complete audit context, use Andrea’s canonical shared history in [`native-functional-parity-2026-07-24-andrea.md`](native-functional-parity-2026-07-24-andrea.md). Work only from the active rows below; do not cross into Andrea’s backlog.

## Register use

Each active row below preserves the original audit row verbatim. Status, evidence, and detail remain authoritative only to the extent described by the canonical shared history. Remove a row only after the acceptance behavior in the shared history and the validation reminders below is satisfied.

## Recommended acceptance and validation

These are recommended checks for future implementation and regression coverage. They were not generally run for the original audit. LOOP-27 later passed the focused macOS arm64 validation described in the audit method. RES-01/02/03 and SKL-02 later passed the scoped cross-platform validation described there. The full E2E run still had unrelated existing failures and is not recorded as passing.

### Repository checks

- Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` for affected Electron slices.
- Run `pnpm test:pi` for Pi launch, sessions, streaming, subagents, Loops, MCP, memory, providers, resources, or extensions.
- Run `pnpm test:e2e` for renderer/backend and Electron behavior. Main/preload changes require the real Electron Playwright path and clean shutdown assertions.
- Run focused native build/XCTest checks when native runtime behavior is the acceptance oracle.

### Critical behavior checks

- Assert Maker+Checker, Agent Pipeline, Parallel Agents, Discovery/Triage, and Human Approval retain distinct capability, ordering, outcome, cancellation, recovery, and persistence behavior; invalid configuration must fail closed without fallback.
- Cancel or crash every Loop/subagent phase. Verify processes, process groups, waiters, bridge tokens, streams, artifacts, timers, and worktrees are cleaned exactly once.
- Verify streaming remains incremental and ordered under parallel children. Bound all queues and retained output.
- Test final symlinks, symlinked ancestors, junctions/reparse points, and validation-to-write races for every create/edit/rename/delete path.
- For engine-backed collections, create multiple overlapping file changes plus a non-overlapping upstream change. Verify detail paths, reject a formerly valid stale merge ID with `409`, refresh to a new ID, apply mixed Keep Mine/Take Remote choices, and assert exact selected and automatically merged bytes. Retain compatibility coverage for pre-0.1.5/base-less imports.
- Put `SkillRepositories` or a persisted collection root behind symlinked ancestors. Clone, scan, watch, update, and delete must reject paths whose physical destination escapes the app-managed root.
- Force worktree creation failures. A session that requested isolation must not run in the primary checkout without explicit informed consent.
- Fork and rerun repeated identical messages. Verify the exact Pi entry and all original attachments are used once.
- Resume after restart and reconstruct images, files, folders, pastes, errors, attention, fork origin, plans, children, Loops, and artifacts from persisted records.
- Complete two background sessions and multiple events in one session. Badge count must equal distinct sessions awaiting review; notification click must select the source session.
- Test MCP OAuth state/PKCE, callback ownership, timeout, port cleanup, logout, token secrecy, source ownership, project assignment, and app quit.
- Calibrate memory with relevant, ambiguous, unrelated, embedding-unavailable, and secret-containing queries. Assert visible fallback and correct abstention.
- Validate release preflight for clean/dirty, ahead/behind/diverged, existing local/remote tag, push rejection, and rollback limits immediately before mutation.
- Validate the packaged macOS DMG and bundled Pi. Validate Windows/Linux packaging, native modules, PTY helpers, process-tree shutdown, signatures, and updates on those platforms when pipelines exist.

# Ale active difference register

## Skills and repositories

<!-- prettier-ignore -->
| ID     | Priority | Status    | Difference                        | Plain English                                                                                                                                                                                                                                               | Why it matters                                                                       | Evidence                                                                                                                                                  |
| ------ | -------- | --------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |

## Prompts, instructions, and extensions

<!-- prettier-ignore -->
| ID     | Priority | Status  | Difference                        | Plain English                                                               | Why it matters                                                 | Evidence                                                                               |
| ------ | -------- | ------- | --------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |

## GitHub issues

<!-- prettier-ignore -->
| ID     | Priority | Status    | Difference                           | Plain English                                                                              | Why it matters                                                    | Evidence                                                          |
| ------ | -------- | --------- | ------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------- |

## Projects, preview, terminal, files, diffs, palette, and checkpoints

<!-- prettier-ignore -->
| ID     | Priority | Status    | Difference                                | Plain English                                                                                              | Why it matters                                                      | Evidence                                                                             |
| ------ | -------- | --------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |

## Doctor and onboarding

<!-- prettier-ignore -->
| ID     | Priority | Status   | Difference                      | Plain English                                                                         | Why it matters                                                                              | Evidence                                                                       |
| ------ | -------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |

## CI recovery — 2026-08-16

`main` was red from 2026-08-03 (last green run) to 2026-08-16: 27 failed and 53
cancelled runs, one success in between. Both parity sessions kept pushing
against local gates that did not include the CI matrix, so failures accumulated
unseen. Seven commits took the Linux e2e leg from 9 failures to GREEN (run
31948883260, `e2e (ubuntu-latest)`: success — 247 passed, 1 flaky, 14
skipped, 0 failed). The unit legs still
carry their known machine-class failures (EPERM symlinks, the git
release-sync quartet, the 1 MiB avatar body).

- `8cfb6d8` — a same-id `session_rebind` tore the socket down and rejected the
  in-flight request that had caused it, so a SUCCESSFUL checkpoint rollback
  surfaced as "transport closed" with its confirm dialog stranded open. The
  client now re-subscribes over the existing socket. Also gave `git.test.ts`'s
  ~100-git-spawn "-50 exhaustion" test a 120s timeout; it had timed out in
  every completed CI run since the last green one.
- `a5b438d` — the resource refresh stamped `parkedAt` when it parked a session
  it was about to relaunch (advertising "Parked · resumes on next command" for
  a session that was merely restarting), and its replacement runtime inherited
  no idle edge, so idle parking never re-armed and the park-interrupted title
  helper never retried.
- `f61ffe0` — **the one production bug in this set.** `POST /sessions`
  fingerprinted launch resources from the REQUEST, not the cwd the session
  actually runs in, so every chat with no project and no explicit cwd stored a
  digest the resource refresh could never reproduce — and was therefore parked
  and relaunched at EVERY idle, forever. The churn also rebuilt the event ring
  under `transport-parity` and `subagent-durability`.
- `31fb469`, `be911c9`, `c8a44aa`, `5e11378` — ISS-08 moved the issue boards to
  the REST transport, but its test doubles never followed: the gh stubs still
  answered `--json` shapes, the fixtures had no GitHub origin for the REST path
  to resolve, the truncation disclosure had grown to name the type and
  close-reason facets, and the row-count selector matched each row's own
  `issue-*` children. Production was correct in all four.

**Process note:** `pnpm test:pi` runs in the same CI job AFTER `pnpm test`, so
it was skipped on every run while the unit step was failing — roughly two
weeks with no Pi-integration coverage at all. It executed again once the unit
step went green, which is how DEF-01 below surfaced.

<!-- prettier-ignore -->
| ID     | Priority | Status | Difference                                      | Plain English                                                                                                                                       | Why it matters                                                                                             | Evidence                                                                                                                                                                          |
| ------ | -------- | ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEF-01 | **P1**   | Open   | Transcript rebuilds EMPTY after a resource refresh | A resource refresh parks and relaunches the session; the rebuilt transcript then has NO cells, so the conversation disappears from the view.        | Looks like data loss to the user. The history is intact on disk, so a reopen recovers it — but nothing says so. | **E:** `test/extensions-discovery.pi.test.ts` "defers a streamed resource edit … rebinds once with history" fails on ubuntu + macOS. Instrumented: rebuilt cells `[]` while the pi session file holds 1185 bytes with BOTH `"role":"user"` and `"role":"assistant"` — so seeding after the relaunch yields nothing; NOT a flush race. Pre-existing: fails identically with `8cfb6d8`/`a5b438d`/`f61ffe0` reverted. |

## Analytics decision — blocked

<!-- prettier-ignore -->
| ID     | Priority | Status   | Difference                      | Plain English                                                                         | Why it matters                                                                              | Evidence                                                                       |
| ------ | -------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| ANA-01 | **P3**   | Decision | Analytics                       | Native has analytics; Electron does not.                                              | Telemetry needs an explicit privacy, consent, and retention decision before implementation. | **E:** no equivalent. **N:** `Analytics.swift`, tests.                         |

## On hold — distribution

These rows are assigned to Ale but paused until the required target systems, credentials, signing and publication channels, and installed-update tests are available. The ordering below is intentional. **DST-01 is the final implementation candidate regardless of its P1 priority.** Do not select it while another implementation-eligible active row remains. Its acceptance requires a real signed publication feed, release credentials, and an installed update test, which were unavailable during the 2026-08-12 parity loop.

<!-- prettier-ignore -->
| ID     | Priority | Status   | Difference                      | Plain English                                                                         | Why it matters                                                                              | Evidence                                                                       |
| ------ | -------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| DST-02 | **P1**   | Missing  | Independent bundled-Pi update   | Bundled Pi changes require a full app release.                                        | Critical Pi fixes cannot ship separately.                                                   | **E:** build Pi runtime/main launcher. **N:** `PiAgentUpdateService.swift`.    |
| DST-03 | **P1**   | Missing  | Windows release pipeline        | There is no production Windows build/sign/release workflow.                           | Windows support is not release-certified.                                                   | **E:** `.github/workflows`, builder config.                                    |
| DST-04 | **P1**   | Missing  | Windows signing/update pipeline | No Windows signing identity or update channel is wired.                               | Users cannot verify or safely update Windows packages.                                      | Same as DST-03.                                                                |
| DST-05 | **P1**   | Missing  | Linux release pipeline          | There is no production Linux packaging/release workflow.                              | Linux support is not release-certified.                                                     | Same as DST-03.                                                                |
| DST-06 | **P1**   | Missing  | Linux update pipeline           | No Linux update/distribution channel is wired.                                        | Linux users must update manually.                                                           | Same as DST-03.                                                                |
| DST-01 | **P1**   | Missing | Application auto-update | Packaged Electron cannot download and install application updates. | Users remain on old code until they reinstall. | **E:** no updater dependency/wiring; builder config. **N:** `UpdaterService.swift`. |
