# Persistent new-chat drafts (SES-35)

The selected product policy is to save new chats immediately, allocate Pi and an
isolated worktree only on the first send, and retain unstarted drafts until the
user deletes them. This intentionally differs from native's startup pruning.

Draft project, agent, model, thinking level, and worktree preference remain
editable. Opening, inspecting, or resuming a draft does not launch Pi. File
browsing and editing use the selected source directory before an isolated
worktree exists. Terminal and script execution require the first send. Extension
commands become available once Pi loads the session's extensions; the Models
screen's explicit discovery can populate extension-defined models beforehand.

Unsent text, image bytes, pastes, and file/folder references live in a separate
device-local `ComposerDraftStore`. Saves are atomic and acknowledged after sync;
the renderer coalesces edits, flushes before send, and participates in an Electron
quit barrier. Failed saves keep the window open, and failed startup retains the
message and draft identity for retry. Missing lifecycle fields preserve legacy
resume behavior. No resource bundle, native addon, or package pin changes.

## Evidence

- `session-drafts.pi.test.ts` uses the pinned real Pi process: no runtime or
  worktree before send or after restart; stable identity; multiple ordered deltas
  before finalization; failed allocation cleanup and retry; explicit deletion.
- `sessionDrafts.test.ts` covers concurrent activation and mutation exclusion.
- `composerDrafts.test.ts` covers full payload persistence, corrupt-data retention,
  invalid identities, symlink leaves, and linked/junction storage directories.
- `remoteComposerDrafts.test.ts` covers restore races, save failures/retry,
  coalescing, and close prevention until acknowledgment.
- `session-drafts.spec.ts` exercises browser restart with a changed server origin
  and failed first-send retry. `desktop-electron.spec.ts` exercises the real
  Electron quit handshake with a delayed save and checks the persisted final edit.
- Existing file/editor, preview, agent, extension, session, and history suites
  exercise draft-aware integration. Runtime-specific fixtures explicitly request
  immediate startup rather than assuming that all catalog rows have a process.
- Startup controls use the shared labelled controls, existing focus styles, and
  disabled isolation when no project is selected. Direct screenshot inspection
  found no clipping or overlapping controls. Component tests cover edit actions.

The primary agent reviewed correctness, persistence/error handling, and UI after
the implementation agents became unavailable due to usage limits; a separate
final reviewer was not available.

Final local checks passed typecheck, lint/design-system, format, native build/smoke,
web/backend builds, 81 focused server tests, the complete renderer suite, four
real-Pi draft tests, and 51 focused UI/Electron tests. The full Pi run's initial
fixture failures passed after correction. The broad UI run recorded 244 passed,
14 skipped, and 11 failures: ten passed after fixes or isolated rerun; the
remaining Doctor assertion expects pinned 0.82.0 but inspects globally installed
0.84.4. The full unit run's unrelated MCP loopback callback failure also reproduced
against unchanged baseline `dd83dc5`. These broad runs are not claimed green.

## Platform impact

| Area                                            | macOS                                                          | Windows                                                                                                                                      | Linux                                                               |
| ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Draft lifecycle, RPC, streaming, renderer       | Real Pi and browser tests run locally                          | Same portable tests included in existing CI matrix; not run locally                                                                          | Same portable tests included in existing CI matrix; not run locally |
| Draft storage                                   | Atomic replacement, sync, symlink rejection tested             | Existing directory-sync helper handles Windows; junction regression included in CI; not run locally                                          | Same filesystem tests included in CI; not run locally               |
| Desktop quit                                    | Real Electron delayed-save test run locally                    | Same IPC handshake; existing synchronous `taskkill` remains after the barrier; Windows CI has launch smoke but no inspector-driven quit test | Real Electron suite included in existing xvfb CI; not run locally   |
| Packaging, native modules, executable discovery | Native, web, and backend builds run; no packaging path changes | No new platform branch or module/package change                                                                                              | No new platform branch or module/package change                     |

Existing path containment, editor launching, process-tree cleanup, menus, and
keyboard conventions remain their owning components' responsibility. New draft
storage accepts session IDs rather than renderer-supplied filesystem paths.
Cross-platform CI results remain to be observed after push; this local acceptance
does not claim Windows or Linux execution.
