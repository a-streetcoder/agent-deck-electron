# Handover — direction change and documentation revamp (2026-10-15)

Written by the Claude session `claude-d6` (claude.ai, cloud session linked to Ale's PC) for the
Claude Code architect session on this checkout (`agent-deck-electron-52`, branch
`poc/shared-server`). Everything below is in the working tree, **uncommitted**: the owner
reviews and commits. Nothing was pushed. No source code was touched.

## How this came about

Ale asked what the "graph engineering" trend for LLM agents is (the survey arXiv 2608.21156,
Aug 2026: prompt → context → harness → loop engineering, then "graph engineering" as the step
from one agent to a system of agents, organised as three graph views — task organisation, agent
coordination, runtime state management — plus system evolution). Then: which tools a harness
lacks for it, then: what to add to Agent Deck. Reading this repository against that model showed
that individual intelligence is done here (loops, subagents, supervisor, checkpoints, memory)
and that the documentation did not reflect either that or where collaboration is going.

## Decisions Ale made (verbatim intent, 2026-10-15, ~00:10–00:25 BST)

1. **"The shared server is where I see a team work together."** It is the collaboration
   direction. **Syncr "was a good idea but not the right one"** — no longer the coordination
   plane or identity model. The Syncr skill-engine addon stays as the pinned code dependency.
2. **"Graph engineering is the direction … it fits well as an evolution from the current
   orchestration."** Not a rewrite; an evolution of loops / subagents / supervisor / plan.
3. **The t3code orchestration-v2 ideas in the old roadmap (execution-node tree, delta
   merge-back) "are a first start in that direction."**
4. **This branch (`poc/shared-server`) is where we are moving in this direction**; the
   documentation revamp belongs here.
5. Ale will ask for the tickets to be created (NAH loop). This handover and the documents below
   are their context.

Recorded as [ADR 0004](adr/0004-orchestration-and-collaboration-direction.md).

## What changed in the tree

New:

- `VISION.md` — rewritten (three commitments: orchestration as system intelligence,
  collaboration on the shared server, one event log; what changed from July; non-goals).
- `VISION_ORCHESTRATION.md` — the orchestration model: what exists today per view with file
  paths, what is missing per view, nine principles, what we take from the paper and leave,
  where it starts.
- `docs/adr/0004-orchestration-and-collaboration-direction.md` — the decision record; amends
  ADR 0003 decision 1 (local and shared are two deployment modes, neither the default).
- `docs/roadmap.md` — rewritten as lanes A (orchestration, A0–A12 ordered with dependencies),
  B (shared server, SRV tickets carried over verbatim), C (distribution), D (housekeeping).
- `docs/handover-direction-2026-10-15.md` — this file.

Moved (plain `mv`, not `git mv` — stage them when committing):

- `VISION_EDGE.md`, `VISION_WORKSPACE.md`, `VISION_IDENTITY.md` → `docs/archive/vision-2026-07/`
- `docs/effect-migration-plan.md` → `docs/archive/`
- `docs/roadmap.md` (old) → `docs/archive/roadmap-port-2026-10-14.md`
- `docs/skill-engine-*-request.md` (3) → `docs/archive/syncr-requests/`
- `docs/mcp-proxy-acceptance.md`, `docs/mcp-protected-editor-acceptance.md`,
  `docs/session-drafts-acceptance.md` → `docs/archive/acceptance-records/`

Edited (links only, plus one note):

- `CHANGELOG.md` header links (effect plan → archive; dead `parity-audit.md` → registers + VISION)
- `docs/adr/0003-shared-server-trust-model.md` line 4 (VISION_EDGE path; superseded-by note)
- `docs/adr/0002-consolidate-skill-engine.md`, `docs/skill-store-contract.md`,
  `docs/sync-seams.md` (request-letter paths → archive)
- `docs/handover-shared-server-poc.md` — a "Direction change 2026-10-15" section before the
  working-tree warning
- `AGENTS.md` — a "Documentation" section (what lives where; archive on close)
- `docs/LANES.md` — a line for this session

Deliberately not touched:

- `docs/native-functional-parity-*.md` — the `parity-loop` skill reads them at those paths.
- `docs/agent-guidelines/ARCHITECTURE.md` — PI-03f (ade-apgq, in progress) rewrites its MCP
  section; the trim is lane D.
- `docs/remote-server-poc.md`, `docs/release-windows.md`, `docs/pi-rpc-launch-flags.md`,
  `docs/mcp-import-compatibility.md` — live reference, unchanged.
- Any `.tickets/` file, any source file.

## What to do next (for the architect session)

1. Read `VISION.md`, `VISION_ORCHESTRATION.md`, ADR 0004, `docs/roadmap.md` — in that order.
2. Check the moves did not break anything you rely on: `grep -rn "VISION_EDGE\|effect-migration-plan\|skill-engine-.*-request" --include=*.md .`
   should only hit archive paths, prose mentions and tickets.
3. Run `pnpm format:check` on the new Markdown before committing (tables were hand-aligned).
4. Commit the docs as one change on `poc/shared-server` when Ale says so (suggested message:
   `docs: direction — shared server + graph-engineering orchestration (ADR 0004)`).
5. When Ale asks for tickets: lane A rows A0–A5 first. A1 (event log) is the one to design
   carefully — it is the substrate for A2–A12 and for the team stream on the shared server.
   `VISION_ORCHESTRATION.md` principles 1, 2, 3 and 9 are its constraints.

## Open points Ale has not decided

- Whether `poc/shared-server` merges to `main` before or after lane A starts (ade-s625 gates
  the push).
- Whether the evidence run A0 happens before A1 or in parallel (roadmap suggests parallel).
- ACP as a later node type — explicitly deferred to its own ADR.

## Git state warning (added 00:35)

While these files were being written, the architect session merged PI-03f (`45fc200`, 00:27).
That merge swept part of this revamp into its commit (the archive copies of the vision files
and the effect plan, the old-roadmap archive copy, the rewritten `docs/roadmap.md`, the link
edits in ADR 0002/0003, `skill-store-contract.md`, `sync-seams.md`, `handover-shared-server-poc.md`),
and a later index operation in that session is staging reversals of the moves (`git status`
shows `RD` renames back to the old paths). **The working tree on disk is the intended state**;
the index is not. Before committing:

1. Confirm on disk: no `VISION_EDGE/WORKSPACE/IDENTITY.md` at root; `docs/archive/` has
   `vision-2026-07/`, `syncr-requests/`, `acceptance-records/`, `effect-migration-plan.md`,
   `roadmap-port-2026-10-14.md`; `docs/` root has no `effect-migration-plan.md`,
   `skill-engine-*-request.md`, `*-acceptance.md`.
2. `git add -A -- VISION.md VISION_ORCHESTRATION.md VISION_EDGE.md VISION_WORKSPACE.md VISION_IDENTITY.md AGENTS.md CHANGELOG.md docs/` to make the index match the disk, then review `git status` once more.
3. `docs/archive/acceptance-records/mcp-proxy-acceptance.md` is the PI-03f-annotated copy
   (the "Historical" note at the top); the root copy was moved over it on disk.
