# Skill engine integration & the Syncr contract

How agent-deck consumes the shared, Syncr-owned skill engine, the current state of the lift, and
the contract between the two. Decision + rationale: [ADR-0002](adr/0002-consolidate-skill-engine.md).
Pending extension (git-repo import): [skill-engine-git-import-request.md](skill-engine-git-import-request.md).

The engine ships as **`@a-streetcoder/skill-engine-native`** (private GitHub Packages, Syncr-owned).
agent-deck consumes it for skill **storage**; it keeps the **reader** (pi's loader) and all
**runtime** (assignment → `--skill`, Loops, worktrees).

---

## Status (2026-07-28) — the engine is partially lifted in

**Lifted onto the engine (P3, on `main`):** every in-app skill **write** — create / edit / delete /
rename / import-local — goes through the engine addon via `EngineSkillStore` (`server.ts`).
Project-scope writes are enabled: the engine materializes them in `<project>/.agents/skills` and
agent-deck's scanner reads that catalog, so a created project skill is immediately visible.

**Deliberately NOT lifted:**

- **Reading the catalog** — permanent. pi's loader is the authority on "what exists"; agent-deck's
  pi-shaped scanner stays the reader. The engine's own `listSkills` is for Syncr's Tauri host.
- **Recovery** — _transitional_ on the native `global-skills` store (see [Recovery](#recovery--native-transitional)).

**Blocked — the wait:** retiring agent-deck's **git-repo importer** (`managedSkillRepositories`,
`/resources/skill-repos/*`). The git-repo surface itself **shipped in 0.1.4**
([skill-engine-git-import-request.md](skill-engine-git-import-request.md)), so import / sync /
forget are ready. The remaining gap is granularity: the engine resolves a conflict per **skill**
(`remote`/`local`), but agent-deck's UX is per **file**. Retiring the importer as-is would
downgrade that, so P4 waits on per-file conflict resolution in the NAPI. Request is out to Syncr:
[skill-engine-per-file-conflict-request.md](skill-engine-per-file-conflict-request.md).

**Suites:** resources 136/0, server 538/0 (+1 known `scriptRunner` child-process flake, green in isolation).

---

## The split

| Concern                                                                            | Owner                                                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Read / scan / render the catalog                                                   | **agent-deck** (pi scanner) — permanent                                                                      |
| Write / delete / rename / import-local; scoping; atomicity; version store; fan-out | **engine**                                                                                                   |
| Recovery (list / restore / acknowledge)                                            | **agent-deck native store, transitional** → engine once sync lands                                           |
| Git-repo import + upstream sync + conflict resolution                              | **agent-deck** (legacy) → engine; import/sync shipped in 0.1.4, blocked only on per-file conflict resolution |
| Assignment (default/project/disabled) → `--skill`; Loops; session worktrees        | **agent-deck** — never belonged to storage                                                                   |

## The contract — the shipped NAPI surface (0.1.3)

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
bundled at build. `pnpm add @a-streetcoder/skill-engine-native@0.1.3` into `apps/server`.

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

## Recovery — native, transitional

`listRecoveries` / `restoreRecovery` / `acknowledgeRecovery` are served from the **native**
`global-skills` store, NOT the engine. In agent-deck's single-user, no-sync scope the recovery
_producers_ are the legacy skill-repo (its "Take Remote" displaces a local skill) and native
displacement — both write there. The engine only produces recoveries during its sync/conflict path,
which agent-deck doesn't drive yet. When sync lands (with the git-import work), recovery moves to the
engine's `*Recovery` methods — already on the contract. _(Routing recovery to the engine prematurely
was a real bug: it blanked the legacy repo's recoveries. Guarded by `skill-repo-legacy`'s Take Remote test.)_

## Migrations — none

There is **no `.pi → .agents` migration**, and none is needed. The model is non-destructive
dual-read: the engine writes new skills to canonical `.agents/skills`, fan-out bridges global ones
into `.pi/agent/skills`, and both readers rank `.pi` first globally so nothing moves on disk. `.pi`
stops being read only when pi's own default moves to `.agents/skills` — a one-line lockstep change on
both sides, no data migration. _(An earlier draft of this contract called for a dedup-by-name
migration; that was the "canonical = highest read rank" confusion — `canonical` means the creation
target, not the top-ranked read. Cancelled.)_

## The work remaining (P4)

P4 = delete agent-deck's duplicate skill machinery.

- **Done (4a):** deleted the dead `NativeSkillStore`; added the scar-tissue pi round-trip guard on
  the real engine emitter (`apps/server/test/skill-engine-pi-roundtrip.test.ts`).
- **Kept, marked (4b):** the native skill-write fns (`writeSkillFile`/`deleteSkillDir`/`renameSkillDir`/
  `importSkillFile`) are prod-dead — only resources tests call them — and marked `ponytail:` in
  `writer.ts`. Not deleted while P4 stays partial.
- **Blocked on per-file conflict resolution.** The git-repo surface shipped in 0.1.4, but it
  resolves conflicts per **skill** while agent-deck's UX is per **file**
  ([skill-engine-per-file-conflict-request.md](skill-engine-per-file-conflict-request.md)). When
  that lands: re-point the eight `/resources/skill-repos/*` routes behind `SkillStore` (add the git
  methods to the interface), delete `skillRepositories.ts` + `legacySkillRepo.ts` + the native write
  fns + their tests, drop the collection-snapshot machinery, and move recovery to the engine. That
  closes P4. (The engine interface is otherwise mapped — 0.1.4 exports all six git methods.)

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
