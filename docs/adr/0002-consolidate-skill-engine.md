# ADR 0002 — Consolidate skill sync/store into a shared, Syncr-owned engine

- **Status:** Accepted (2026-07-27); P1–P3 landed, P4 partial — see [Progress](#progress-2026-07-28)
- **Supersedes:** the skill/resource half of [ADR-0001](0001-native-containment-module.md)
- **Live contract + status:** [skill-store-contract.md](../skill-store-contract.md)
- **Context:** `agent-deck-electron` and `Syncr` (`../Syncr`) each independently
  implement local skill management. We are consolidating onto one.

## Context

Two codebases solve overlapping problems:

- **agent-deck** built a heavy local skill subsystem: import an arbitrary GitHub
  repo → discover skill roots → sanitize (reject symlinks/traversal) → fingerprint
  → conflict-resolve → atomically materialize into `~/.pi/agent/skills/`, backed by
  local version/transaction machinery (persistent clones under
  `historical-skill-repos/`, `.legacy-transactions/` journals, managed snapshots,
  recovery tokens, a cap-std atomic-exchange/quarantine write path). This is where
  ~27 of the 30 Windows failures fixed in July 2026 lived.
- **Syncr** (`crates/syncr-core`) is a UI-agnostic Rust sync engine: pluggable
  `provider` (own-cloud + GitHub), content-addressed `index`, `planner`,
  `conflict`, `materialize` (simple temp→fsync→rename→prune), `watcher`, per-tool
  `fanout`/`transform`, and an `agentdeck` FS-integration module. Syncr's cloud
  owns versioned, governed, multi-user skill history.

The two duplicate: fetch, identity, conflict, materialize, and watch. The **one**
capability Syncr does **not** have is agent-deck's **untrusted-repo import +
discovery + sanitization** (Syncr pulls already-catalogued content by uuid/path).

## Decision

Build **one shared "skill engine"** — a Rust crate, **owned by Syncr** — that owns
the entire local skill lifecycle, and consume it from both products:

- **agent-deck** depends on it (via its existing NAPI boundary) for all skill
  store/sync/import.
- The **standalone Syncr Tauri app** depends on it directly.

This is a consolidation of **ownership and implementation**, not a reduction of
capability. **No user-facing functionality is lost.**

### The seam

```
SHARED SKILL ENGINE (Syncr-owned crate) — dependency of BOTH
  OFFLINE CORE (no cloud required):
    ingest: GitHub-repo import → discover → SANITIZE untrusted tree
            + local skill authoring
    identity (content hash) · conflict · version store · transaction log /
    crash-safe writes · materialize (atomic + prune) · watch
  OPTIONAL CLOUD-SYNC LAYER (only when Syncr core is active):
    two-way sync; local edits routed THROUGH Syncr's governed API so Syncr's
    server-side ACCESS RULES apply (the engine does not reimplement them)
        │ writes canonical skills to ONE catalog on the local FS
        ▼
AGENT-DECK keeps RUNTIME ONLY:
    assignment (default/project/disabled) → resolve name→path → `--skill` to Pi
    per session · Loops (catalog + execution) · session worktrees
```

Sync/store is one thing; runtime orchestration is another. Everything above the
filesystem line is the shared engine's; deciding _which on-disk skill enters which
Pi session_ is agent-deck's and stays put.

### Moves / Stays / Drops

| Capability                                                                                                 | Disposition                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Untrusted GitHub-repo import + discovery + symlink/traversal **sanitization**                              | **MOVE** into the shared engine (not in Syncr today; genuinely needed)                                                      |
| Content identity / fingerprint                                                                             | **MOVE + unify** (one impl; converge on the shared history model)                                                           |
| Conflict detection/resolution                                                                              | **MOVE + unify**                                                                                                            |
| **Version store** + **transaction log / crash-safe writes**                                                | **MOVE — preserved, works offline** (they are the source of truth when no cloud)                                            |
| Materialize                                                                                                | **MOVE**, as the simple atomic write+prune form                                                                             |
| Cap-std TOCTOU-on-every-write, Windows quarantine-rename dance, recovery-token exchange, managed snapshots | **DROP** — accidental complexity; safe-by-construction once input is sanitized at import (capability ≠ this implementation) |
| Legacy skill-repo migration                                                                                | **ISOLATE** into a small, standalone, **removable** package (one-time back-compat; delete once no old catalogs remain)      |
| Assignment → `--skill` to Pi; Loops; session worktrees                                                     | **STAY** in agent-deck (never belonged to sync)                                                                             |

### Locked sub-decisions

1. **One history model.** The engine's local version store uses the **same model
   as Syncr's cloud** (git-semantics history). agent-deck's `tree-v1` hashes
   retire onto it, so "offline → connect Syncr" is a push/pull, not a migration.
2. **Capability ≠ implementation.** Preserve versioning + crash-safety + offline
   operation; do **not** preserve agent-deck's specific heavy write machinery.
   Untrusted input is validated **once at the import boundary** into a canonical
   form; everything downstream is simple and uniform.
3. **Offline-first.** The core works with no cloud. Cloud sync (and its access
   rules, enforced server-side by Syncr) is an optional layer switched on when the
   user has Syncr access. A single agent-deck user builds/imports/versions skills
   entirely locally.
4. **One catalog path.** Converge on a single canonical catalog
   (`~/.agents/skills/<slug>/` — vendor-neutral, already scanned by agent-deck as
   a legacy path, and Syncr's target). Feasible because agent-deck passes skills to
   Pi as **explicit `--skill <path>` flags**, so the physical location is free.
   _(Confirm Pi accepts skills handed by explicit path from outside `~/.pi/`.)_
5. **Project scope, split display/write.** Skills/agents/prompts exist at _project_
   scope too (`<project>/.pi/{skills,agents,prompts}`), not only global — native
   parity that the electron refactor dropped and has since restored for **display**
   (scan + watch, project shadows global; see the "Restore project-scoped … DISPLAY
   parity" commit). Project **writes** stay deferred to the shared engine: agent-deck
   keeps three home-only write gates (route validator, writer `catalogLocation`,
   native containment) that P3 removes when the engine — which owns project writes —
   takes over. The "one catalog path" convergence (#4) therefore extends to project
   scope (`<project>/.pi/skills` vs Syncr's `<project>/.agents/skills`); pick it when
   the engine lands. Tracked to Syncr as a separate request (their prompt already
   shipped, so project-scope writes are a new ask, not a retro-edit).

### Where the shared engine is built

**Start it in the Syncr repo as a dedicated `skill-engine` crate** (factored from
`syncr-core`) with a **strict public API**; Syncr owns and versions it; agent-deck
consumes it as a pinned dependency. **Graduate it to its own repo once the API
stabilizes**, so agent-deck need not pull Syncr's cloud code. Rationale: the sync
logic already lives in Syncr, Syncr owns it, and a co-located crate maximizes early
velocity; a strict API keeps the eventual repo split cheap.

## Why not the alternatives

- _Keep both implementations and reconcile behavior_ — perpetual drift and
  double-maintenance; the reason we are consolidating.
- _Make Syncr cloud a hard dependency of agent-deck_ — violates offline-first; a
  single user must not need a Syncr account to manage skills.
- _Delete agent-deck's import/containment as "redundant"_ — wrong: Syncr can't
  import arbitrary untrusted repos. That capability moves, it doesn't vanish.

## Phased plan (sequencing matters)

Removal from agent-deck is **blocked** until the shared engine exists and is
integrated — deleting the local skill store before its replacement is live would
break skills. Order:

- **P1 — Prep in agent-deck (no shared engine needed, safe now):**
  (a) isolate legacy skill-repo migration into a small removable package;
  (b) draw a single internal interface (`SkillStore`) in front of the skill
  import/store/materialize code so it can later be swapped for the engine with no
  call-site churn. Behavior unchanged; tests stay green.
- **P2 — Build the shared engine in Syncr:** factor `skill-engine` from
  `syncr-core`; port agent-deck's untrusted-import + sanitization into it; adopt
  the one history model; expose the strict public API + a NAPI-consumable surface.
- **P3 — Integrate:** agent-deck's `SkillStore` interface is implemented by the
  shared engine; converge the catalog path; route agent-deck's local skill edits
  through the engine (so cloud sync + access rules apply when on).
- **P4 — Delete:** remove agent-deck's now-dead duplicate (import-for-sync,
  fingerprint, conflict engine, journals/quarantine/managed-snapshots, chokidar
  resource watcher). Retire the isolated legacy-migration package when no old
  catalogs remain.

## Consequences

- agent-deck shrinks to **runtime + a thin engine client**; a large share of the
  Windows-specific FS code (and its recent fixes) is eventually deleted, not
  ported further.
- One skill implementation to maintain, shared by two products.
- `packages/loop-catalog-native` stays for Loops + worktrees (trusted input), and
  may itself slim per ADR-0001's Option 2.
- New coupling: agent-deck depends on a Syncr-owned crate; managed via a pinned
  version and a strict API.

## Progress (2026-07-28)

What landed, and where reality diverged from the plan above. Full, current detail lives in
[skill-store-contract.md](../skill-store-contract.md); this is the ADR-level record.

- **P1a / P1b — done.** Legacy migration isolated (`legacySkillRepo.ts`); `SkillStore` seam +
  routes/launch repointed through it.
- **P2 — done (Syncr).** Shipped as `@a-streetcoder/skill-engine-native` (crate `skill-engine`).
- **P3 — done.** `EngineSkillStore` replaced `NativeSkillStore`; all in-app skill writes go through
  the engine (0.1.3). Project writes enabled and made visible (the reader now scans
  `<project>/.agents/skills`, where the engine materializes them).
- **P4 — partial.** Dead `NativeSkillStore` deleted; the real engine emitter is pi-round-trip
  guarded. The native skill-write fns are prod-dead but **kept + marked**, not deleted, while P4 is
  partial. Retiring the git-repo importer is **blocked** on the engine exposing git-import through
  the NAPI — request out at [skill-engine-git-import-request.md](../skill-engine-git-import-request.md).

**Divergences from the plan, recorded honestly:**

- **No migration (revises the migration expectation).** The plan and an earlier contract draft
  assumed a one-time `.pi → .agents` move. It's unnecessary: non-destructive dual-read, fan-out
  bridges global visibility, nothing moves on disk. The confusion was "canonical" meaning the
  _creation target_, not the top-ranked _read_ location.
- **Recovery stays native, transitionally (revises sub-decision on recovery ownership).** In the
  no-sync scope the recovery producers are still native (legacy repo + displacement); recovery moves
  to the engine when sync lands. Routing it to the engine early was a real bug.
- **One write gate removed, not three (revises sub-decision #5).** Only the route-level project
  refusal was removed; the writer/native gates are simply bypassed (the engine path doesn't use
  them) and remain for agents/prompts, which are still global-only.
