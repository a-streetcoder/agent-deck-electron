---
id: ade-dwji
status: in_progress
deps: []
links: []
created: 2026-10-14T23:39:28Z
type: chore
priority: 3
assignee: almoretti
---
# D2: ARCHITECTURE.md trimmed back to architecture; per-ticket sections move to an orchestration reference


Lane D row carried from docs/roadmap.md, now unblocked (PI-03f rewrote the MCP section). Move the per-ticket sections (delegation cancellation, merge cleanup, child provider settlement, stopped child cards, SRV credential notes) into docs/orchestration-reference.md and docs/remote-server-poc.md as fits; leave ARCHITECTURE.md as the map of packages, processes and invariants with links. Also: sync-seams.md gets a closing note under ADR 0005 (D1) instead of the "lift is an option" note; remove the seam requirement from .agents/skills/parity-loop/SKILL.md.

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. Docs only; no code. Run prettier on the Markdown.

## Acceptance Criteria

ARCHITECTURE.md under ~250 lines with every removed section reachable by link; no dead links (grep the moved headings); prettier clean.

## Notes

**2026-10-14T23:52:38Z**

2026-10-15 unblocked from D1: both ADR 0005 options retire the seam posture, so the sync-seams closing note and the parity-loop seam rule removal can be written now; the AGENTS.md skill-storage paragraph stays as is until D1 lands (say so in the note).
