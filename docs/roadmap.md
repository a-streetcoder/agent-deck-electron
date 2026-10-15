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
- Pi-native MCP is the only transport since 2026-10-15 (PI-03 epic closed; the in-app proxy is gone).
- The shared server runs for two people behind Cloudflare Access (`poc/shared-server`, not yet
  on `main`).
- Windows signing is set up; auto-update and the release workflow are open.

## Lane A — Orchestration (new; the direction)

Ordered. Each item is one or a few NAH tickets; principles in `VISION_ORCHESTRATION.md` bind
them. Items 1 and 2 are the t3code orchestration-v2 ideas carried from the old roadmap.

| #   | Item                                                                                                                                                                                                                                                                                     | What it is                                                                                                                                                                                                                                                                          | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A1  | **Event log** (ade-c5h8, closed 2026-10-15)                                                                                                                                                                                                                                              | One append-only per-project JSONL log with stable client-generated ids; loop runs, subagent runs, supervisor requests, plan changes, checkpoints, approvals write to it. Existing stores become indexes over it. Served over the push bus and REST.                                 | —          |
| A2  | **Execution-node tree** (ade-74y5, closed 2026-10-15; Deck/Loops stay on their stores until a session-scoped full read)                                                                                                                                                                  | Model a run as a tree of nodes (message, reasoning, tool, approval, subagent, loop phase, hook) projected from A1; only the root completes the run, children complete independently. One structure for the timeline, subagent and loop views, replayable.                           | A1         |
| A3  | **Delta merge-back** (ade-mw03, closed 2026-10-15)                                                                                                                                                                                                                                       | A child reports to the parent what changed since the parent last looked (`delta_since_target_last_seen`), full transcript on demand.                                                                                                                                                | A1         |
| A4  | **Spawn / await** (ade-oili + fix ade-icbb, closed 2026-10-15)                                                                                                                                                                                                                           | `spawn_subagent → runId`, `await_subagents(ids)`, `cancel_subagent(id)` over `subagentRunStore`; `managed_subagent` becomes spawn + await. Structured results: `{id, status, summary, artifacts[], tokens, durationMs, checkpointRef}`.                                             | A1         |
| A5  | **Plan with dependencies** (ade-m5ku, closed 2026-10-15; dispatch only on live agent intent)                                                                                                                                                                                             | `dependsOn`, `assignee`, `verifiedBy` on `SessionPlanItem`; a pure ready-frontier scheduler in `packages/domain`; the server dispatches ready nodes through A4 and re-evaluates on completion or plan rewrite; the plan panel renders a DAG.                                        | A2, A4     |
| A6  | **Capability profiles**                                                                                                                                                                                                                                                                  | Aggregate pass rate by role, median tokens and duration per agent from the run store; show in the Agents screen; `list_agents` bridge tool so a parent can route on reliability. Relations (substitutes-for, requires) later, as data not ontology.                                 | A1         |
| A7  | **Verifier role**                                                                                                                                                                                                                                                                        | `role: "verify"` for `managed_subagent`: read-only tool profile, typed verdict reusing `LoopCheckerDecision`, fresh context. A verify edge gates its downstream in A5.                                                                                                              | A4, A5     |
| A8  | **Human node**                                                                                                                                                                                                                                                                           | Unify `humanApproval`, `need_decision` and `ask_user` under one node kind with a timeout policy; an approval is an event on A1; surfaces in desktop notifications and, on the shared server, in the other members' view.                                                            | A1, A2     |
| A9  | **Loops as graphs**                                                                                                                                                                                                                                                                      | `nodes[] / edges[]` in `.loop.md`; the six structures become builtin templates normalised into it; `LoopRunPhase` and `LoopAgentRole` are the node kinds, `LoopCheckerDecision` the edge conditions; `maxIterations` becomes a cycle budget. The engine shrinks to one interpreter. | A5, A7     |
| A10 | **Node-level retry**                                                                                                                                                                                                                                                                     | Checkpoints attach to nodes; a failed verification marks the affected subgraph (trusted / affected / recovery frontier); "retry from node" restores that node's checkpoint and re-runs the affected region. Generalises loop retry and turn rollback.                               | A2, A9     |
| A11 | **Reversibility on tools**                                                                                                                                                                                                                                                               | Per-tool `reversible` flag in MCP assignment; irreversible nodes require approval (A8) or a verifier (A7) before execution.                                                                                                                                                         | A7, A8     |
| A12 | **Run → template**                                                                                                                                                                                                                                                                       | "Save as loop" from a successful ad-hoc graph (A5) using `definitionSnapshot`; a `pattern` memory type recording which structure worked for which kind of task.                                                                                                                     | A9         |
| A0  | **Evidence run** (ade-l1h0, DONE 2026-10-15: [evidence](evidence/orchestration-2026-10.md); maker/checker did not beat single-agent on three goals: 174k vs 296k vs 458k tokens, 3/3 vs 2/3 vs 3/3; A6 and A7 proceed as legibility, A9 legibility only, A10 keep, A11 and A12 deferred) | The same three or four real goals run as `singleAgent`, `makerChecker`, `agentPipeline` with the loop engine; compare validation outcome and tokens. Result decides how much of A6–A12 is about topology versus legibility.                                                         | —          |

