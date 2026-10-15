---
id: ade-0v9e
status: in_progress
deps: []
links: []
created: 2026-10-14T23:39:28Z
type: feature
priority: 2
assignee: almoretti
---
# D1: retire the Syncr skill-engine addon (ADR 0005): skill writes, recoveries and git import


Owner decision 2026-10-15 ("if we have too many things on that seam we can also move away from it"), recorded as docs/adr/0005-retire-skill-engine-addon.md. ADR 0004 already removed Syncr as the coordination plane; this retires the last code dependency, the pinned native addon @a-streetcoder/skill-engine-native 0.2.0 (private registry, native build per platform, the WINDOWS.md packaging pitfalls, the EngineSkillStore contract in docs/skill-store-contract.md).

Facts (apps/server/src/skills/engineSkillStore.ts): reads already stay Agent Deck's (the pi-shaped scanner); the engine only does writes and recovery (writeSkill, renameSkill, deleteSkill, listRecoveries, restoreRecovery), git import and sync (importGitRepo, inspectGitRepo, syncGitRepo, listGitRepos, forgetGitRepo, discardGitPreview), local import (inspectLocalFolder, importLocalFolder, importLocalSkill) and fanOut. Call sites: apps/server/src/server.ts, skills/engineSkillStore.ts, skills/skillEngineNative.ts, packages/resources/src/scanner.ts, writer.ts.

Work, after a DESIGN PASS that reads the engine's on-disk layout (recovery tokens folder, git repo registry, any index file) so existing stores open unchanged: (1) a TypeScript SkillStore implementation of the same seam using node:fs for writes/renames/deletes with the same slug and precedence rules, a trash folder with tokens for recoveries, apps/server/src/git.ts for repo import/inspect/sync, and the existing fan-out code path; same ResourceCatalogCapabilityError codes so REST status mapping is unchanged; (2) remove the addon from package.json, pnpm-lock, build:pi-runtime / pack scripts, the native addon checks in DEVELOPMENT.md, WINDOWS.md, RELEASE.md; (3) docs: skill-store-contract.md becomes historical, sync-seams.md closed under ADR 0005, AGENTS.md skill-storage paragraph rewritten, parity-loop SKILL.md loses the seam requirement; (4) one migration note if the layout differs.

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. Design pass first (nah-contrarian: strongest case for keeping the addon is one shared storage implementation with the standalone Syncr app and its conflict-detection logic; answer with the real usage: two people, one repo). Sub-tickets only after the design pass if the diff is over ~600 lines.

## Acceptance Criteria

No reference to the private @a-streetcoder scope remains outside docs/archive and CHANGELOG (grep); existing skills, recoveries and imported git repos in a real store open and round-trip (write, rename, delete, restore, import, sync) with the ported unit tests and the real-Pi skill tests; typecheck, lint, format pass; Windows pack:win no longer needs the addon (documented, run by the owner when memory allows).

## Notes

**2026-10-14T23:40:22Z**

2026-10-15 approved by the owner (reply: approve). Design pass runs first (contrarian on the plan + engine store layout read); sub-tickets only if needed.

**2026-10-14T23:48:33Z**

2026-10-15 design pass (contrarian): the ticket undersized the work ~5x. Facts: 21 engine calls incl. per-file conflicts (acknowledgeRecovery, checkGitRepo, conflictPaths, resolveGitConflict[Paths]); layout is plain files: catalog <root>/.agents/skills/<slug>, staging .syncr-staging, recoveries as .<slug>.displaced.<pid>.<seq> folders INSIDE the catalog (token = folder name; only ~/.agents/skills is listed), collections ~/.agents/skill-repos/<id>/{collection.json v1, clone/, base/<name>.json, .preview-ok, .op.lock}, id = name + sha256(url|ref|subpath)[:8]; hashes (UTF-8 byte lengths, BTreeMap order, BOM, CRLF except .bat/.cmd) must match byte for byte where collections exist; delete is hard, recoveries only from git take-remote/upstream removal/forget/rollback; slug rules stricter than RESOURCE_NAME; precedence .pi before .agents; no TS fan-out exists (70-tool registry, symlink/junction); git.ts clone helpers are dead and unhardened (no allow-list, no protocol.ext.allow=never, async vs sync seam); every NAPI call blocks the event loop and git has no timeout or per-user credential. Cheapest option: vendor the Rust crate next to loop-catalog-native (same napi-rs 3.7.4, 4 targets; deps sha2, hex, serde_json, junction) = no private registry/token/pin, all 165 tests kept. Recommended split if porting: D1-0 decide+inventory, D1a golden fixtures, D1b local store, D1c git collections (async hardened git, per-collection mutex), D1d removal, D1e docs (fold into D2). Inventory: this PC and the VM have no skill-repos and no displaced folders; Syncr app not installed on the VM. HOLD until the owner picks A (port) or B (vendor) in D4.

**2026-10-15T06:53:58Z**

2026-10-15 owner: leaning TypeScript rewrite; before deciding, check the TypeScript skill store that existed before the Rust engine (git history before ADR 0002) for reusable code and list what was missing then for parity with the engine's 21 operations. Archaeology running.

**2026-10-15T07:01:19Z**

