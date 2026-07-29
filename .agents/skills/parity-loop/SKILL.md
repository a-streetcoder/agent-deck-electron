---
name: parity-loop
description: Resolve Agent Deck Electron/native functional parity gaps in a verified implementation loop. Use when implementing, validating, or closing rows in the Agent Deck Electron native functional parity register, optionally beginning with a user-supplied parity ID.
---

Run the Agent Deck Electron parity implementation loop.

Electron repository:
`/Users/andrea/Documents/GitHub/agent-deck-electron`

Native behavioral reference (read-only):
`/Users/andrea/Documents/GitHub/agent-deck`

Active parity register:
`/Users/andrea/Documents/GitHub/agent-deck-electron/docs/native-functional-parity-2026-07-24.md`

Requested starting row: use the parity ID supplied by the user, or `none` when no ID was supplied.

## Mission

Repeatedly:

1. Read the parity register and both projects.
2. Select the next unresolved difference.
3. Tell me very briefly, in plain English, what you are picking up and why.
4. Investigate and plan the smallest safe implementation.
5. Implement it in Electron.
6. Prove that both the functionality and UI/UX are complete and high quality.
7. Remove every fully resolved row from the active parity register only after its acceptance checks pass.
8. Commit one coherent parity slice.
9. Move immediately to the next unresolved difference without asking whether to continue.

Continue until no active differences remain or a genuine blocker requires me.

## Non-negotiable rules

- Treat native Agent Deck as the product and behavioral reference, not as code or architecture to copy.
- Do not modify the native repository.
- Implement with Electron’s existing React/Vite, Electron shell, Node/TypeScript backend, typed contracts, persistence boundaries, and design system.
- Preserve real, ordered, incremental Pi streaming. Never replace it with simulated or buffered final output.
- Never edit bundled resources for user changes; use the override and persistence layers.
- Preserve all staged, unstaged, and untracked work that existed before this prompt.
- Never use destructive cleanup, hard reset, blanket restore, blanket stash, force operations, or broad staging.
- Never push or release unless I explicitly request it.
- Keep changes focused. Do not mix unrelated refactors or cleanup into a parity slice.
- Do not claim “100% complete” or “perfect” without direct evidence. State any remaining uncertainty honestly.

## Initial preparation

Before selecting work:

1. Confirm both repository paths, branches, commits, and working-tree states.
2. Read both repositories’ `AGENTS.md` files completely.
3. Read the Electron architecture, development, testing, and release guides relevant to the work.
4. Read the native architecture, invariants, SwiftUI, testing, and release guidance relevant to the selected behavior.
5. Read the complete parity register, including its taxonomy, parity-present summary, active difference rows, dependencies, workstreams, validation guidance, and limitations.
6. Inspect current Electron source, tests, and recent history. The register is a lead, not unquestionable truth.
7. Record which Electron changes existed before this run. Do not overwrite, stage, remove, or commit them.
8. If a candidate overlaps pre-existing dirty files and your changes cannot be separated safely, choose another eligible row. If the requested row is affected and cannot be separated, stop and explain the preservation blocker.
9. Inspect which Agent Deck agents and delegation tools are available. Use suitable agents for reconnaissance, planning, implementation, and independent review. Report-only agents must not implement. Use an approved Electron implementation agent when available.

## Choose the next item

Reread the active register from disk at the beginning of every iteration.

If the requested starting row is not `none`:

- prefer it for the first iteration;
- verify that it still exists and is unresolved;
- handle a required prerequisite first if direct implementation would be unsafe or architecturally wrong.

Otherwise choose in this order:

1. safety foundations and prerequisites;
2. P0;
3. P1;
4. P2;
5. P3;
6. the register’s workstream/dependency order;
7. the smallest independently testable slice.

A Decision row waits for the required product decision. Never invent an ID.

Default to one register row per slice. A slice may close multiple tightly coupled rows only when they are one inseparable implementation and each row receives its own acceptance evidence. Do not split architecture unnaturally just to force separate commits.

Before coding, verify the difference against:

- the current Electron implementation and tests;
- the corresponding native implementation and tests;
- relevant contracts, persistence, renderer, backend, preload/main, runtime, and packaging paths;
- actual runtime behavior when source alone is inconclusive.

