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
| A6  | **Capability profiles** (ade-7jiy, closed 2026-10-15; "finished" rate, list_agents tool)                                                                                                                                                                                                 | Aggregate pass rate by role, median tokens and duration per agent from the run store; show in the Agents screen; `list_agents` bridge tool so a parent can route on reliability. Relations (substitutes-for, requires) later, as data not ontology.                                 | A1         |
| A7  | **Verifier role** (ade-bfxw, closed 2026-10-15; one launchVerifier for loops, plan items and role: verify)                                                                                                                                                                               | `role: "verify"` for `managed_subagent`: read-only tool profile, typed verdict reusing `LoopCheckerDecision`, fresh context. A verify edge gates its downstream in A5.                                                                                                              | A4, A5     |
| A8  | **Human node** (ade-c5j7, closed 2026-10-15; human.requested/answered/expired/cancelled, GET /events/open-human)                                                                                                                                                                         | Unify `humanApproval`, `need_decision` and `ask_user` under one node kind with a timeout policy; an approval is an event on A1; surfaces in desktop notifications and, on the shared server, in the other members' view.                                                            | A1, A2     |
| A9  | **Loops as graphs** (ade-0nzw, closed 2026-10-15; one interpreter, template shapes + stages-with-one-checker)                                                                                                                                                                            | `nodes[] / edges[]` in `.loop.md`; the six structures become builtin templates normalised into it; `LoopRunPhase` and `LoopAgentRole` are the node kinds, `LoopCheckerDecision` the edge conditions; `maxIterations` becomes a cycle budget. The engine shrinks to one interpreter. | A5, A7     |
| A10 | **Node-level retry** (ade-zntr, closed 2026-10-15; affected-region marking, Retry from node)                                                                                                                                                                                             | Checkpoints attach to nodes; a failed verification marks the affected subgraph (trusted / affected / recovery frontier); "retry from node" restores that node's checkpoint and re-runs the affected region. Generalises loop retry and turn rollback.                               | A2, A9     |
| A11 | **Reversibility on tools**                                                                                                                                                                                                                                                               | Per-tool `reversible` flag in MCP assignment; irreversible nodes require approval (A8) or a verifier (A7) before execution.                                                                                                                                                         | A7, A8     |
| A12 | **Run → template**                                                                                                                                                                                                                                                                       | "Save as loop" from a successful ad-hoc graph (A5) using `definitionSnapshot`; a `pattern` memory type recording which structure worked for which kind of task.                                                                                                                     | A9         |
| A0  | **Evidence run** (ade-l1h0, DONE 2026-10-15: [evidence](evidence/orchestration-2026-10.md); maker/checker did not beat single-agent on three goals: 174k vs 296k vs 458k tokens, 3/3 vs 2/3 vs 3/3; A6 and A7 proceed as legibility, A9 legibility only, A10 keep, A11 and A12 deferred) | The same three or four real goals run as `singleAgent`, `makerChecker`, `agentPipeline` with the loop engine; compare validation outcome and tokens. Result decides how much of A6–A12 is about topology versus legibility.                                                         | —          |

## Lane B — Shared server (carried over; the collaboration model)

ADR 0003 trust model; live setup in [`remote-server-poc.md`](remote-server-poc.md); handover in
[`handover-shared-server-poc.md`](archive/handover-shared-server-poc.md). Tickets in `.tickets/`.

