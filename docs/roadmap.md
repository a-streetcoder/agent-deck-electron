# Agent Deck — Roadmap

_Rewritten 2026-10-15 under [ADR 0004](adr/0004-orchestration-and-collaboration-direction.md).
The previous port-completion roadmap is archived at
[`archive/roadmap-port-2026-10-14.md`](archive/roadmap-port-2026-10-14.md); every row it tracked
is closed except the leftovers listed under lane D. Direction lives in
[`VISION.md`](../VISION.md) and [`VISION_ORCHESTRATION.md`](../VISION_ORCHESTRATION.md); this
file only sequences work. Rows are proposals until the owner replies `approved` to a ticket
tree (NAH loop, `AGENTS.md`)._

## Where the product is (2026-10-15)

- The native macOS feature set is at parity on Electron (macOS, Windows, Linux): skills, agents,
  prompts, loops (all six structures), subagents, supervisor channel, memory, MCP, issues, git,
  worktrees, checkpoints, drafts, doctor, onboarding.
- Pi-native MCP is replacing the in-app proxy (PI-03 epic, in progress).
- The shared server runs for two people behind Cloudflare Access (`poc/shared-server`, not yet
  on `main`).
- Windows signing is set up; auto-update and the release workflow are open.

## Lane A — Orchestration (new; the direction)

Ordered. Each item is one or a few NAH tickets; principles in `VISION_ORCHESTRATION.md` bind
them. Items 1 and 2 are the t3code orchestration-v2 ideas carried from the old roadmap.

| #   | Item                               | What it is                                                                                                                                                                                                                                                                          | Depends on |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A1  | **Event log**                      | One append-only per-project JSONL log with stable client-generated ids; loop runs, subagent runs, supervisor requests, plan changes, checkpoints, approvals write to it. Existing stores become indexes over it. Served over the push bus and REST.                                 | —          |
| A2  | **Execution-node tree**            | Model a run as a tree of nodes (message, reasoning, tool, approval, subagent, loop phase, hook) projected from A1; only the root completes the run, children complete independently. One structure for the timeline, subagent and loop views, replayable.                           | A1         |
| A3  | **Delta merge-back**               | A child reports to the parent what changed since the parent last looked (`delta_since_target_last_seen`), full transcript on demand.                                                                                                                                                | A1         |
| A4  | **Spawn / await**                  | `spawn_subagent → runId`, `await_subagents(ids)`, `cancel_subagent(id)` over `subagentRunStore`; `managed_subagent` becomes spawn + await. Structured results: `{id, status, summary, artifacts[], tokens, durationMs, checkpointRef}`.                                             | A1         |
| A5  | **Plan with dependencies**         | `dependsOn`, `assignee`, `verifiedBy` on `SessionPlanItem`; a pure ready-frontier scheduler in `packages/domain`; the server dispatches ready nodes through A4 and re-evaluates on completion or plan rewrite; the plan panel renders a DAG.                                        | A2, A4     |
| A6  | **Capability profiles**            | Aggregate pass rate by role, median tokens and duration per agent from the run store; show in the Agents screen; `list_agents` bridge tool so a parent can route on reliability. Relations (substitutes-for, requires) later, as data not ontology.                                 | A1         |
| A7  | **Verifier role**                  | `role: "verify"` for `managed_subagent`: read-only tool profile, typed verdict reusing `LoopCheckerDecision`, fresh context. A verify edge gates its downstream in A5.                                                                                                              | A4, A5     |
| A8  | **Human node**                     | Unify `humanApproval`, `need_decision` and `ask_user` under one node kind with a timeout policy; an approval is an event on A1; surfaces in desktop notifications and, on the shared server, in the other members' view.                                                            | A1, A2     |
| A9  | **Loops as graphs**                | `nodes[] / edges[]` in `.loop.md`; the six structures become builtin templates normalised into it; `LoopRunPhase` and `LoopAgentRole` are the node kinds, `LoopCheckerDecision` the edge conditions; `maxIterations` becomes a cycle budget. The engine shrinks to one interpreter. | A5, A7     |
| A10 | **Node-level retry**               | Checkpoints attach to nodes; a failed verification marks the affected subgraph (trusted / affected / recovery frontier); "retry from node" restores that node's checkpoint and re-runs the affected region. Generalises loop retry and turn rollback.                               | A2, A9     |
| A11 | **Reversibility on tools**         | Per-tool `reversible` flag in MCP assignment; irreversible nodes require approval (A8) or a verifier (A7) before execution.                                                                                                                                                         | A7, A8     |
| A12 | **Run → template**                 | "Save as loop" from a successful ad-hoc graph (A5) using `definitionSnapshot`; a `pattern` memory type recording which structure worked for which kind of task.                                                                                                                     | A9         |
| A0  | **Evidence run** (any time, cheap) | The same three or four real goals run as `singleAgent`, `makerChecker`, `agentPipeline` with the loop engine; compare validation outcome and tokens. Result decides how much of A6–A12 is about topology versus legibility.                                                         | —          |

