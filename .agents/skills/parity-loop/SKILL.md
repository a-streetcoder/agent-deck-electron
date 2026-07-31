---
name: parity-loop
description: Autonomously implement, validate, close, and commit unresolved Agent Deck Electron/native parity rows in a continuous verified loop. Use for implementation work that closes parity-register rows, optionally from a supplied ID; do not use for report-only parity audits.
argument-hint: "[start-ID]"
---

# Agent Deck Electron parity loop

Repositories and register:

- Electron implementation: `/Users/andrea/Documents/GitHub/agent-deck-electron`
- Native behavioral reference (read-only): `/Users/andrea/Documents/GitHub/agent-deck`
- Active register: `/Users/andrea/Documents/GitHub/agent-deck-electron/docs/native-functional-parity-2026-07-24.md`

At runtime, use the first parity ID explicitly supplied with the skill invocation as the requested starting row. If none was supplied, treat it as `none`. Do not interpret template or shell interpolation syntax.

## Mission

Repeat without asking whether to continue:

1. Read the register and both projects.
2. Select the next unresolved difference.
3. Briefly state, in plain English, what you are picking up and why.
4. Investigate and plan the smallest safe implementation.
5. Implement it in Electron.
6. Prove the functionality and UI/UX are complete and high quality.
7. Remove each fully resolved row from the active register only after its acceptance checks pass.
8. Commit one coherent parity slice.
9. Immediately continue to the next unresolved difference.

Continue until no active differences remain or a stop condition requires the user.

## Non-negotiable rules

- Native Agent Deck is the product and behavioral reference, not code or architecture to copy. Never modify its repository.
- Use Electron's existing React/Vite UI, Electron shell, Node/TypeScript backend, typed contracts, persistence boundaries, and design system.
- Preserve real, ordered, incremental Pi streaming; never substitute simulated or buffered final output.
- Bundled resources are immutable. Put user changes through override and persistence layers.
- Preserve all staged, unstaged, and untracked work that predates this run. Never use destructive cleanup, hard reset, blanket restore/stash/staging, force operations, or broad staging.
- Never push or release without an explicit request.
- Keep each slice focused; exclude unrelated refactors and cleanup, and do not remove unrelated code, tests, comments, features, files, or public APIs.
- Never claim “100% complete” or “perfect” without direct evidence; state remaining uncertainty honestly.

## Prepare

Before selecting work:

1. Confirm both repository paths, branches, commits, and working-tree states.
2. Read both `AGENTS.md` files completely.
3. Read the Electron architecture, development, testing, and release guidance relevant to the work.
4. Read the native architecture, invariants, SwiftUI, testing, and release guidance relevant to the selected behavior.
5. Read the entire register: taxonomy, parity-present summary, active differences, dependencies, workstreams, validation guidance, and limitations.
6. Inspect current Electron source, tests, and recent history. The register is a lead, not unquestionable truth.
7. Record pre-existing Electron changes; do not overwrite, stage, remove, or commit them.
8. If a candidate overlaps dirty files and your changes cannot be separated safely, choose another eligible row. If this affects the requested row, stop and explain the preservation blocker.
9. Inspect available agents and delegation tools. Prefer suitable agents for reconnaissance, planning, implementation, and independent review, and use an approved Electron implementation agent when available. Report-only agents must not implement. If no suitable agent or delegation tool is available, proceed directly and perform the same planning and review duties yourself.

## Select the next item

Reread the register from disk at the start of every iteration.

For the first iteration, prefer a supplied starting ID after verifying it still exists and is unresolved; first handle any prerequisite needed for a safe, architecturally correct implementation. With no supplied ID, choose by:

1. safety foundations and prerequisites;
2. P0, then P1, P2, and P3;
3. register workstream/dependency order;
4. smallest independently testable slice.

A Decision row waits for its product decision. Never invent an ID. Default to one row per slice. Close tightly coupled rows together only when they form one inseparable implementation and each has its own acceptance evidence; do not distort architecture to force separate commits.

Before coding, verify the claimed gap against:

- current Electron implementation and tests;
- corresponding native implementation and tests;
- relevant contract, persistence, renderer, backend, preload/main, runtime, and packaging paths;
- runtime behavior when source is inconclusive.

Do not fabricate work for behavior already present: prove it and add only genuinely missing regression coverage. Remove a stale row only if its implementation is in the committed baseline or will be committed in this slice. If it exists only in pre-existing uncommitted work you do not own, leave the row active, report or select another item, and do not make a documentation-only commit that falsely claims resolution.

Start each item with only:

