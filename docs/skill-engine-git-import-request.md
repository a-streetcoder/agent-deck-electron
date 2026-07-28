# Request to the Syncr team — git-repo import in the skill-engine NAPI

**From:** agent-deck integration · **Re:** the last blocker for P4 (retiring agent-deck's
duplicate skill machinery) · **Status of P3:** landed on `main` — `EngineSkillStore` is wired,
`@a-streetcoder/skill-engine-native@0.1.3` drives all skill writes, both suites green.

## The ask, in one line

Expose **git-repo import + upstream-sync + conflict resolution** through the NAPI, so agent-deck
can retire `managedSkillRepositories` (its legacy git-repo importer) the way it already retired
its native single-skill write path.

## Why P4 is blocked without it

P4 is "delete agent-deck's duplicate skill machinery." Everything the _single-skill_ write path
did is now the engine's, so `NativeSkillStore` is deleted and the native `writeSkillFile` family
is prod-dead (kept only for resources tests, marked). But one live feature has **no engine
replacement**: importing a whole **git repository** of skills as a managed, re-syncable
collection.

The engine's NAPI (verified against the shipped 0.1.3 binary via your `smoke.mjs`) exposes:

```
writeSkill / deleteSkill / renameSkill / importLocalSkill / listSkills / fanOut
listRecoveries / restoreRecovery / acknowledgeRecovery
```

`importLocalSkill` imports **one local** skill file/dir. It does not clone a git repo, track an
upstream, detect drift, or resolve conflicts — so it cannot stand in for the importer below.
Deleting the importer now would break a working feature with no replacement, so it stays until
this lands. That is the only thing keeping P4 partial.

## What the legacy importer does (the behavior to match)

Routes under `/resources/skill-repos/*`, backed by `apps/server/src/skillRepositories.ts` +
`git.ts` + a `collection-v1` on-disk store:

- **Import** a git repo (blobless partial clone) as a named managed collection; a repo whose
  root holds `SKILL.md` is one skill, otherwise every `SKILL.md`'s parent dir is a skill.
- **check** — preview upstream changes without applying.
- **update** — pull upstream and report per-skill `conflicts` against local edits (never a silent
  overwrite).
- **refresh-merge** / **resolve** — resolve each conflict as **Take Remote** or **Take Local**;
  a displaced local skill becomes a **recovery** (list / restore / acknowledge), and the
  resolution records a per-skill tree hash (`skillHashes`, e.g. `tree-v1:<hash>` / `:missing`)
  so the next sync is a clean diff.
- **delete record / delete repo** — forget the collection, optionally removing its skills.

This overlaps almost exactly with what your handover says the engine already has internally —
"Git-provider imports validate transport/ref/subpath and refuse an existing destination" and
"Merge-aware sync: `resync_skill` reconciles cloud content against local edits (apply / 3-way
merge / conflict copy, never a silent overwrite)". The capability seems to exist in `syncr-core`;
it just isn't on the NAPI surface.

## The NAPI surface agent-deck would need

Shapes are illustrative — match your Rust model; the semantics are what matter. Errors as
`RESOURCE_*` message prefixes, same as the rest of the surface.

```
importGitRepo(home, projectRoot?, scope, { url, ref?, subpath? }) -> { collectionId, skills: SkillInfo[] }
checkGitRepo(collectionId)        -> { changed: SkillDelta[] }              // preview, no writes
syncGitRepo(collectionId)         -> { applied: string[], conflicts: string[] }
resolveConflict(collectionId, skillName, "remote" | "local")
                                  -> { recoveries: ResourceRecovery[] }     // displaced local -> recovery
forgetGitRepo(collectionId, { removeSkills: boolean })
```

Notes:

- **Recoveries must land in the store `listRecoveries(root)` reads.** In P3 agent-deck kept
  recovery on its _native_ `global-skills` store precisely because the legacy importer produces
  them there; when git import moves to the engine, its conflict displacements should surface
  through the engine's recovery API so agent-deck can consolidate recovery onto the engine in one
  step (it's already coded against the `*Recovery` methods on the contract).
- **Tree-hash state** (the `skillHashes` cursor) can stay engine-internal — agent-deck only needs
  the conflict list and recoveries, not the hash bookkeeping.
- Discovery/scoping/fan-out should reuse the same canonical `.agents/skills` model the rest of the
  engine uses; agent-deck keeps reading via its own pi scanner, unchanged.

## What we'll do on our side once it lands

Re-point the seven `/resources/skill-repos/*` routes at the new methods behind the `SkillStore`
interface (add the git-import methods to it), delete `skillRepositories.ts` + `legacySkillRepo.ts`

- the native `writeSkillFile`/`deleteSkillDir`/`renameSkillDir`/`importSkillFile` family and their
  resources tests, and move recovery from the native store to the engine. That closes P4.

Happy to review the surface before you build it — same as last time.
