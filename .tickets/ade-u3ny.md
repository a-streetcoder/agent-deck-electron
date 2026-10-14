---
id: ade-u3ny
status: open
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
