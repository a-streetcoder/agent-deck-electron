# Skill engine integration & the Syncr contract

How agent-deck consumes the shared, Syncr-owned skill engine, the current state of the lift, and
the contract between the two. Decision + rationale: [ADR-0002](adr/0002-consolidate-skill-engine.md).
Historical extension request (now shipped): [skill-engine-git-import-request.md](skill-engine-git-import-request.md).

The engine ships as **`@a-streetcoder/skill-engine-native`** (private GitHub Packages, Syncr-owned).
agent-deck consumes it for skill **storage**; it keeps the **reader** (pi's loader) and all
**runtime** (assignment → `--skill`, Loops, worktrees).

---

## Status (2026-07-28) — the engine is lifted in

**Lifted onto the engine (P3, on `main`):** every in-app skill **write** — create / edit / delete /
rename / import-local — goes through the engine addon via `EngineSkillStore` (`server.ts`).
Project-scope writes are enabled: the engine materializes them in `<project>/.agents/skills` and
agent-deck's scanner reads that catalog, so a created project skill is immediately visible.

**Lifted onto the engine (P4, on `main`):** the **git-repo collections** feature. All eight
`/resources/skill-repos/*` + `import-git` routes are thin wrappers over `ctx.skillStore` (which
calls the engine's git surface, shipped in 0.1.5 with per-file conflict resolution). The engine
clones, discovers, sanitizes, and materializes imported skills into the ordinary catalog — so the
pi-shaped scanner reads them like any other skill; agent-deck's collection-snapshot machinery is
gone. **Recovery** also moved onto the engine (its displaced-tree store is the only producer now).

**Deliberately NOT lifted:**

- **Reading the catalog** — permanent. pi's loader is the authority on "what exists"; agent-deck's
  pi-shaped scanner stays the reader. The engine's own `listSkills` is for Syncr's Tauri host.

**One upgrade caveat (documented, not auto-migrated):** existing `collection-v1` records in
`app-settings.json` (imported by the OLD native path, skills held in private snapshots) and any
pre-existing native `global-skills` recovery entries are NOT migrated on first upgraded startup —
the old snapshot skills stop being scanned and the old recoveries stop being listed. **Re-import
the collection** (Syncr-endorsed; a fresh import materializes into the canonical catalog and gets
a base snapshot for per-file conflicts). This matters only for installs that used the pre-engine
importer; fresh installs are unaffected.

**P4 landing suites (historical):** resources 136/0, server 503/0. The later 0.1.5 per-file
acceptance slice added the real-addon route/store test described under P4 below.

---

## The split

| Concern                                                                            | Owner                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Read / scan / render the catalog                                                   | **agent-deck** (pi scanner) — permanent               |
| Write / delete / rename / import-local; scoping; atomicity; version store; fan-out | **engine**                                            |
| Recovery (list / restore / acknowledge)                                            | **engine**                                            |
| Git-repo import + upstream sync + per-file conflict resolution                     | **engine 0.1.5**, consumed through `EngineSkillStore` |
| Assignment (default/project/disabled) → `--skill`; Loops; session worktrees        | **agent-deck** — never belonged to storage            |

## The contract — historical core NAPI surface (0.1.3)

Verified against the shipped binary via Syncr `crates/skill-engine-napi/scripts/smoke.mjs`.
camelCase **named** exports; errors thrown as `Error` with a `RESOURCE_*` code prefix.

```
writeSkill(home, projectRoot?, scope, name, description?, body?) -> path to SKILL.md
deleteSkill(home, projectRoot?, scope, name)
renameSkill(home, projectRoot?, scope, name, newName)           -> path
importLocalSkill(home, projectRoot?, scope, sourcePath)         -> path
listSkills(home, projectRoot?, libraryRoots?)                   -> SkillInfo[]   // Tauri host; unused here
fanOut(root, slug)                                              -> tool ids linked
listRecoveries(root) / restoreRecovery(root, token) / acknowledgeRecovery(root, token)
```

- **Mutations take the full root set (`home`, optional `projectRoot`) AND a `scope`** — not a single
  target root. A write lands in the catalog the reader reads (possibly `.pi` during the migration
  window); `scope` bounds which catalogs may be touched. `projectRoot` is required for `project` scope.
- **`0.1.3` is the floor.** `0.1.2`'s meta package shipped without the generated NAPI loader
  (`native/index.js`) — install succeeds, `require` fails; `0.1.0/0.1.1` had no verified entry.

**agent-deck's side of the contract** — `apps/server/src/skills/`:

- `skillEngineNative.ts` — agent-deck's own `SkillEngineNative` interface + `loadSkillEngineNative()`
  soft-loader over the raw `/native` binding. agent-deck consumes the raw binding through _this_
  interface (not the package's typed surface) so the seam stays injectable for a fake in tests.
- `engineSkillStore.ts` — `EngineSkillStore implements SkillStore`: reads → scanner, writes →
  engine, `RESOURCE_*` message prefix → `ResourceCatalogCapabilityError` so routes keep their HTTP
  mapping. Roots resolve once up front; fan-out is best-effort.

### Distribution

Private GitHub Packages, scope `@a-streetcoder` (must match repo owner). Project `.npmrc`:

```
@a-streetcoder:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Install needs a `GITHUB_TOKEN` with `read:packages` (`gh auth token`); **end users need none** — the
`.node` is resolved via `optionalDependencies` (win32-x64, darwin-arm64/x64, linux-x64-gnu) and
bundled at build. agent-deck currently pins `@a-streetcoder/skill-engine-native` 0.1.5 in
`apps/server`.

## Reference shapes

**`SkillInfo`** (`packages/domain/src/resources.ts`) — what the scanner returns; the engine's
`ScopedSkill` maps 1:1:

| Field                    | Derivation                                                     |
| ------------------------ | -------------------------------------------------------------- |
| `name`                   | frontmatter `name`, else folder name                           |
| `description`            | frontmatter `description` (empty if absent)                    |
| `scope`                  | `builtin \| global \| library \| project` (no `legacyProject`) |
| `filePath` / `baseDir`   | absolute path to `SKILL.md` / to the skill **directory**       |
| `disableModelInvocation` | frontmatter flag (manual-only)                                 |
| `body`                   | SKILL.md with frontmatter stripped, trimmed                    |
| `disabled?`              | **agent-deck** sets this (app-level list), not the engine      |

**Scope + precedence** — dedup on parsed frontmatter `name`, FIRST-in-scan-order wins
(`scanner.ts`). Actual scan order (`skillCatalogDirs`, `paths.ts`):

```
1. <project>/.agents/skills   (project — engine-canonical; agent-deck reads it since the P3 fix)
2. <project>/.pi/skills       (project — legacy/Pi)
3. ~/.pi/agent/skills         (global — Pi primary; existing user skills)
4. ~/.agents/skills           (global — engine-canonical; legacy entry, not created by discovery)
5. collection roots           (library)
```

Global reads keep `.pi/agent/skills` above `~/.agents/skills` — the engine's `default_catalogs`
agrees, and fan-out bridges new global skills into `.pi/agent/skills`. Ranking `.agents` above `.pi`
**globally** is a deliberate lockstep change for the release pi's own default moves — not done here.

## Recovery — engine-owned

`listRecoveries` / `restoreRecovery` / `acknowledgeRecovery` are served by the engine. Git conflict
resolution can retain a displaced tree and returns engine `RecoveryInfo`, which `EngineSkillStore`
maps to Agent Deck's recovery contract. Pre-engine `global-skills` recovery entries are not migrated;
that bounded upgrade caveat is covered above.

## Migrations — none

There is **no `.pi → .agents` migration**, and none is needed. The model is non-destructive
dual-read: the engine writes new skills to canonical `.agents/skills`, fan-out bridges global ones
into `.pi/agent/skills`, and both readers rank `.pi` first globally so nothing moves on disk. `.pi`
stops being read only when pi's own default moves to `.agents/skills` — a one-line lockstep change on
both sides, no data migration. _(An earlier draft of this contract called for a dedup-by-name
migration; that was the "canonical = highest read rank" confusion — `canonical` means the creation
target, not the top-ranked read. Cancelled.)_

## P4 — closed

P4 = delete agent-deck's duplicate skill machinery.

- **4a:** deleted the dead `NativeSkillStore`; added the pi round-trip guard on the real engine
  emitter (`apps/server/test/skill-engine-pi-roundtrip.test.ts`).
- **4b (done):** re-pointed all eight `/resources/skill-repos/*` + `import-git` routes onto
  `ctx.skillStore` (net −4,441 lines); removed the collection-snapshot machinery from `server.ts`;
  deleted `legacySkillRepo.ts` and the legacy skill-repo test suites; moved recovery onto the
  engine. Two Codex passes (blind, second model); findings fixed (restore-before-lookup, list
  `storageMode`, XOR resolve body, project-import rejection, non-fatal conflict detail, no raw
  git-error leak). resources 136/0, server 503/0.
- **Kept, still marked dead (not deleted):** `ManagedSkillRepositories` (it's the app-data
  `dataDir` TRUST GATE, not just skill-repo machinery — `server.ts:203/207`); the native skill-write
  family in `writer.ts` (`writeSkillFile`/`deleteSkillDir`/`renameSkillDir`/`importSkillFile`, prod-
  dead, back only resources tests); and the native `ManagedSkillRepositoryStore` (Rust). Removing
  the native Rust is a separate follow-up.
- **Follow-ups:** the upgrade caveat above (re-import old collections) and the base-less whole-skill
  conflict card in `SkillsScreen.tsx` (only reachable for pre-0.1.5 imports). These remain bounded
  compatibility behavior, not an active per-file parity gap.
- **0.1.5 acceptance:** `skill-git-conflict.acceptance.test.ts` drives the real addon through the
  production resource routes and `EngineSkillStore` against local Git. It proves a formerly valid
  merge ID becomes stale after conflict-relevant state moves and maps to `409 LEGACY_MERGE_STALE`,
  refresh returns a new ID, mixed Keep Mine/Take Remote succeeds, and non-overlap plus exact bytes
  survive. `SkillsScreen.test.tsx` proves mixed choice submission and stale refresh/reset/retry.
  Runtime acceptance was macOS arm64; Windows/Linux packages exist but were not executed in this
  slice. The synchronous API exposes no deterministic interrupted-operation state; its supported
  stale refresh/retry path is covered.
- **Question out to Syncr — symlinked skill-tree mutation.** agent-deck's old native rename REFUSED
  a skill whose `SKILL.md` is a symlink (409 "unsafe"); the engine renames it (200). Safe in
  practice (the rename never dereferences the link; engine discovery doesn't follow symlinks), so
  the old refusal was agent-deck-side belt-and-suspenders — but confirm the engine should either
  refuse or knowingly allow symlinked skill trees on mutation. The unix-only regression test is
  `it.skip`-ped pending that answer (`apps/server/test/skill-rename.test.ts`).

## Packaging (Electron)

The engine addon is **external to `app.asar`**, mirroring `loop-catalog-native`: `build-backend.mjs`
stages the platform `.node` into `build/skill-engine-native/`, electron-builder copies it to
`resources/skill-engine-native/` (`extraResources`), and `loadSkillEngineNative()` requires it via
`process.resourcesPath`. A bare package import can't resolve from inside the bundled asar — that was
the cause of the packaged-app "skill engine addon unavailable" boot failure. The env override
`AGENT_DECK_SKILL_ENGINE_NATIVE_PATH` short-circuits the ladder for hermetic runs; dev/tests fall
back to resolving the package from `node_modules`.

## Contributor rule

**Consume `ctx.skillStore.*`, never the raw `@agent-deck/resources` skill functions**
(`writeSkillFile`, `deleteSkillDir`, `renameSkillDir`, `importSkillFile`, the recovery fns). A route
that reaches past the seam bypasses the engine.

```ts
// do
ctx.skillStore.deleteSkill(scope, name, projectId);
// not
deleteSkillDir(rootsFor(projectId), scope, name); // bypasses the engine
```

`scanSkills` (via the host's `scanSkillsFor`) stays the reader — that is the seam's one intentional
direct-to-resources path. Runtime (assignment → `--skill` in `routes/sessions.ts`, Loops, worktrees)
is not skill-store and stays put.
