# Vendored skill engine

This package is the skill engine that Agent Deck used to install as the private
`@a-streetcoder/skill-engine-native` 0.2.0 package. The owner chose to vendor it
(option B of [ADR 0005](../../docs/adr/0005-retire-skill-engine-addon.md)).

| What              | Value                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Source repository | `a-streetcoder/Syncr`                                                                                                         |
| Tag               | `engine-v0.2.0`                                                                                                               |
| Commit            | `76ec7d48251beeeb5f72641cfe05f4029d946c71` (2026-08-27, "Merge pull request #212 from a-streetcoder/fix-206-binary-filesets") |
| Vendored on       | 2026-10-15                                                                                                                    |

Layout:

- `engine/` is `crates/skill-engine` unchanged (sources, inline tests, `tests/`).
- `src/lib.rs` and `build.rs` are `crates/skill-engine-napi` unchanged.
- `src/binding.d.ts` is `crates/skill-engine-napi/native/index.d.ts` unchanged: the
  NAPI surface and `RESOURCE_*` error vocabulary Agent Deck consumes.
- `Cargo.toml` is the napi crate's manifest with the engine path changed to `engine`, a
  `[workspace]` section added and `rust-version` set to match `loop-catalog-native`.
- `Cargo.lock` is Syncr's lock at the tag, pruned by Cargo to this workspace (same versions).
- `src/index.ts`, `scripts/` and `package.json` are Agent Deck's, mirroring
  `packages/loop-catalog-native`.

There are no licence headers in the source files; the Syncr package was `UNLICENSED`
(same owner as this repository).

Since vendoring, this copy is the source of truth. Syncr's crate is no longer tracked.

Test notes: the crate declares 165 Rust tests; 9 are `cfg(unix)` and do not run on Windows.
`engine/tests/codex_system_skills.rs` reads the real `~/.codex/skills/.system` when it exists
and asserts at least six skills; it skips when the folder is absent.