## Lane B — Shared server (carried over; the collaboration model)

ADR 0003 trust model; live setup in [`remote-server-poc.md`](remote-server-poc.md); handover in
[`handover-shared-server-poc.md`](handover-shared-server-poc.md). Tickets in `.tickets/`.

- ade-brgd — SRV-01: ADR shared headless host — closed (ADR 0003; amended by ADR 0004)
- ade-63d3 — SRV-02: REST origin and CSRF guard mirroring the WebSocket guard — closed
- ade-hnym — SRV-03: Andrea round via browser (co-working checklist) — open
- ade-fr91 — SRV-04: git identity per session follows the session owner — open
- ade-1vjx — SRV-05: spike, desktop login through the system browser via a per-user Access token — closed
- ade-gfs4 — SRV-06: per-user GitHub connection for push and PR as the session owner — open
- ade-fdjz — SRV-07: prune session-authors.json on session delete; retry remote health check — closed
- ade-zvv5 — SRV-08: desktop sign-in page starts the cloudflared browser login on click — open
- ade-aier — SRV-12 (epic, DRAFT): shared projects from a GitHub repository; local → shared; session move — open
- ade-s625 — FINAL: validation of the shared-server lane before pushing `poc/shared-server` — open
- Logged, unticketed: session move between backends (export = Pi session file + meta + pushed
  branch; import = fetch, remap, register, resume); per-user isolation beyond attribution if the
  audience widens.

Lane A's event log (A1) is what the shared server will serve as the team stream; B and A meet
there. Until A1 lands, B keeps `session-authors.json` and the per-session push bus.

## Lane C — Distribution (carried over)

See [`release-windows.md`](release-windows.md). Tickets in `.tickets/`.

- ade-lfpv — DST-A (operator): Agent Deck certificate profile on Azure Artifact Signing — closed
- ade-za74 — DST-03/04: signed Windows installer, release workflow and auto-update — open
- ade-159t — DST epic stub: remaining rows DST-02, DST-05, DST-06, DST-01 — open
- S22b desktop auto-update for macOS/Linux — open, inside ade-159t

## Lane D — Housekeeping and leftovers

- ade-kaqr — PI-03 (epic): Pi-native MCP as the transport — open; ade-apgq PI-03f (remove the
  proxy, McpManager, `packages/mcp`; docs) — in progress
- CodeMirror soft-wrap toggle (`CodeMirrorView.tsx`) — open, small
- ANA-01 analytics decision — open, owner decision
- `docs/agent-guidelines/ARCHITECTURE.md` — trim back to architecture; its per-ticket
  sections (delegation cancellation, merge cleanup, child provider settlement, stopped child
  cards) move to an orchestration reference doc once A2 lands and the shapes are stable. Not
  before PI-03f, which rewrites its MCP section.
- `docs/sync-seams.md` — add a one-line status note that the lift is an option under ADR 0004.

## Suggested order

1. Finish what is in flight: PI-03f, then SRV-04 / SRV-06 / SRV-08, then ade-s625 and push
   `poc/shared-server`.
2. A0 evidence run in parallel (cheap, informs everything after A5).
3. A1 → A2 → A3 (the t3code pair on the event log) → A4 → A5.
4. A6 → A7 → A8, then A9 → A10, then A11 → A12.
5. Lane C as credentials and time allow.
