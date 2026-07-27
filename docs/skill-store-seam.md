# The SkillStore seam

A single interface in front of agent-deck's skill catalog + authoring + versioning,
so the concrete implementation can be swapped without touching call sites. Introduced
by [ADR-0002](adr/0002-consolidate-skill-engine.md) (P1b). This is the developer guide;
the ADR is the decision + rationale.

## What it is

- **`apps/server/src/skills/skillStore.ts`** — the `SkillStore` interface (the seam).
- **`apps/server/src/skills/nativeSkillStore.ts`** — `NativeSkillStore`, the current
  implementation. A **thin adapter** over `@agent-deck/resources` + `loop-catalog-native`
  — every method delegates to the function agent-deck already used. No behavior change.
- Exposed on `ServerContext` as **`ctx.skillStore`** (built in `server.ts`).

Today `NativeSkillStore` *is* the implementation — agent-deck runs fully standalone, no
external dependency. Later, the shared Syncr-owned engine implements the **same
interface** and replaces `NativeSkillStore` behind it (ADR-0002 P3) with no call-site
churn. The interface is inert scaffolding until then.

## Rule for contributors

**Consume `ctx.skillStore.*`, never the raw `@agent-deck/resources` skill functions**
(`writeSkillFile`, `deleteSkillDir`, `renameSkillDir`, `importSkillFile`, `scanSkills`,
the recovery fns). If a route reaches past the seam, the future engine swap will miss it.

```ts
// do
const skills = ctx.skillStore.listSkills(projectId);
ctx.skillStore.deleteSkill(scope, name, projectId);
// not
const skills = scanSkills(rootsFor(projectId), ...);   // bypasses the seam
```

## What the seam owns (and deliberately does NOT)

**Owns** — the stable, single-user, local skill lifecycle:

| Method | Delegates to |
|---|---|
| `listSkills(projectId?)` | `scanSkills` (via the host's `scanSkillsFor`) |
| `writeSkill` / `deleteSkill` / `renameSkill` | `writeSkillFile` / `deleteSkillDir` / `renameSkillDir` |
| `importLocalSkill` | `importSkillFile` |
| `listRecoveries` / `restoreRecovery` / `acknowledgeRecovery` | the native `*ResourceRecovery` fns (catalog `global-skills`) |

**Does NOT own** (intentionally out of the interface):

- **Runtime** — skill *assignment* (default/project/disabled → explicit `--skill` paths
  to Pi per session), Loops, session worktrees. These stay in agent-deck; they were
  never skill-store. Assignment still lives in `routes/sessions.ts`.
- **Repo sync** — importing an *arbitrary GitHub repo* and re-syncing a tracked upstream
  (`/resources/skills/import-git`, `/resources/skill-repos/:id/*`). That clone → discover
  → sanitize → 3-way-merge logic is the part that **moves into the shared engine**
  (Syncr ADR-0004). It stays inline in its routes for now and will be adopted through
  this seam when the engine lands — deliberately not force-extracted.

## Related: the removable legacy module (P1a)

**`apps/server/src/skills/legacySkillRepo.ts`** holds the legacy copied-skill-repo
transaction journal — one-time backward-compat, expected to be **deleted** once no
legacy catalogs remain. It is self-contained; removal is delete-the-file plus dropping
its imports in `routes/resources.ts`.

## Scope note

This seam is **single-user and standalone** — no Syncr dependency exists in agent-deck
today. The shared-engine swap and cloud sync are the separate "sync-share" track owned
by Syncr development (ADR-0002 P2–P4 / Syncr ADR-0004).