`Next: <ID> — <one short, non-technical sentence describing the user-visible difference and why it is next>.`

Then proceed unless a real decision blocks you.

## Investigate, plan, and decide

For each item:

1. When suitable agents are available, delegate focused investigation of Electron and native behavior, edge cases, and UI/UX. For non-trivial work, use a planning agent to challenge scope, dependencies, architecture boundaries, persistence/migration, and validation. Otherwise investigate and plan directly.
2. Reconcile all reports with source and runtime evidence; agent output is advice, not proof.
3. Convert the approach into a short visible Agent Deck plan with `set_session_plan`; maintain it with `update_session_plan` as work starts, completes, blocks, or materially changes.
4. Before editing, define:
   - exact user-visible outcome;
   - contract and persistence behavior, including restart/recovery for durable state;
   - cancellation and cleanup for asynchronous work;
   - applicable loading, empty, disabled, success, and error states;
   - keyboard, focus, and accessibility behavior;
   - focused, integration, real-Pi, UI/e2e, and applicable packaging evidence;
   - a macOS/Windows/Linux impact matrix classifying behavior as equivalent, platform-specific, or differently implemented/tested.
5. Prefer the smallest architecture-consistent solution; avoid speculative abstractions and dependencies.

Ask one focused question only when product, security, privacy, data ownership, destructive migration, compatibility, public API, or subjective UX judgment genuinely blocks safe work. Ordinary engineering decisions and test failures do not.

## Implementation rules

- Follow nearby patterns and put behavior in its owning runtime layer.
- Keep transport and persistence contracts typed. Preserve persistence formats or add explicit, tested migration/versioning.
- Keep Electron-only functionality behind preload; never expose Node directly to the renderer.
- Fail closed for path containment, writes, deletion, worktree isolation, credentials, and release safety.
- For filesystem work, test symlinks/realpaths, relevant junctions, and validation-to-use races.
- For asynchronous work, preserve cancellation and exactly-once cleanup of processes, process groups, timers, waiters, streams, artifacts, and worktrees.
- For Pi-facing work, inspect the pinned Pi package and use its protocol types rather than recreating them.
- Keep implementation, tests, and documentation in the same coherent slice.

## Sync-engine seams

Agent Deck consolidates durable user-owned state onto the shared Syncr-owned engine through explicit seams. The contract and live registry are `docs/sync-seams.md`; precedents are `docs/skill-store-contract.md` and `docs/adr/0002-consolidate-skill-engine.md`.

- Before a row touching durable or syncable state—skills, agents, prompts, Loop definitions, MCP configuration, session durable records, subagent run records, memory, or settings/assignments—read `docs/sync-seams.md` and the current engine contract.
- Where engine surface exists, consume it through the seam (`ctx.skillStore` for skills). Never call raw storage behind a seam or reimplement shipped engine capability; check the contract's N-API surface first.
- Missing engine surface is not a blocker. Implement the behavior on the **Electron side**, behind a seam: one narrow store interface before all mutations, injected at server construction, typed domain shapes, typed failure codes, and one write path. Routes and renderer never reach past it. Follow `SkillStore` in `apps/server/src/skills/skillStore.ts`. Here “native implementation” means this Electron-side host implementation, never editing the read-only native Agent Deck repository.
- Reads may remain host-side, following the scanner precedent. Runtime orchestration—assignment, streaming, process control, and worktrees—is never seam or sync material.
- When a slice creates or extends a durable store, update `docs/sync-seams.md` in the same slice with the domain, interface/write path, status, and engine surface needed for a future lift. If new capability naturally belongs in the engine, also draft a short Syncr request following `docs/skill-engine-per-file-conflict-request.md`, then continue the Electron-side implementation without waiting.

## Quality and acceptance gate

“Done” requires more than a working happy path.

### Functional and UI/UX proof

