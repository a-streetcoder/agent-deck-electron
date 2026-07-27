# ADR 0001 — Filesystem containment via a native (Rust/cap-std) module

- **Status:** **Partly superseded by [ADR-0002](0002-consolidate-skill-engine.md)** (2026-07-27).
  The **skill/resource catalog** half of this module moves out to a shared,
  Syncr-owned skill engine; this ADR's "Option 2" (minimal, sanitize-at-import
  design) is adopted there in shared form. The module **remains** for the
  **loop catalog** and **session worktrees** (agent-deck-owned, trusted input).
  The Windows fixes made under this ADR stay valid until the extraction lands.
- **Date:** 2026-07-27
- **Context:** cross-platform port (macOS primary dev, Windows being brought up)
- **Component:** `packages/loop-catalog-native` (NAPI-RS + `cap-std`)

## Decision

Keep the native Rust containment module as the write path for the skill/resource
catalog, the loop catalog, and session worktrees. Finish the Windows-specific
branches so the module works on Windows, rather than rewriting it now.

A future simplification ("Option 2") is documented below as a deliberate escape
hatch if this seam keeps costing us.

## Why the module exists

Skills/resources import **untrusted content**: a user `git clone`s a skill repo
and we materialize it into the catalog. A booby-trapped repo can contain
symlinks that escape the catalog (`../../.ssh`, `C:\Windows\...`), path
traversal, or check-then-write (TOCTOU) races, to trick the writer into
following a link out of bounds and clobbering unrelated files.

Defending against that safely requires **descriptor-relative filesystem
operations** — `openat`/`renameat` relative to a pinned directory handle, with
"resolve beneath this directory only" semantics. **Node's `fs` API does not
expose these.** Pure-Node code is forced to resolve paths by string and re-open
by absolute path — precisely the racy pattern. `cap-std` (the crate this module
wraps) provides the safe primitives. So reaching for Rust addressed a real gap;
it was not gratuitous.

## What it costs (and why Windows hurts)

The module's hardest operation — **atomic directory replacement** — has *no
portable primitive*:

- **Linux:** `renameat2(RENAME_EXCHANGE)` swaps old/new atomically in one call.
- **Windows:** no equivalent; no directory `fsync`; and it refuses to rename a
  directory that has *any* open handle (cap-std opens handles without
  `FILE_SHARE_DELETE`).

So the module already carries hand-written `#[cfg(windows)]` branches that
re-implement the swap as a multi-step rename dance. The Windows path is the
least-exercised (primary dev is macOS), and it is where the cross-platform
faults concentrate:

- read-only-handle `fsync` → EPERM (Windows `FlushFileBuffers` needs write
  access) — **fixed** (open `"r+"`).
- directory `fsync` → EPERM (unsupported on Windows) — guarded.
- `RESOURCE_BUSY`: the quarantine rename in `publish_staged_tree_with_identity`
  fails because a cap-std dir handle (no share-delete) lingers in the subtree —
  **in progress.**

Because loop-catalog files **and** session worktrees also route through this
module, its Windows gaps ripple across three features, not just skills.

Other ongoing costs: a Rust toolchain for every dev + CI; per-platform NAPI
prebuilds pinned to Electron's Node ABI; and native debugging (Process Monitor +
rebuilds) instead of a JS breakpoint.

## Why we continue anyway

- It **works on macOS/Linux today** and encodes real, reviewed security thinking.
- It is **load-bearing** for skills, loops, and worktrees — a rewrite mid-port
  carries its own risk.
- The remaining Windows work is **finite**: the `fsync` and killed-exit-code
  classes are already cleared; `RESOURCE_BUSY` is the last significant native
  seam.

Finishing the Windows branches is the cheapest path to a working cross-platform
build while preserving the security posture.

## Threat-model note (why Option 2 is even on the table)

This is a **single-user desktop app**. The server already runs with full user
privileges (it spawns `pi`, runs `git`, reads/writes the user's files). The
native module's marginal protection is narrow: "an imported, booby-trapped skill
can't escape the catalog during materialization." That is worthwhile
defense-in-depth, but it is not multi-tenant isolation — and exploiting the
TOCTOU window a pure-Node approach would leave open requires an attacker to
**already be executing code on the machine at that instant**. For this app's
threat model, a simpler design with a weaker-but-adequate guarantee is a
defensible trade — hence Option 2.

## Option 2 (future) — shrink the native surface to a minimal helper

If the native seam keeps costing us (more Windows breakage, toolchain/packaging
friction), collapse it instead of maintaining a full native subsystem:

1. **Keep native ONLY for what Node genuinely cannot do**: a symlink-safe,
   descriptor-relative *open* (and, if needed, a no-follow `lstat`). Everything
   else — staging, tree copy, atomic-swap orchestration, cleanup — moves to
   TypeScript.
2. **Do the atomic replace in Node** with the portable pattern libuv already
   normalizes: stage into a temp dir → walk the tree with `lstat` rejecting
   every symlink/non-regular entry → `rename` into place → best-effort cleanup.
   Accept the theoretical TOCTOU window (adequate for this threat model; see
   above).
3. **One code path across OSes** instead of `#[cfg(unix)]` / `#[cfg(windows)]`
   divergence; native prebuilds shrink to a tiny, rarely-changing helper.

Trade-off: gives up crash-atomic directory *exchange* and the strongest
TOCTOU-hardness in exchange for dramatically simpler, uniform cross-platform
behaviour and far lower maintenance/debug cost. Revisit if Windows native
maintenance exceeds the security value it buys.

### Triggers to revisit (pick Option 2 if)

- Another distinct Windows native fault class appears after `RESOURCE_BUSY`.
- Native prebuild/packaging friction blocks a release.
- We add a second native platform (e.g. Windows arm64, Linux) and the per-OS
  branch matrix grows.

## Consequences

- Short term: invest in the Windows `#[cfg(windows)]` branches; keep the API and
  security posture unchanged.
- The module stays the single write path for skills/loops/worktrees.
- This document is the decision record; Option 2 is the pre-agreed simplification
  so a future maintainer does not have to re-derive it under pressure.
