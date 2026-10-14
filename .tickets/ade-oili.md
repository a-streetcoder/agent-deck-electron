---
id: ade-oili
status: open
deps: [ade-c5h8]
links: []
created: 2026-10-14T23:39:31Z
type: feature
priority: 2
assignee: almoretti
---
# A4: spawn / await / cancel subagents with structured results


Lane A row A4. New bridge tools spawn_subagent -> runId, await_subagents(ids) -> results, cancel_subagent(id) over subagentRunStore; managed_subagent becomes spawn + await; structured result {id, status, summary, artifacts[], tokens, durationMs, checkpointRef}. Children keep their own Pi process, worktree and policy (native MCP list, legacy grants) exactly as today. Events on A1.

## Design

GUARDRAILS (every ticket): work in a worktree E:/agent-deck-wt/<ticket> on wt/<ticket>; never git checkout/switch/stash/reset in the main checkout (mirrored live to the VM by Syncthing); single vitest files, eslint, prettier and per-package tsc only (low memory: no pnpm build, no full suites, no Playwright); no ssh, no push; stage only the paths the ticket touched. Principles in VISION_ORCHESTRATION.md bind the implementation; contrarian pass before signoff; GPT code review before merge. Depends on A1 (events) and keeps the child bridge access and __mcp_authorize__ child grant semantics (PI-03c) intact; contrarian focus: parent turn blocking vs awaiting, cancellation of a child mid tool call, orphan children on parent abort.

## Acceptance Criteria

Real-Pi tests: spawn two, await both, cancel one; managed_subagent still works unchanged for existing agents; results carry the structured fields; events recorded.

## Notes

**2026-10-14T23:43:20Z**

2026-10-15 approved by the owner (lane A tree, reply: 'the rest is approved'); dispatch in dependency order.
