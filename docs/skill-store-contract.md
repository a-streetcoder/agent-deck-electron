# SkillStore ↔ engine NAPI contract

Authoritative contract for the shared skill engine's NAPI surface that implements
agent-deck's `SkillStore` (ADR-0002 P1b/P3; Syncr ADR-0004). agent-deck owns these
domain shapes; the engine must reproduce them exactly. Source of truth:
`packages/domain/src/resources.ts`, `packages/resources/src/scanner.ts`,
`packages/resources/src/paths.ts`.

## 1. The output shape — `SkillInfo` (what `listSkills` returns)

`packages/domain/src/resources.ts:49`. Every element:

| Field | Type | Derivation |
|---|---|---|
| `name` | string | parsed SKILL.md frontmatter `name`, else the folder name |
| `description` | string | frontmatter `description` (empty string if absent) |
| `scope` | `ResourceScope` | see §2 |
| `filePath` | string | absolute path to `<skillDir>/SKILL.md` |
| `baseDir` | string | absolute path to the skill **directory** (`<skillDir>`) |
| `disableModelInvocation` | boolean | frontmatter flag (the skill is manual-only, not model-invoked) |
| `body` | string | SKILL.md with the frontmatter block **stripped**, trimmed (`scanner.ts:160`) |
| `disabled?` | boolean | **agent-deck sets this**, not the engine — app-level disable list. Omit it. |

`ScopedSkill` (engine) must map 1:1 to this. Codex finding 5 (missing
`name/description/filePath/baseDir/invocation flag/body`, no library scope) is exactly
this table — close that gap.

## 2. Scope + precedence

`ResourceScope = "builtin" | "global" | "library" | "project"` — **there is no
`legacyProject`.** The native `<project>/.agents` maps to `project`.

**Skill precedence (dedup on parsed frontmatter `name`, FIRST-in-scan-order wins —
`scanner.ts:211`, `names.has(skill.name)`):**

```
project  →  global  →  legacy-global  →  library
```

Concretely the scan order agent-deck uses (`skillCatalogDirs`, `paths.ts`):
1. `<project>/.agents/skills`  (project — the engine's canonical; agent-deck adds this in P3)
2. `<project>/.pi/skills`      (project — native/Pi; existing user skills, until migrated)
3. `~/.pi/agent/skills`        (global — native/Pi primary; existing user skills)
4. `~/.agents/skills`          (global — the engine's canonical global target)
5. collection roots            (library)

**Dedup keys on the parsed `name`, NOT the directory slug** (Codex finding 4). A skill
whose frontmatter `name` differs from its folder name dedups by `name`. The engine's
precedence must switch to name-based or it will disagree with agent-deck (double or
mis-shadow). Skills have no `builtin` scope (that's agents only).

## 3. Paths + discovery — NO Pi fan-out entry

- **Canonical:** `~/.agents/skills/<slug>/` (global) and `<project>/.agents/skills/<slug>/`
  (project). The engine materializes here.
- **Do NOT add a Pi tool-registry entry projecting to `.pi/skills`.** Verified against
  the vendored pi: `@earendil-works/pi-coding-agent@0.82` auto-discovers `.agents/skills`
  (`dist/core/package-manager.js:273` `collectAncestorAgentsSkillDirs` walks ancestors to
  the git root pushing `<dir>/.agents/skills`, wired :1937; global `~/.agents/skills`). And
  agent-deck launches pi with **`--no-skills`** (`packages/pi-host/src/launchPlan.ts:80`) +
  explicit **`--skill <path>`** (:101/:127). So a `.pi/skills` projection is redundant for
  agent-deck (it disables discovery) and *double-counts* for vanilla pi (it already finds
  `.agents`, then follows the projection). Drop the entry — correct call.
- **agent-deck consumes canonical directly:** it scans `.agents/skills`, and passes the
  resolved `baseDir` to pi as `--skill`. No fan-out on agent-deck's critical path — the
  engine can ship the canonical writer before fan-out is fixed on Windows.

## 4. Method semantics (the seam — `apps/server/src/skills/skillStore.ts`)

- `listSkills(projectId?) → SkillInfo[]` — §1/§2. `projectId` resolves to a project root;
  when set, project-scope dirs join the scan with the precedence above.
- `writeSkill(scope, name, {description?, body?}, projectId?) → path` — materialize a skill;
  project scope writes under `<project>/.agents/skills`.
- `deleteSkill(scope, name, projectId?)`, `renameSkill(scope, name, newName, projectId?) → path`.
- `importLocalSkill(scope, sourcePath, projectId?) → path`.
- Recovery — see §6.

Errors surface as `ResourceCatalogCapabilityError` with a code
(`RESOURCE_INVALID_PATH`, `RESOURCE_NOT_FOUND`, `RESOURCE_ALREADY_EXISTS`, `RESOURCE_BUSY`,
`RESOURCE_UNSAFE_COMPONENT`, `RESOURCE_RECONCILE_INCOMPLETE`, `RESOURCE_NATIVE_UNAVAILABLE`) —
the routes map these to HTTP status; keep the codes.

## 5. Crash-safe write (resolves the recovery disagreement)

Per-file atomicity is **not** enough — a multi-file skill written in a loop is still
half-updated after a crash. Honest empty recovery requires **per-skill atomicity: stage
the whole skill tree in a temp dir, fsync, then atomically swap the directory into place.**
agent-deck's native module already does exactly this — `publish_staged_tree_with_identity`
in `loop-catalog-native` (stage → fsync → atomic dir swap, retaining the displaced tree).
Adopt that shape. Until it lands, **recovery ops stay non-empty** (see §6).

## 6. Recovery ops — non-empty until staged-swap ships

`listRecoveries` / `restoreRecovery` / `acknowledgeRecovery` (catalog `global-skills`).
The "return `[]` / no-op / error" plan is only honest once §5's staged-directory swap
means there is no half-written state. Until then, keep them backed by the real recovery
store. agent-deck's routes already handle both (empty and populated) gracefully.

## 7. Migrations REQUIRED before the binding swap (or users lose data)

1. **Existing `.pi` skills → canonical `.agents`.** Users have skills in
   `~/.pi/agent/skills` and `<project>/.pi/skills`. The engine reads `.agents/skills` only,
   so on swap those vanish from the UI unless migrated. One-time move/copy (dedup by name)
   `~/.pi/agent/skills/* → ~/.agents/skills/*` and `<project>/.pi/skills/* →
   <project>/.agents/skills/*`, **or** the engine transitionally reads the `.pi` paths too.
2. **Orphaned recovery wrappers.** `.agent-deck-resource-recovery-v1-*` entries become
   permanently invisible once recovery answers `[]` — no surface restores or cleans them.
   Sweep/surface them before recovery goes empty.

Both must be in the P3/P4 plan; recorded here so the swap can't silently drop them.
