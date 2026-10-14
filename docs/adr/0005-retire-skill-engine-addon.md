# ADR 0005 — Retire the Syncr skill-engine addon: skill writes, recoveries and git import move to TypeScript

- **Status:** Accepted (2026-10-15, owner decision: "if we have too many things on that seam we can also move away from it")
- **Supersedes:** [ADR 0002](0002-consolidate-skill-engine.md) (consolidate on the shared skill engine) and the lift posture of [`docs/sync-seams.md`](../sync-seams.md)
- **Follows:** [ADR 0004](0004-orchestration-and-collaboration-direction.md), which removed Syncr as the coordination plane but kept the addon as a code dependency
- **Ticket:** ade-0v9e (design pass first); docs follow-up ade-dwji

## Context

ADR 0004 ended Syncr's role as the coordination plane, identity root and catalog, and said the
pinned native addon `@a-streetcoder/skill-engine-native` stays as a code dependency. Measured on
2026-10-15, that dependency is small in what it does for Agent Deck and large in what it costs:

- It performs only skill **writes and recovery**, **git import and sync** and the fan-out
  (about sixteen engine calls from five source files). Reads already stay Agent Deck's own
  pi-shaped scanner (`apps/server/src/skills/engineSkillStore.ts`).
- It is a mandatory native addon pinned at 0.2.0 from a **private registry** (the last macOS
  validation stopped at the bundled build because credentials could not fetch it), built per
  platform, and the source of most Windows packaging pitfalls in `docs/agent-guidelines/WINDOWS.md`.
- It imposes a contract nothing else needs (`docs/skill-store-contract.md`: never bypass
  `EngineSkillStore`, never change the pin casually) and a seam discipline on every slice
  (`docs/sync-seams.md`, enforced by the parity-loop skill) for a lift that ADR 0004 says will
  not happen.

## Decision

1. The skill-engine addon is **retired**. Writes, renames, deletes, recovery, local import, git
   import and sync are reimplemented in TypeScript behind the same `SkillStore` seam, with the
   same error codes, using `node:fs` and the existing `apps/server/src/git.ts` helpers.
2. Existing on-disk stores must open unchanged: the design pass of ade-0v9e reads the engine's layout
   (recovery tokens, git repo registry, any index) first; a migration is written only if needed.
3. `docs/skill-store-contract.md` and `docs/sync-seams.md` become historical; the seam
   requirement leaves the parity-loop skill; the skill-storage paragraph in `AGENTS.md` is
   rewritten after ade-0v9e lands.
4. The standalone Syncr app keeps its own engine; nothing here changes it.

## Implementation options (design pass, 2026-10-15)

The contrarian design pass on D1 measured the engine at about 5,400 lines of Rust with 165 tests
and 21 engine calls in use (the per-file git conflict feature included), owning a plain-file
layout (`~/.agents/skills/<slug>`, staging and `.<slug>.displaced.*` recovery folders inside the
catalog, `~/.agents/skill-repos/<id>/{collection.json,clone,base}`) whose hashes must match byte
for byte wherever a collection already exists. Two ways to honour this ADR:

- **A. Port to TypeScript** behind the same seam: about 2,500 to 3,200 lines plus the test
  triage; five sub-tickets (golden fixtures, local store, git collections with async hardened
  git, removal, docs). Removes the native build for skills; re-implements mature conflict logic.
- **B. Vendor the Rust crate** into this repository next to `loop-catalog-native` (same napi-rs
  CLI and targets, dependencies `sha2`, `hex`, `serde_json`, `junction`): removes the private
  registry, the token, the CI secret and the Syncr pin, keeps the 165 tests and exact hashes;
  the native build stays (it stays for `loop-catalog-native` regardless). Event-loop blocking
  and per-user git credentials are then fixed in Rust.

The owner chooses between A and B (D4). Until then D1 holds; inventory of real stores: this PC
and the VM hold no collections and no recoveries, so compatibility is a one-time concern only
where a collection is created later.

## Consequences

- Fewer moving parts to build and package: no private registry at build time, no native addon
  per platform for skills.
- Storage bugs no longer reproduce in one shared place with Syncr; Agent Deck owns its tests.
- Lane D work, independent of lane A; runs when a developer slot is free.
