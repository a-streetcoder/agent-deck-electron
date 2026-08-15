# Native functional parity audit — 2026-07-24 — Ale

> **Owner/scope:** Ale owns the 27 active P1/P2/P3 rows in this register, including all active prompt gaps alongside skills, instructions, and extensions. For the fixed baseline, taxonomy, shared evidence and corrections, historical closed/present rows, dependencies, limitations, and complete audit context, use Andrea’s canonical shared history in [`native-functional-parity-2026-07-24-andrea.md`](native-functional-parity-2026-07-24-andrea.md). Work only from the active rows below; do not cross into Andrea’s backlog.

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
| PRJ-04 | **P2**   | Divergent | Nested Xcode project discovery            | Native understands nested Xcode workspace/project structures more deeply.                                  | Some Apple projects are discovered or typed differently.            | **E:** `discovery.ts`. **N:** `ProjectDiscovery.swift`.                              |
| PRJ-05 | **P2**   | Divergent | Discovery symlink handling                | Electron skips linked child directories; native discovery rules differ.                                    | Projects reached through symlinks may be omitted.                   | Same as PRJ-04.                                                                      |
| PRJ-06 | **P3**   | Partial   | GitHub repository metadata                | Electron derives less project-level GitHub metadata.                                                       | Issue/release integration has less context.                         | **E:** project persistence/routes. **N:** project/GitHub services.                   |
| PRJ-07 | **P2**   | Divergent | Project environment model                 | Electron’s `.env` and launch environment behavior differs from native project preferences.                 | The same project can launch with different variables.               | **E:** `env.ts`, session launch. **N:** `EnvPersistence.swift`, project preferences. |
| DEV-04 | **P2**   | Partial   | Dev-server port ownership                 | Electron infers a port from its child output but cannot prove every matching port belongs to that process. | A stale/unrelated server can be previewed.                          | **E:** `scriptRunner.ts`, `PreviewPanel.tsx`. **N:** project server service.         |
| PRE-01 | **P2**   | Partial   | Frame-blocking preview                    | Preview uses an iframe, so X-Frame-Options/CSP can block common servers.                                   | The preview can be blank even when the server works.                | **E:** `PreviewPanel.tsx`.                                                           |
| PRE-02 | **P2**   | Divergent | Point-and-click inspector                 | Electron asks for a selector/note instead of letting the user click the page element.                      | Capturing UI context is slower and error-prone.                     | **E:** `PreviewPanel.tsx`, `elementContext.ts`.                                      |
| PRE-04 | **P3**   | Missing   | Preview history                           | Preview has no back/forward navigation history.                                                            | Testing navigation flows is awkward.                                | **E:** `PreviewPanel.tsx`.                                                           |
| TER-01 | **P2**   | Divergent | External terminal resume                  | Electron owns an embedded PTY but does not match native external-terminal resume flows.                    | Users who prefer their terminal cannot continue there the same way. | **E:** terminal gateway/drawer. **N:** terminal launch integration.                  |
| TER-02 | **P3**   | Missing   | Terminal tabs                             | A session has one terminal surface.                                                                        | Multiple commands cannot be organized separately.                   | **E:** `TerminalDrawer.tsx`.                                                         |
| TER-03 | **P3**   | Missing   | Terminal splits                           | Terminal panes cannot be split.                                                                            | Watching server and tests together is harder.                       | Same as TER-02.                                                                      |
| TER-04 | **P3**   | Missing   | Terminal groups                           | Terminals cannot be grouped/renamed.                                                                       | Large workflows become cluttered.                                   | Same as TER-02.                                                                      |
| DIF-01 | **P2**   | Partial   | Diff comparison scope                     | Electron focuses on working tree/available session diff and lacks all native branch/turn scope choices.    | Committed or earlier-turn changes can be harder to review.          | **E:** diff routes/contracts/panel. **N:** Git/diff views.                           |
| COM-01 | **P3**   | Missing   | Terminal-context composer chip            | Terminal selection/output cannot be attached as a dedicated composer chip.                                 | Referring Pi to terminal evidence is manual.                        | **E:** Composer/terminal.                                                            |
| CHK-01 | **P2**   | Divergent | Checkpoint restore versus rerun-from-here | Electron restores files/state but does not automatically rerun from that conversation point.               | Reproducing the intended branch requires extra steps.               | **E:** checkpoint routes/panel. **N:** runner/session store.                         |

## Doctor and onboarding

<!-- prettier-ignore -->
| ID     | Priority | Status   | Difference                      | Plain English                                                                         | Why it matters                                                                              | Evidence                                                                       |
| ------ | -------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| DOC-01 | **P2**   | Missing  | In-app runtime install          | Development/external Pi cannot be installed from Doctor.                              | Users must copy and run a command themselves.                                               | **E:** `doctor.ts`, `RuntimeScreens.tsx`. **N:** `PiAutoInstallService.swift`. |
| DOC-02 | **P2**   | Missing  | In-app runtime update           | Doctor cannot update an external Pi runtime.                                          | Runtime maintenance leaves the app.                                                         | **E:** Doctor UI. **N:** `PiAgentUpdateService.swift`.                         |
| DOC-03 | **P2**   | Missing  | In-app runtime repair           | A corrupt external runtime has no guided repair action.                               | Recovery is harder for non-experts.                                                         | Same as DOC-01.                                                                |
| DOC-07 | **P2**   | Partial  | GitHub connect action           | Issues depend on existing `gh` auth; Doctor lacks a full guided connect flow.         | New users can get stuck outside the app.                                                    | **E:** Doctor/issues routes. **N:** GitHub connection views.                   |
| ONB-01 | **P2**   | Partial  | Onboarding gates                | Electron checks core setup but not every native integration/readiness gate.           | Setup can finish while a chosen workflow is not ready.                                      | **E:** `OnboardingOverlay.tsx`. **N:** `OnboardingViews.swift`.                |

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