## Lane B — Shared server (carried over; the collaboration model)

ADR 0003 trust model; live setup in [`remote-server-poc.md`](remote-server-poc.md); handover in
[`handover-shared-server-poc.md`](handover-shared-server-poc.md). Tickets in `.tickets/`.

- ade-brgd — SRV-01: ADR shared headless host — closed (ADR 0003; amended by ADR 0004)
- ade-63d3 — SRV-02: REST origin and CSRF guard mirroring the WebSocket guard — closed
- ade-hnym — SRV-03: Andrea round via browser (co-working checklist) — open
- ade-fr91 — SRV-04: git identity per session follows the session owner — closed
- ade-1vjx — SRV-05: spike, desktop login through the system browser via a per-user Access token — closed
- ade-gfs4 — SRV-06: per-user GitHub connection for push and PR as the session owner — open
- ade-fdjz — SRV-07: prune session-authors.json on session delete; retry remote health check — closed
- ade-zvv5 — SRV-08: desktop sign-in page starts the cloudflared browser login on click — closed
- ade-4lga / ade-n41e / ade-vdes / ade-mug8 — SRV-10/11/13/14: provider-key env guard, per-user Pi credentials, connect-a-provider guidance, runs-on-owner label — closed
- ade-c7ad — PRV-01: one Claude entry per model (bridge as Claude, API key as API; direct sign-in hidden) — closed
- ade-iq7c — UI-01: sessions panel main, Orchestrate pull-up with user row — closed
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

- ade-kaqr — PI-03 (epic): Pi-native MCP as the transport — closed 2026-10-15 (PI-03a..f)
- ade-0v9e — D1: retire the Syncr skill-engine addon ([ADR 0005](adr/0005-retire-skill-engine-addon.md)) — approved, design pass first
- ade-dwji — D2: ARCHITECTURE.md trimmed to the map, per-ticket sections in `orchestration-reference.md`, sync-seams closed, parity-loop seam rule removed — closed 2026-10-15
- ade-u3ny — D3: CodeMirror soft-wrap toggle — open
- ade-4sjs — D4: owner decisions (ANA-01, FINAL push gating, A0 timing) — open
- ade-u8qg — D6 — closed 2026-10-15: loop children default tools and directProjectWrites for maker/stage roles (A0 finding) — open
- ade-rnrd — D7 — closed 2026-10-15: tolerant verdict parsing, validation before checker, checker can run validation (A0 finding) — open
- ade-scu0 — D8: corrupt or missing run stores no longer crash startServer nor tombstone logged runs — closed 2026-10-15
- ade-p5ik — D9: server warnings through one serverLog helper — closed 2026-10-15
- ade-w87w — D5: Playwright run on the VM, 14 spec fixes, Linux visual baselines — closed 2026-10-15 (owner: regenerate the -win32 baselines; desktop-electron specs need an Electron-capable machine)
- ade-ldzq — D10: model chip shows the real model for drafts and first-send-started sessions — closed 2026-10-15
- `docs/agent-guidelines/ARCHITECTURE.md` — trimmed (D2); the orchestration reference will change again when A2 settles the node shapes.
- `docs/sync-seams.md` — closed under ADR 0005 (D2).

## Suggested order

1. Finish what is in flight: SRV-03 (Andrea round), D5 (Playwright + baselines), then ade-s625 and push
   `poc/shared-server` (D4 decides whether SRV-06 gates the push).
2. A0 evidence run in parallel (cheap, informs everything after A5).
3. A1 → A2 → A3 (the t3code pair on the event log) → A4 → A5.
4. A6 → A7 → A8, then A9 → A10, then A11 → A12.
5. Lane C as credentials and time allow.
