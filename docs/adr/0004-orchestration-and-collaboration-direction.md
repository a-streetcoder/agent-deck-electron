# ADR 0004 — Direction: the shared server is the collaboration model; graph engineering is the orchestration model; one event log underneath both

- **Status:** Accepted (2026-10-15, owner decision, recorded by the Claude session `claude-d6`)
- **Supersedes:** the July 2026 vision set (`docs/archive/vision-2026-07/`): Syncr as
  coordination plane, attested identity chains, edge execution as the default product model
- **Amends:** [ADR 0003](0003-shared-server-trust-model.md) decision 1 (see below)
- **Keeps:** [ADR 0002](0002-consolidate-skill-engine.md) — the Syncr skill-engine addon stays
  a pinned code dependency; this ADR changes product direction, not the build
- **Expressed in:** [`VISION.md`](../../VISION.md), [`VISION_ORCHESTRATION.md`](../../VISION_ORCHESTRATION.md),
  [`docs/roadmap.md`](../roadmap.md)

## Context

Two things happened since the July vision was written.

1. The shared server POC (`poc/shared-server`, [`remote-server-poc.md`](../remote-server-poc.md),
   [handover](../handover-shared-server-poc.md)) was proven end to end on 2026-10-14: two people,
   their own Cloudflare Access identity and provider sign-ins, agents executing on the VM,
   sessions visible to both. It is where the last twenty commits and the open SRV tickets are.
   ADR 0003 admitted it as an opt-in exception to "agents run on the owner's machine"; the
   handover doc lists "VISION_EDGE contradiction" as gap 1.
2. The orchestration layer became the most developed part of the codebase — six loop structures,
   persisted and resumable subagents, a two-way supervisor channel, checkpoints — without any
   vision document mentioning it. New orchestration ideas (the t3code execution-node tree and
   delta merge-back) had nowhere to go but a paragraph in the roadmap's "deferred" track. The
   August 2026 survey on "graph engineering" (arXiv 2608.21156) gives that layer a model.

The owner's view, stated on 2026-10-15: Syncr "was a good idea but not the right one"; the shared
server "is where I see a team work together"; graph engineering "is the direction … an evolution
from the current orchestration"; the t3code orchestrator comment "is a first start in that
direction".

## Decision

1. **The shared Agent Deck server is the collaboration model.** The room where a team's humans
   and agents work together is an Agent Deck server behind Cloudflare Access, with the trust
   model of ADR 0003 (mutually trusted co-workers; attribution, not isolation). Syncr is no
   longer the coordination plane, identity root or catalog; the `VISION_IDENTITY` chain
   (device enrolment, attestation, signing) is not pursued.
   _Amendment to ADR 0003 decision 1:_ the shared host and the local desktop are **two
   supported deployment modes of the same code, neither the default product model and neither
   depending on the other**. The inert-when-unset rule for `AGENT_DECK_TRUSTED_PROXY` and the
   offline guarantee for local mode both stand.

2. **Graph engineering is the orchestration model.** Orchestration is organised as three
   explicit views — task organisation, agent coordination, runtime state management — plus
   system evolution, as described in `VISION_ORCHESTRATION.md`. The existing loops, subagents,
   supervisor channel and plan are the starting point, not a thing to replace. The principles in
   that file (pure graph logic in `packages/domain`, a harness-agnostic node contract, the
   producer never grades itself, delta not transcript, recover at the node, legibility before
   depth, evidence before orchestration depth, no graph database) bind implementation tickets.

3. **One append-only event log is the runtime-state substrate.** Loop runs, subagent runs,
   supervisor requests, plan changes, checkpoints, approvals and messages are events on one
   per-project log with stable client-generated ids. It is built before the task graph (the
   graph is a projection of it), it replaces the separate loop-run, subagent-run and supervisor
   stores as the source of truth (they may remain as indexes), and it is the stream the shared
   server serves. Storage stays files: JSONL per project, git refs for workspace state.

4. **The node contract is defined before any second engine.** A node is
   `(harness, agent, task, reads) → (result, artifacts, verdict, events)`. Pi is the only harness.
   ACP is a candidate later node type; adopting it is a separate ADR.

## Consequences

- `VISION.md` is rewritten; `VISION_EDGE/WORKSPACE/IDENTITY` move to `docs/archive/vision-2026-07/`.
  Ideas from them that survive (the one addressable event log, agent jobs with a visible
  lifecycle, the offline guarantee for local mode) are restated in the new files.
- `docs/roadmap.md` is rewritten as lanes: orchestration (new), shared server (carried over),
  distribution (carried over), housekeeping. The orchestration lane starts with the two t3code
  items.
- `docs/sync-seams.md` and `docs/skill-store-contract.md` remain valid as engineering
  documents for the pinned addon; "lift onto the shared engine" in `sync-seams.md` describes an
  option, not a commitment.
- Shared-server work continues on `poc/shared-server` under the open SRV tickets; nothing in
  this ADR changes their scope. The audience widening preconditions in ADR 0003 still apply.
- Ticket authoring for the orchestration lane follows the NAH loop (`AGENTS.md`, "Way of
  working"): the owner asks for the tickets; this ADR and `VISION_ORCHESTRATION.md` are their
  context.
- The parity registers stay where the `parity-loop` skill expects them; they are historical
  except ANA-01 and DST rows.