2026-10-15 archaeology (pre-engine TypeScript, baseline 9caaeb5, 2026-07-27): the 'old TypeScript' was not pure TS: every catalog mutation and the git clone/fetch went through the loop-catalog-native Rust module (cap-std), with TS owning orchestration, discovery, fingerprinting, 3-way merge, journaling and persistence. Coverage of the engine's 21 ops: had write/rename/delete/import-local-skill (writer.ts), recoveries (Rust), sync with 3-way merge and per-path resolve (routes/resources.ts 198-325, 1071-1890: the origin of today's UX), listGitRepos, importLocalFolder; partial importGitRepo (no selection), checkGitRepo (commit-level), forget (no displacement), inspectLocalFolder; lacked inspectGitRepo, discardGitPreview, fanOut (66-tool registry), the engine's fileset hash (old tree-v1 hash is incompatible), .op.lock, per-skill base snapshots, deterministic ids, hardened git. Layout differs everywhere (writes to ~/.pi/agent/skills not ~/.agents/skills; recovery names; collection registry in app-settings.json), so old code cannot open today's stores unchanged, but no migration is needed (no collections or recoveries exist on this PC or the VM). Reusable as-is: skillSource.ts (in use), writer.ts write/delete/rename/import once secureWrite/Remove/Rename are retargeted to node:fs (~60 lines), discovery helpers, git.ts clone/ls-remote/ff helpers (async, unhardened). With adaptation: prepareThreeWayMerge/chooseConflictEntries/mergeIdFor (~250 pure lines), skillTreeFingerprint reader (hash replaced by a ~40-line fileset_hash port), path helpers. Not reusable / the reason the engine was adopted (ADR 0002): the cap-std write path and Windows dance (27 of 30 Windows failures), journals, snapshot generations, quarantine, recovery-token exchange: keep deleted. Estimate: TS rewrite reusing history ~2,100-2,400 lines vs 2,500-3,200 from scratch (20-25% saving; the reusable pieces are the easy ones; collections, hashing, fan-out and hardened git dominate). Test assets to revive: resources skill-import/skill-rename/fingerprint (HEAD), server skill-rename, skill-repo-legacy 980-1221 and 476-646 (merge semantics), skill-repo-import, e2e skills-git.spec cases; keep the HEAD acceptance suites (engineSkillStore 15, conflict/preview/local-import acceptance, pi roundtrip) as the parity gate. Engine for comparison: 8,673 lines Rust + 647 NAPI, 164 tests.

**2026-10-15T07:20:12Z**

2026-10-15 owner decision: VENDOR the Rust crate for now (option B of ADR 0005). Scope: copy ../Syncr/crates/skill-engine and crates/skill-engine-napi into packages/skill-engine-native (same napi-rs CLI and four targets as loop-catalog-native), keep the crate's 164 tests, point apps/server at the local package, remove @a-streetcoder/skill-engine-native from package.json/pnpm-lock, the @a-streetcoder scope from .npmrc, the GITHUB_TOKEN/packages:read from CI, update build-backend.mjs, electron-builder.yml, the packaged smoke script, DEVELOPMENT/WINDOWS/RELEASE/TESTING docs and ADR 0005 (option B chosen); the NAPI/error contract stays identical so engineSkillStore.ts does not change. Follow-ups (Rust, later tickets): make NAPI calls async/off the event loop and add a git timeout + per-user credential. Archaeology of the old TypeScript stays on record for a future rewrite.

**2026-10-15T07:39:15Z**

2026-10-15 contrarian + GPT review30 on the vendoring: no code defect blocks the local merge. Deploy risk: the engine loads before fastify.listen, so a VM restart without the built native kills the server in a restart loop (502 through the tunnel); deploy order on the VM with no session running: wait for sync, pnpm install --frozen-lockfile (no token), PATH=$HOME/.cargo/bin:$PATH pnpm --filter @agent-deck/skill-engine-native build (not the full build:native: its prebuild wipes the loop binary), check native/skill-engine-native.linux-x64.node, pnpm build:web, restart, curl /health. PUSH BLOCKER for the owner: the engine source comes from the private UNLICENSED Syncr repo and this repo is public MIT; the owner must accept publication/relicensing (or add a folder licence note) before any push. Fix round sent to the developer: import inside the try (helpful message), AGENT_DECK_SKILL_ENGINE_NATIVE_PATH from main.js, loader test distinguishes override from discovery and asserts missing-binary rejection, ADR 0005 normative text to option B, ADR 0002 superseded, doc leftovers (sync-seams, remote-server-poc, handover, skill-store-contract), VENDORED.md provenance paragraph, ticket title/acceptance amended, follow-ups listed for ticketing. CI on Windows/macOS for the engine tests is unverified until the first push.

**2026-10-15T07:41:22Z**

Follow-ups (to ticket separately):
- NAPI calls off the event loop: make the engine calls async (napi AsyncTask / worker) so git and filesystem work stops blocking the server.
- Git timeout in the engine (clone/fetch have none today), plus per-user git credentials.
- macOS /private/var canonicalize risk in the vendored Rust tests (tempdir paths under /var vs their canonical /private/var form).
- CI has never run the engine's Rust tests on Windows or macOS, nor on Rust 1.88 with the cfg(unix) code compiled; the first push is the first run.
- rust-cache shared-key names still say loop-catalog-native-* although they now cache both crates.
- PACKAGES_READ_TOKEN repository secret is now unused; delete it.

**2026-10-15T07:46:33Z**

2026-10-15 owner confirmed the licence (both repos theirs): license = MIT in both Cargo.toml, VENDORED.md provenance paragraph updated. Merged as ca1ee12; VM: pnpm install + native build done (8.65 s, skill-engine-native.linux-x64.node verified), build:web + restart follow with SRV-06.