If the behavior is already present, do not create fake implementation work. Prove it and add only genuinely missing regression coverage if needed. Remove a stale row only when its implementation is already in the committed baseline or will be committed in this same slice. If the only implementation is pre-existing uncommitted work that you do not own, leave the row active, report/select another item, and do not create a documentation-only commit that falsely claims resolution.

At the start of each item, tell me only:

`Next: <ID> — <one short, non-technical sentence describing the user-visible difference and why it is next>.`

Then begin work without waiting for permission unless a real decision blocks you.

## Investigate and plan

For each item:

1. Delegate focused investigation of Electron behavior, native behavior, edge cases, and UI/UX to suitable available agents.
2. Use a planning agent for non-trivial work. Ask it to challenge scope, dependencies, architecture boundaries, persistence/migration needs, and validation.
3. Convert the agreed approach into a short visible Agent Deck plan with `set_session_plan`, and maintain it with `update_session_plan` as work starts, completes, blocks, or materially changes.
4. Reconcile every agent report against source and runtime evidence. Agent output is advice, not proof.
5. Define acceptance criteria before editing:
   - exact user-visible outcome;
   - contract and persistence behavior;
   - restart/recovery behavior for durable state;
   - cancellation and cleanup for asynchronous work;
   - loading, empty, disabled, success, and error states;
   - keyboard, focus, and accessibility behavior;
   - focused, integration, real-Pi, and UI/e2e evidence;
   - packaging evidence when applicable;
   - an explicit **macOS, Windows, and Linux impact matrix** stating whether the behavior is equivalent, platform-specific, or requires different implementation/testing on each OS.
6. Prefer the smallest architecture-consistent solution. Avoid speculative abstractions and new dependencies unless clearly necessary.

Ask me one focused question only when a product, security, privacy, data ownership, destructive migration, compatibility, public API, or subjective UX decision genuinely blocks safe work. Ordinary engineering decisions and test failures are not reasons to ask.

## Implementation rules

- Follow nearby Electron patterns and keep behavior in its owning runtime layer.
- Keep transport and persistence contracts typed.
- Keep Electron-only functionality behind preload; never expose Node directly to the renderer.
- Preserve existing persistence formats or add explicit, tested migration/versioning.
- Fail closed for path containment, writes, deletion, worktree isolation, credentials, and release safety.
- For filesystem work, test symlinks/realpaths, junctions where relevant, and validation-to-use races.
- For asynchronous work, preserve cancellation and exactly-once cleanup of processes, process groups, timers, waiters, streams, artifacts, and worktrees.
- For Pi-facing work, inspect the pinned Pi package and use its protocol types rather than recreating them.
- Keep implementation, tests, and documentation in the same coherent slice.
- Do not remove unrelated code, tests, comments, features, files, or public APIs.

## Functionality and UI/UX quality gate

“Done” requires more than a working happy path.

### Functional proof

- Match the native portable user outcome and important semantics.
- Verify persistence, reload, restart, resume, cancellation, cleanup, timeout, offline/failure, and destructive-confirmation behavior wherever applicable.
- Add focused regression tests beside the changed code.
- Use the pinned real Pi process for Pi-facing behavior; do not rely only on mocks.
- For streaming changes, prove multiple ordered deltas arrive before finalization.
- Verify negative and boundary cases, not just success.

### UI/UX proof

- Study the native workflow and all of its states.
- Use Electron’s established components, tokens, language, interaction patterns, and information hierarchy. Match behavior and quality, not SwiftUI implementation details.
- Make the feature discoverable and understandable without reading documentation.
- Provide concise labels, practical help text, sensible defaults, progressive disclosure, and actionable errors.
- Verify loading, empty, success, warning, disabled, destructive, long-content, overflow, and failure states that apply.
- Verify keyboard-only operation, tab order, initial focus, visible focus, Escape/cancel behavior, focus restoration, accessible names, roles, and announcements.
- Check representative window sizes, long names/content, dark/light/system themes where relevant, and cross-platform behavior.
- For every slice, explicitly reason through **macOS, Windows, and Linux**. Check path separators and filesystem rules, symlinks versus Windows junctions/reparse points, shell/executable discovery, process-tree shutdown, permissions, keyboard conventions, menus, notifications, window behavior, native modules, packaging paths, and feature availability wherever relevant.
- Do not assume a passing macOS test proves Windows or Linux. Run available cross-platform CI/tests or add platform-targeted tests. If a behavior is materially platform-sensitive and neither runtime nor credible automated evidence exists for one OS, keep the row active and report the verification blocker.
- For meaningful visual changes, capture representative screenshots and inspect them directly. Compare the workflow with native where possible and check clipping, overflow, hierarchy, density, contrast, and design-system consistency. Do not commit temporary screenshots.
- Check streamed and rapidly changing UI for jitter, reflow, stale state, lost input, duplicate actions, and performance regressions.
- Run the design-system check for UI changes.
- Use an independent UI/UX/accessibility reviewer after implementation.

