---
id: ade-cdd5
status: in_progress
deps: []
links: []
created: 2026-10-14T19:54:17Z
type: task
priority: 1
assignee: almoretti
---
# PI-03a: spike, Pi native MCP hosted by the generated extension (go/no-go gate)


Go/no-go gate for the PI-03 epic (ade-kaqr; read its latest note first, it is the design). Build the smallest proof that Agent Deck's generated bridge extension (packages/pi-host/src/bridge.ts) can host Pi's native MCP: inside the generated extension source call `createMcpExtension({ loadConfig, updateConfig })` from `@earendil-works/pi-coding-agent` with a loadConfig that returns a fixed list (one stdio server, the test kit's or a tiny local one from the existing mcp.pi.test.ts fixtures, and one streamable HTTP server started by the test) and a no-op updateConfig; add a `tool_call` hook that blocks one named tool and a `tool_result` hook that suppresses one result. Prove, as a real-Pi test file (pattern: apps/server/test/mcp.pi.test.ts and packages/pi-host/test/bridge.pi.test.ts, run with --config vitest.pi.config.ts, one file): tools appear as mcp__<server>__<tool>, a call succeeds, the blocked call is refused, the suppressed result does not reach the model, and <agentDir>/mcp.json is NOT read (seed a decoy server there and assert it is absent). Record whether the import resolves to Pi's own instance under the bundled/virtual loader path (loader.js ~62) or needs the aliasing trick, and under which launch flags (--no-extensions plus -e of our extension) the built-in MCP code is actually active. Measurement step for the architect, not the developer: three sessions on the VM with two stdio servers each, RSS per Pi process and startup time, versus today.

## Design

GUARDRAILS as every PI ticket (work in a worktree E:\agent-deck-wt\<ticket> on wt/<ticket>, pnpm install --frozen-lockfile --prefer-offline there, single test files, per-package tsc, no full suites, no app start, no ssh, commit only in the worktree). This is a spike: keep it behind a flag or in test-only code; nothing user-visible changes. Output is knowledge: the ticket note lists what worked, the exact extension code shape and the open risks, and names go or no-go.

## Acceptance Criteria

One real-Pi test file passes with the five assertions above; the ticket note answers the import-resolution and launch-flag questions and gives the architect the exact command to reproduce; the epic note records go or no-go after the VM measurement.
