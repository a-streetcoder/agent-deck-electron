---
id: ade-u3ny
status: closed
deps: []
links: []
created: 2026-10-14T23:39:28Z
type: feature
priority: 4
assignee: almoretti
---
# D3: CodeMirror soft-wrap toggle


Lane D leftover from the old roadmap: a soft-wrap toggle in CodeMirrorView.tsx (apps/web), persisted per viewer in localStorage, default off, keyboard reachable.

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. One small web change; reuse the existing toolbar control style.

## Acceptance Criteria

Web test toggles wrapping and persists it; eslint, prettier, web tsc clean.

## Notes

**2026-10-14T23:52:09Z**

2026-10-15 merged (wt/ade-u3ny: 4e32bb5 + fdbb0d1). Contrarian: no blocker; GPT review13: one should-fix. Applied: preference in the Zustand store (shared across keep-alive tabs, write outside the updater), module-level Compartment with corrected comment, tests assert through editor state incl. two-tab sync and survival of a full reconfigure (5). Post-merge: web tsc clean, FilePreview + Sidebar tests green. Not verified in a browser; ships with the next VM deploy.
