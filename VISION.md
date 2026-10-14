# Vision — what Agent Deck is becoming

_Rewritten 2026-10-15 from the owner's decisions of that day (recorded in
[ADR 0004](docs/adr/0004-orchestration-and-collaboration-direction.md)). It replaces the
2026-07-29 vision set — VISION_EDGE, VISION_WORKSPACE, VISION_IDENTITY — which is kept under
[`docs/archive/vision-2026-07/`](docs/archive/vision-2026-07/) for the ideas it still carries.
When this file and an ADR disagree, the ADR wins — then fix this file._

---

Agent Deck today is a workspace for running coding agents with clarity and control: every
agent, skill, prompt, loop and session in one window, with explicit scope, live structured
output and parallel work that stays organised.

Agent Deck's destination is **the room where a team's humans and agents work together — on a
shared server, with the agents organised as a system rather than as one loop at a time.**

Three commitments shape everything:

1. **[Orchestration as system intelligence](VISION_ORCHESTRATION.md).** One agent in one loop
   is done and works well. The next step is organising many: explicit task graphs with
   dependencies and parallelism, agents coordinated by capability and role with independent
   verification, and runtime state that can be inspected, localised when it fails, and resumed
   from the last good node. This is the "graph engineering" direction; the vision file says what
   we take from it and what we leave.

2. **Collaboration on the shared server.** A team reaches one Agent Deck server from their own
   machines, with their own identity (Cloudflare Access) and their own provider sign-ins; the
   agents execute on the server, in server-owned clones and per-session worktrees; every session
   and message carries who asked. The trust model is
   [ADR 0003](docs/adr/0003-shared-server-trust-model.md) (mutually trusted co-workers;
   attribution, not isolation); the live setup is [`docs/remote-server-poc.md`](docs/remote-server-poc.md).
   The desktop app in local mode stays a first-class, fully offline way to use the same product.

3. **One event log.** Loop runs, subagent runs, supervisor requests, plan changes, checkpoints,
   approvals and messages are events on one append-only, per-project log with stable ids.
   The orchestration engine reads it to schedule and recover; the UI renders it as the
   execution-node tree; the shared server serves it as the stream a team watches. The
   orchestration substrate and the collaboration stream are the same object, built once.

What stays true from today's Agent Deck, permanently: you can see what is active; you can see
what will change; parallel work stays organised; it feels native. The vision adds _who else is
in the room_ and _how the agents are organised_ — it never subtracts the calm, legible,
single-user tool.

## What changed from the July 2026 vision

- **Syncr is no longer the coordination plane.** The July vision made the product a governed
  surface over Syncr (directory identity, attested delegation chains, catalog entitlements). The
  owner's call on 2026-10-15: a good idea, not the right one. The shared Agent Deck server is the
  collaboration model. The Syncr skill-engine addon remains a pinned **code dependency**
  ([ADR 0002](docs/adr/0002-consolidate-skill-engine.md), [`docs/skill-store-contract.md`](docs/skill-store-contract.md));
  that is a build fact, not a product direction, and the seam design in
  [`docs/sync-seams.md`](docs/sync-seams.md) is closed under ADR 0005 and kept as history.
- **Identity is Cloudflare Access plus per-user provider sign-in**, with `createdBy`/`author`
  as attribution labels. No device enrolment, no attestation chains, no signing code.
- **Edge execution is a deployment mode, not the default product model.** Local desktop and
  shared server are two supported deployments of the same code; neither depends on the other.
  The offline guarantee of the July vision stands for local mode.
- **Orchestration has a vision of its own.** The July set did not mention loops, subagents,
  the supervisor channel or the plan at all; they are now the centre of the product.

## Non-goals (decided, not open)

- A public multi-tenant cloud. The shared server is for a team that trusts each other.
- Our own identity provider, PKI, or signed-event spine.
- A second agent engine before the orchestration node contract exists. ACP (Agent Client
  Protocol) stays a candidate for a later node type; Pi is the engine.
- A graph database or an ontology layer. Graphs here are JSON, JSONL and git refs.