- Match the native portable user outcome and important semantics.
- Where applicable, verify persistence, reload, restart, resume, cancellation, cleanup, timeout, offline/failure, and destructive confirmation.
- Add focused regression tests beside changed code; verify negative and boundary cases.
- Use the pinned real Pi process for Pi-facing behavior, not mocks alone. For streaming, prove multiple ordered deltas arrive before finalization.
- Study the native workflow and all states. Match behavior and quality, not SwiftUI details.
- Use established Electron components, tokens, language, interactions, and hierarchy. Ensure discoverability with concise labels, practical help, sensible defaults, progressive disclosure, and actionable errors.
- Exercise applicable loading, empty, success, warning, disabled, destructive, long-content, overflow, and failure states.
- Verify keyboard-only use, tab order, initial/visible/restored focus, Escape/cancel, accessible names, roles, and announcements.
- Check representative window sizes, long names/content, dark/light/system themes, and cross-platform behavior.
- For every slice, reason explicitly about macOS, Windows, and Linux: path and filesystem rules; symlinks versus junctions/reparse points; shell/executable discovery; process-tree shutdown; permissions; keyboard conventions; menus; notifications; window behavior; native modules; packaging paths; and feature availability where relevant.
- A macOS pass does not prove Windows/Linux. Run available cross-platform CI/tests or add targeted tests. If platform-sensitive behavior lacks runtime or credible automation for an OS, keep the row active and report the verification blocker.
- For meaningful visuals, capture and directly inspect representative screenshots; compare with native where possible for clipping, overflow, hierarchy, density, contrast, and design-system consistency. Do not commit temporary screenshots.
- Check rapidly changing/streamed UI for jitter, reflow, stale state, lost input, duplicate actions, and performance regression. Run the design-system check for UI changes.
- Use an independent UI/UX/accessibility reviewer when a suitable one is available; otherwise perform and document the same review directly.

Persisted avatar/profile asset management and other user-facing feature logic are in scope. Pixel matching, SwiftUI-specific rendering, and purely decorative differences are not.

### Required checks

Run narrow checks while developing, then all applicable acceptance checks:

- focused unit/integration and relevant workspace tests;
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test`;
- `pnpm test:pi` for Pi-facing/resource/session/subagent/Loop/MCP/memory/provider/extension changes;
- focused Playwright and `pnpm test:e2e` for user-visible, renderer/backend, preload, Electron-main, or lifecycle work;
- `pnpm check:design-system` for UI work;
- relevant build, packaging, and packaged-layout checks for runtime/distribution changes;
- the per-slice macOS/Windows/Linux matrix, supported by tests or source/CI evidence and explicitly naming every untested platform.

Use real Electron Playwright for Electron behavior. Manually exercise workflows automation cannot prove. Run focused native builds/tests only when needed to establish the acceptance oracle, and never change native files.

### Review and acceptance

After implementation, use suitable available report-only agents to independently review: (1) correctness/architecture; (2) tests, edge cases, security, persistence, and regressions; and (3) UI/UX/accessibility for user-facing changes. Give them the IDs, acceptance criteria, exact diff, and checks run. If suitable reviewers are unavailable, perform each review directly and record that limitation. Resolve every material finding or explain with evidence why it does not apply, then rerun affected checks.

Accept a row only when:

- current evidence proves it is no longer missing, partial, divergent, unsafe, or unverified;
- focused regression tests pass;
- every applicable real-Pi, Electron/e2e, accessibility, restart, cancellation, error-state, visual, and packaging check passes;
- review has no unresolved material finding;
- pre-existing work remains intact;
- bounded uncertainty does not contradict acceptance.

If a broad check appears to fail for a pre-existing reason, reproduce it against the pre-change baseline when feasible and report honestly. Keep the row active if the failure materially weakens acceptance evidence.

## Update the register and commit

Only after acceptance:

1. Reread the register; confirm each resolved row remains active and unchanged in meaning.
2. Remove fully resolved rows rather than marking them done among active gaps.
3. Update only counts, summaries, dependencies, workstreams, and cross-references that would otherwise be false; preserve unrelated historical context.
4. Run documentation/format checks.
5. Review all staged, unstaged, untracked, and cached diffs.
6. Stage only this slice's implementation, tests, and register maintenance—never blanket-stage around unrelated work.
7. Prove no pre-existing work entered the commit and that it remains intact.
8. Commit one coherent slice as `parity(<ID-or-primary-ID>): <resolved user outcome>`; do not amend another slice, push, or release.
9. Confirm the committed diff and remaining worktree are exactly expected.

Give a compact completion note with resolved IDs/outcome, commit hash, strongest functional and UI/UX evidence, checks/results, and bounded residual uncertainty. Then immediately start the next iteration.

## Stop conditions

Stop only when:

- no active rows remain;
- a genuine user decision is required;
- credentials, hardware, platform access, or release infrastructure make acceptance impossible;
- pre-existing work cannot be preserved safely;
- a failure cannot be safely diagnosed or corrected in this session;
- two materially different attempts make no progress; or
- remaining time/context cannot support a fresh implementation and complete acceptance gate.

When blocked, neither remove the row nor commit an unaccepted slice. Report the row, exact blocker, completed work, gathered evidence, test state, and preservation status.

When the register is empty, list commits created in this run and separate verified evidence from unexercised behavior. An empty register does not prove whole-product perfection; claim only what accumulated evidence proves.