- ade-brgd — SRV-01: ADR shared headless host — closed (ADR 0003; amended by ADR 0004)
- ade-63d3 — SRV-02: REST origin and CSRF guard mirroring the WebSocket guard — closed
- ade-hnym — SRV-03: Andrea round via browser (co-working checklist) — open
- ade-fr91 — SRV-04: git identity per session follows the session owner — closed
- ade-1vjx — SRV-05: spike, desktop login through the system browser via a per-user Access token — closed
- ade-gfs4 — SRV-06: per-user GitHub connection for push and PR as the session owner — closed 2026-10-15 (deployed; owner registers the GitHub OAuth App and sets AGENT_DECK_GITHUB_CLIENT_ID)
- ade-fdjz — SRV-07: prune session-authors.json on session delete; retry remote health check — closed
- ade-zvv5 — SRV-08: desktop sign-in page starts the cloudflared browser login on click — closed
- ade-4lga / ade-n41e / ade-vdes / ade-mug8 — SRV-10/11/13/14: provider-key env guard, per-user Pi credentials, connect-a-provider guidance, runs-on-owner label — closed
- ade-c7ad — PRV-01: one Claude entry per model (bridge as Claude, API key as API; direct sign-in hidden) — closed
- ade-iq7c — UI-01: sessions panel main, Orchestrate pull-up with user row — closed
- ade-vlld — SRV-15: tools to use shared sessions easily — closed 2026-10-15 (15a fork follows the forker, 15b status dots + member chips + deep link + fork provenance, 15c list_sessions/read_session; all deployed)
- ade-aier — SRV-12 (epic): shared projects from a GitHub repository; local → shared; session move — sub-tickets ade-wgkk (12a repo projects), ade-t77e (12b Make shared), ade-shxc (12c1 snapshot move + frozen pointer), ade-iarr (12c2 live mirror), ade-k7s3 (12c3 return trip); tree approved 2026-10-15; 12a CLOSED (merged 6d844d7, deployed); 12b CLOSED (merged 96de813, deployed); 12c1 CLOSED (merged 90ea1f7, deployed); 12c2 CLOSED (merged e852c41, deployed); 12c3 CLOSED (merged f0041d5, deployed); EPIC CLOSED 2026-10-16, owner live checks on the epic
- ade-s625 — FINAL: validation of the shared-server lane before pushing `poc/shared-server` — open (owner items only; GPT verdict READY TO PUSH 2026-10-15)
- ade-fah9 — SRV-16 (epic): the team server as a desktop setting with sign-in, the server optional; remote attach leaves the desktop — approved 2026-10-15; 16a ade-wvbh CLOSED (merged aeeede9, deployed), 16c ade-u5bg CLOSED (merged f52cb44), 16b ade-hndc CLOSED (merged efe887d, deployed), 16d ade-pjln CLOSED (merged 4ff78ff, deployed); EPIC CLOSED 2026-10-16, owner live checks on the epic; ade-hndc (16b sign in/out + startup), ade-u5bg (16c cloudflared discovery + verified download), ade-pjln (16d remove remote attach, launchers, docs)
- ade-os47 — SES-01: session record v2 (ADR 0006: provenance, location, workspace, launch; explicit lifecycle; allowedOperations; migration) — approved 2026-10-16, closed 2026-10-16 (merged 22a5a67, deployed to the VM with the migration; ADR 0006 amended for the authors store, launch and transfer shapes, provenance kept on return, spawned deferred)
- Lane SBX — a process sandbox around every session (ADR 0007, accepted 2026-10-17): ade-1c88 (epic); ade-pv1c SBX-01 spike (closed 2026-10-17, merged 135d9b0: container path with seccomp+AppArmor profiles and systempaths=unconfined; srt chosen); ade-210c SBX-02 SandboxProvider in pi-host + sandboxPolicy in domain (closed 2026-10-17, merged b7d76fe); ade-3up0 SBX-03 server/web wiring (closed 2026-10-17, merged 50dd874: stdio bridge, provider per side, grants-only allow-list with sandbox.json as proposal, every spawn wrapped, violations + allow-host; not deployed until SBX-04 ships the profiles); ade-vyov SBX-04 image builder layer, profiles, Compose, runbook, VM deploy (closed 2026-10-17, merged a721f44: startup probe, carve, quarantine, 64-bit-only seccomp, AppArmor kernel deny; production deploy after the close); ade-jx7e SBX-05 credential masking via the proxy; ade-yp0q SBX-06 the stack matrix as a recurring gate (closed 2026-10-17, merged 394a0f9: sandbox-run CLI, `node scripts/stack-matrix.mjs --host dev`, docs/stack-matrix.md); ade-c3aa SBX-07 private /tmp, default toolchain hosts, session env (closed 2026-10-18, merged b23bf99; 9/10 stacks pass); ade-si3i SBX-08 Ruby per user in the sandbox (closed 2026-10-18, merged 550c171; matrix 10/10, baseline empty). Open: ade-jx7e SBX-05 credential masking.
- ade-a105 — SRV-17 (epic): the shared server as an installable container package (non-root node:22-slim image on GHCR, Compose with a cloudflared sidecar, one data volume); the Linux target of the DST register — approved 2026-10-15; 17a ade-229e CLOSED (merged 8d74f98; image validated on the VM, workflow runs on the first push); 17b ade-tb53 CLOSED (merged e6c8524; compose validated, first run in 17c); ade-siqi (17c VM cutover, owner-paced)
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
  - DST-05 is the server image pipeline (SRV-17a, ade-229e); DST-06 is its manual upgrade path (SRV-17b, ade-tb53: set the tag, pull, up); the Linux target is the server package, not a desktop app. The register's automatic update channel stays Missing.
- S22b desktop auto-update for macOS/Linux — open, inside ade-159t

## Lane D — Housekeeping and leftovers

- ade-kaqr — PI-03 (epic): Pi-native MCP as the transport — closed 2026-10-15 (PI-03a..f)
- ade-0v9e — D1: retire the Syncr skill-engine addon ([ADR 0005](adr/0005-retire-skill-engine-addon.md)) — closed 2026-10-15: option B, engine vendored as packages/skill-engine-native (MIT), deployed
- ade-dwji — D2: ARCHITECTURE.md trimmed to the map, per-ticket sections in `orchestration-reference.md`, sync-seams closed, parity-loop seam rule removed — closed 2026-10-15
- ade-u3ny — D3: CodeMirror soft-wrap toggle — closed 2026-10-15
- ade-q0pz — FINAL-fix: seven security dispositions of the risk-focused review (remote-mode shell actions refused, hook-free transfer/push/release git, share/abort refused on the shared server, Access token stripped on cross-host redirects, post-parse token redaction, LFS refusals, wider mirror secret keys) — closed 2026-10-15 (merged 5d48fa6, deployed; GPT verdict READY TO PUSH)
- ade-4sjs — D4: owner decisions — closed 2026-10-15: ANA-01 YES with PostHog: ade-1gaq CLOSED 2026-10-15 (merged 91812e5, deployed; model/provider only from pi-ai built-in list, opt-out on Performance, key via AGENT_DECK_POSTHOG_KEY); FINAL push (ade-s625) unblocked from the SRV-06 live check, gated on SRV-03 + green gates; A0 ran alongside A1 (done); D1 option B (done); no VM-wide gh login, private repos only via per-user SRV-06 connections
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
   `poc/shared-server` (D4 decided 2026-10-15: SRV-06 does not gate the push).
2. A0 evidence run in parallel (cheap, informs everything after A5).
3. A1 → A2 → A3 (the t3code pair on the event log) → A4 → A5.
4. A6 → A7 → A8, then A9 → A10, then A11 → A12.
5. Lane C as credentials and time allow.
