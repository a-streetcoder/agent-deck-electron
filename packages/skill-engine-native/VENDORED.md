# Vendored skill engine

This package is the skill engine that Agent Deck used to install as Syncr's private
`skill-engine-native` 0.2.0 package. The owner chose to vendor it
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

## Provenance and licence

The source repository (`a-streetcoder/Syncr`) is private and its package was published as
`UNLICENSED`; the source files carry no licence headers. Both repositories belong to the same owner,
who confirmed on 2026-10-15 that the vendored engine is published under this repository's root MIT
licence. Both `Cargo.toml` files declare `license = "MIT"`.
