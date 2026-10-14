---
id: ade-0v9e
status: open
deps: []
links: []
created: 2026-10-14T23:39:28Z
type: feature
priority: 2
assignee: almoretti
---
# D1: retire the Syncr skill-engine addon (ADR 0005): skill writes, recoveries and git import in TypeScript


Owner decision 2026-10-15 ("if we have too many things on that seam we can also move away from it"), recorded as docs/adr/0005-retire-skill-engine-addon.md. ADR 0004 already removed Syncr as the coordination plane; this retires the last code dependency, the pinned native addon @a-streetcoder/skill-engine-native 0.2.0 (private registry, native build per platform, the WINDOWS.md packaging pitfalls, the EngineSkillStore contract in docs/skill-store-contract.md).

Facts (apps/server/src/skills/engineSkillStore.ts): reads already stay Agent Deck's (the pi-shaped scanner); the engine only does writes and recovery (writeSkill, renameSkill, deleteSkill, listRecoveries, restoreRecovery), git import and sync (importGitRepo, inspectGitRepo, syncGitRepo, listGitRepos, forgetGitRepo, discardGitPreview), local import (inspectLocalFolder, importLocalFolder, importLocalSkill) and fanOut. Call sites: apps/server/src/server.ts, skills/engineSkillStore.ts, skills/skillEngineNative.ts, packages/resources/src/scanner.ts, writer.ts.

Work, after a DESIGN PASS that reads the engine's on-disk layout (recovery tokens folder, git repo registry, any index file) so existing stores open unchanged: (1) a TypeScript SkillStore implementation of the same seam using node:fs for writes/renames/deletes with the same slug and precedence rules, a trash folder with tokens for recoveries, apps/server/src/git.ts for repo import/inspect/sync, and the existing fan-out code path; same ResourceCatalogCapabilityError codes so REST status mapping is unchanged; (2) remove the addon from package.json, pnpm-lock, build:pi-runtime / pack scripts, the native addon checks in DEVELOPMENT.md, WINDOWS.md, RELEASE.md; (3) docs: skill-store-contract.md becomes historical, sync-seams.md closed under ADR 0005, AGENTS.md skill-storage paragraph rewritten, parity-loop SKILL.md loses the seam requirement; (4) one migration note if the layout differs.

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. Design pass first (nah-contrarian: strongest case for keeping the addon is one shared storage implementation with the standalone Syncr app and its conflict-detection logic; answer with the real usage: two people, one repo). Sub-tickets only after the design pass if the diff is over ~600 lines.

## Acceptance Criteria

No reference to skill-engine-native remains in apps/, packages/, package.json or scripts (grep); existing skills, recoveries and imported git repos in a real store open and round-trip (write, rename, delete, restore, import, sync) with the ported unit tests and the real-Pi skill tests; typecheck, lint, format pass; Windows pack:win no longer needs the addon (documented, run by the owner when memory allows).

## Notes

**2026-10-14T23:40:22Z**

2026-10-15 approved by the owner (reply: approve). Design pass runs first (contrarian on the plan + engine store layout read); sub-tickets only if needed.
