# Request to the Syncr team — per-file conflict resolution for git collections

**From:** agent-deck integration · **Re:** the last gap before P4 closes · **Depends on:**
the git-repo collection surface shipped in `@a-streetcoder/skill-engine-native@0.1.4`
([skill-engine-git-import-request.md](skill-engine-git-import-request.md), addendum in the Syncr handover).

## The ask, in one line

Let a conflicted skill be inspected and resolved at **per-file (per-path)** granularity, not
only whole-skill `remote`/`local` — so retiring agent-deck's legacy importer preserves its
existing conflict UX instead of downgrading it.

## Why this is the last blocker

P4 (retire `managedSkillRepositories`, delete the native write family, move recovery to the
engine) is otherwise fully unblocked by 0.1.4. The one thing that would be _lost_ in the swap
is granularity: agent-deck today resolves a merge conflict **per file within a skill**, and
that granularity is hard-wired into both the wire protocol and the UI (`SkillsScreen.tsx`). The
engine's `resolveGitConflict(collectionId, name, "remote"|"local")` settles the **whole skill**
in one direction. Swapping onto it as-is is a user-visible feature regression, so we're asking
for the per-path surface before we cut over.

## The UX to preserve (what exists today)

On `update`, non-overlapping changes auto-merge; only skills where **both sides moved the same
path** surface as conflicts. For each such skill the UI renders a list of the overlapping
**paths**, each with its own _Keep Mine / Take Remote_ choice and a `local → remote` kind
transition (e.g. `file → directory`). Current shapes:

```ts
interface SkillPathConflict { path: string; local: "file"|"directory"|"missing"; remote: "file"|"directory"|"missing"; }
interface SkillMergeConflict { name: string; mergeId: string; paths: SkillPathConflict[]; }
// resolve body — one entry per file; omitted paths default to "mine":
{ name, mergeId, choices: Array<{ path: string; resolution: "mine" | "remote" }> }
```

A conflict can also go **stale** (upstream moved again before the user resolved): the resolve
returns `LEGACY_MERGE_STALE` and the UI re-derives the conflict (`refresh-merge`) with fresh
paths. That staleness guard must survive too, or a resolve could apply against a moved target.

## The gap in 0.1.4

```
syncGitRepo(home, projectRoot?, collectionId)        -> { applied, conflicts: string[] }   // per-SKILL names
resolveGitConflict(home, projectRoot?, id, name, "remote"|"local") -> Recovery[]            // whole-skill
```

`conflicts` names the skills but exposes no per-path detail, and `resolveGitConflict` can't mix
"take my version of file A, their version of file B" within one skill. Both are needed to keep
the current experience.

## The NAPI surface requested

Shapes illustrative — match your Rust model; `RESOURCE_*` prefixes as elsewhere.

```
conflictPaths(home, collectionId, name) -> PathConflict[]
   // PathConflict { path, local: "file"|"directory"|"missing", remote: "file"|"directory"|"missing" }
   // the overlapping paths for one conflicted skill; reads state, writes nothing.

resolveGitConflict(home, projectRoot?, collectionId, name, choices) -> Recovery[]
   // choices: Array<{ path, resolution: "mine" | "remote" }>
   // per-path settle. Omitted paths default to "mine" (keep local). Displaced local
   // content lands on the recovery surface, same as the whole-skill form.
```

We're happy for this to **replace** the whole-skill `resolveGitConflict` (whole-skill = all
paths chosen `remote` or all `mine`) or sit beside it — your call on the cleaner surface; the
per-path form is the one we can't synthesize host-side.

## Semantics to preserve

- **Only overlapping paths are conflicts.** One-sided path motion still auto-applies in `sync`;
  `conflictPaths` returns just the both-sides-moved paths (empty ⇒ not actually conflicted, same
  `RESOURCE_NOT_FOUND` guard `resolveGitConflict` already has).
- **Kind transitions are part of the detail** — `local`/`remote` each `file|directory|missing`,
  so the UI can show `file → directory` and warn on a type change.
- **Staleness is detectable.** If the conflict's fileset changed since `conflictPaths` was read
  (your per-skill fileset-hash cursor already tracks this), `resolveGitConflict` should refuse
  with a distinct code (a `RESOURCE_RECONCILE_INCOMPLETE`, or a new `RESOURCE_STALE`) so the host
  re-fetches `conflictPaths` rather than applying against a moved target. That is exactly today's
  `LEGACY_MERGE_STALE` → refresh flow.
- **All-or-nothing per skill.** A resolve either settles the whole skill (all its conflicted
  paths) or nothing — no partially-settled skill left tracked.

## What we'll do once it lands

Re-point `/resources/skill-repos/:id/update` at `syncGitRepo` (+ `conflictPaths` per returned
conflict) to rebuild the current `mergeConflicts[]` response, and `/resources/skill-repos/:id/resolve`
at the per-path `resolveGitConflict`. The React conflict cards stay per-path, unchanged. Then the
rest of P4 lands: delete `skillRepositories.ts` + `legacySkillRepo.ts` + the native write family +
their tests, drop the collection-snapshot machinery, and move recovery onto the engine.

If per-file turns out more expensive than it's worth on your side, tell us — the fallback is to
accept the per-skill model and rewrite the cards, and we'd rather know the cost than assume it.
Same as before: anything that smells wrong in the shape, send it back.
