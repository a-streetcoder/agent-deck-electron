---
id: ade-uxt2
status: closed
deps: [ade-7zpu]
links: []
created: 2026-10-14T18:16:28Z
type: feature
priority: 2
assignee: almoretti
---
# PI-02: adopt the Pi 1.x event and RPC additions (context_edit, aborted, durationMs, clear_queue, ui_prompt events)


After PI-01 compiles, take the behaviour improvements the 1.x RPC offers.

1. packages/domain/src/ingest.ts: handle the `context_edit` SessionEntry (0.87) instead of dropping it in the default branch: a hidden-from-model marker on the affected message so the transcript shows what the model no longer sees. `session.agent.state.messages` is no longer canonical; Agent Deck already uses get_entries/get_messages, so nothing else changes.
2. apps/server/src/services/sessionManager.ts ~2519: read the `aborted` flag on `agent_settled` (1.1) for the settled status instead of inferring it from the local AbortController where both exist; keep the local path as fallback (childRunLifecycle benefits).
3. `tool_execution_end.durationMs` (1.1) replaces the local Date.now timer at ~2132-2137 when present; the replay path keeps undefined.
4. RPC `clear_queue` (0.84.4): expose it where the UI already has a cancel of queued steer/follow-up; otherwise note it as available and skip.
5. `ui_prompt_start/end` (0.84.4): distinguish agent working from waiting on an extension prompt in the session status, reusing the askUser coordinator state.
6. `before_agent_start` now fires for sendMessage-triggered runs (1.2): check the settled-state waiting logic in sessionManager and the bridge for double-start assumptions.
7. Per-input disposition on prompt/steer/follow_up (0.99): check rpcProtocol.ts sends the shape Pi expects and whether a workaround can go.

Not in scope: MCP (PI-03), auth (PI-04), fullscreen tuiMode (RPC only, no TUI).

## Design

GUARDRAILS as PI-01 (worktree, single test files, typecheck per package, no full suites). Ponytail: each item is a small diff at an existing call site; skip any item whose UI counterpart does not exist and say so in the note. Depends on PI-01.

## Acceptance Criteria

ingest test for a context_edit entry; sessionManager test asserting the settled status follows the aborted flag; tool duration test uses the event value; the remaining items each have one unit test or a note explaining the skip; docs/agent-guidelines/ARCHITECTURE.md event section updated.

## Notes

**2026-10-14T18:21:11Z**

2026-10-14: item 6 made concrete: Pi 1.2 changed before_agent_start into a union on messageType; audit packages/pi-host/src/bridge.ts ~188 (recall hook reads event.prompt) and any other generated-string extension.

**2026-10-14T19:42:08Z**

2026-10-14 developer (uncommitted, main checkout). Done: (1) context_edit: packages/domain/src/ingest.ts contextHiddenEntryIds (latest edit per target wins, replacement:null hides, a content replacement un-hides) + markHiddenFromModel; hiddenFromModel?: true on user/assistant/tool cells (transcript.ts); applied in sessionManager seedFromHistory and transcriptFromEntries; apps/web cells.tsx labels it 'Not in model context'. Live message_end carries no entry id (Pi persists after emit, no entry_appended for messages), so a live session gets the label only after its next rebuild (resume/park). (2) aborted: apps/server/src/services/childRunLifecycle.ts sets 'Subagent turn was aborted.' on agent_settled.aborted when no more specific error exists (covers an abort during a tool call, which previously reported success); stop-reason inference kept as fallback. Main-session idle is decided at agent_end, before agent_settled, so the main path is unchanged (local abort() flag). Skipped: (3) durationMs: the ~2132 timer is the whole child-run duration, not a tool; tool cells have no duration UI. (4) clear_queue: composer lists queued guidance/follow-ups with no cancel control. (5) ui_prompt_start/end are ExtensionEvents only, not in AgentSessionEvent, so never on RPC stdout; blocking prompts already arrive as extension_ui_request (pendingUiRequests/attention). (6) audit: recall hook guarded (bridge.generated.test covers messageType custom); prompt audit reads systemPrompt (on both variants); injectedCommands uses sendUserMessage (user run); openaiFastMode uses before_provider_request; no Agent Deck code calls sendMessage/triggerTurn; sessionManager does not consume before_agent_start. No change. (7) prompt/steer/follow_up request shape unchanged in 1.2 rpc-types; responses now carry disposition (started|queued|handled), discarded by Effect.asVoid in piHost.ts; no workaround depends on it, no change. Tests: domain ingest.test.ts 25 pass (2 new), server childRunLifecycle.test.ts 10 pass (2 new), web cells.test.tsx 30 pass (1 new). tsc --noEmit clean in packages/domain, apps/server, apps/web; eslint and prettier --check clean on changed files. ARCHITECTURE.md: new 'Pi 1.x events and RPC additions' section plus an aborted paragraph under managed child settlement. Not run: real-Pi files (none touched), full suites.

**2026-10-14T19:43:10Z**

2026-10-14 architect review: accepted. Items 3, 4 and 5 skipped with verified reasons (no per-tool duration in the UI, no queue cancel control, ui_prompt events never reach RPC in 1.2); items 6 and 7 verified no change. Item 2 fixed a real bug (child aborted during a tool call reported as success). Deployed together with PI-04 and the SRV-13 correction in one restart.