Persisted avatar/profile asset management and other user-facing feature logic are in scope. Pixel matching, SwiftUI-specific rendering, and purely decorative differences are not.

### Required checks

Run the narrowest checks during development, then all applicable acceptance checks:

- focused unit/integration tests;
- relevant workspace tests;
- `pnpm typecheck`;
- `pnpm lint`;
- `pnpm format:check`;
- `pnpm test`;
- `pnpm test:pi` for Pi-facing/resource/session/subagent/Loop/MCP/memory/provider/extension changes;
- focused Playwright plus `pnpm test:e2e` for user-visible, renderer/backend, preload, Electron-main, or lifecycle work;
- `pnpm check:design-system` for UI work;
- relevant build and packaging checks for runtime/distribution changes, including packaged-layout validation when applicable;
- the per-slice macOS/Windows/Linux impact matrix, with tests or source/CI evidence for each OS and every untested platform called out explicitly.

Use the real Electron Playwright path for Electron behavior. Exercise the workflow manually when automation cannot prove interaction quality.

Run focused native build/tests only when necessary to establish the native acceptance oracle. Never change native files.

## Independent review

After implementation, delegate independent report-only review of:

1. correctness and architecture;
2. tests, edge cases, security, persistence, and regressions;
3. UI/UX and accessibility for user-facing changes.

Give reviewers the selected IDs, acceptance criteria, exact diff, and checks run. Resolve every material finding or explain with evidence why it does not apply. Re-run affected checks after fixes.

A row is accepted only when:

- current evidence proves the described behavior is no longer missing, partial, divergent, unsafe, or unverified;
- focused regression tests pass;
- all applicable real-Pi, Electron/e2e, accessibility, restart, cancellation, error-state, visual, and packaging checks pass;
- independent review has no unresolved material finding;
- pre-existing work remains intact;
- any remaining uncertainty is bounded and does not contradict the acceptance claim.

If a broad check fails for an apparently pre-existing reason, reproduce it against the pre-change baseline when feasible and report it honestly. Do not remove the row if the failure materially weakens acceptance evidence.

## Update the register and commit

Only after the acceptance gate succeeds:

1. Reread the register and verify every resolved row is still active and unchanged in meaning.
2. Remove each fully resolved row from the active difference register. Do not leave completed rows marked “done” among active gaps.
3. Update only counts, summaries, dependencies, workstreams, and cross-references that would otherwise become false.
4. Preserve historical context; do not rewrite unrelated findings.
5. Run documentation/format checks.
6. Review the complete staged, unstaged, untracked, and cached diffs.
7. Stage only this parity slice’s implementation, tests, and register maintenance. Never use blanket staging while unrelated changes exist.
8. Prove that no pre-existing work entered the commit and that it remains intact.
9. Commit one coherent slice using:
   `parity(<ID-or-primary-ID>): <resolved user outcome>`
10. Do not amend another slice’s commit and do not push.
11. Confirm the committed diff and remaining working tree are exactly what you expect.

Give me a compact completion note:

- resolved ID(s) and user outcome;
- commit hash;
- strongest functional evidence;
- strongest UI/UX evidence;
- checks and results;
- any bounded residual uncertainty.

Then immediately begin the next iteration without asking for permission.

## Stop conditions

Stop only when:

- no active difference rows remain;
- a genuine user decision is required;
- required credentials, hardware, platform access, or release infrastructure make acceptance impossible;
- preserving pre-existing work safely is impossible; or
- a failure cannot be safely diagnosed or corrected in this session;
- two materially different attempts produce no progress; or
- remaining time/context is insufficient for a fresh implementation plus the complete acceptance gate.

When blocked, do not remove the row or commit an unaccepted slice. Report the row, exact blocker, work completed, evidence gathered, test state, and preservation status.

When the active register is empty, list the commits created in this run and distinguish verified evidence from anything not exercised. Do not claim whole-product perfection solely because the register is empty; state only what the accumulated evidence proves.
