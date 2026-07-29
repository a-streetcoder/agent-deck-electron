# Vision — what Agent Deck is becoming

<em>Written 2026-07-29, from the Syncr/agent-deck alignment discussion. Decisions referenced here
are owned by the Syncr `phase:market` issue track (#101–#125) and `Syncr/docs/research-nostr.md`;
these files are the agent-deck-side articulation, in the spirit of block/buzz's `VISION_*.md`.
When a vision file and a Syncr issue disagree, the issue wins — then fix the vision file.</em>

---

Agent Deck today is a desktop workspace for running coding agents with clarity and control.
Agent Deck's destination is **the room where a team's humans and agents work together** — a
Slack-style project workspace where every agent is a member with a real identity, every action
is attributable to the human who authorized it, and everything the org has governed (skills,
prompts, tools, credentials) is simply _present_ in the project, correctly scoped, without
anyone thinking about it.

The inspiration is [block/buzz](https://github.com/block/buzz) — "a workspace where humans and
agents build together" — with one deliberate inversion: Buzz is self-sovereign and self-hosted
for the open ecosystem; we are building the **enterprise-managed** version, where the same
collaboration model is fused to Syncr's governance (identity lifecycle, entitlements,
credential brokering, signed audit). Buzz proved the category in a week; the governed variant
of it is unoccupied space.

Three commitments shape everything, each with its own vision file:

1. **[VISION_EDGE.md](VISION_EDGE.md)** — _execution stays on the user's machine._ The cloud
   coordinates; it never executes. Agent Deck works fully offline; collaboration degrades,
   personal agent use never does.
2. **[VISION_WORKSPACE.md](VISION_WORKSPACE.md)** — _projects are the unit of collaboration._
   Channels anchored to real objects (skills, suggestions, diffs, jobs), humans and agents as
   project members, delegation with a visible lifecycle.
3. **[VISION_IDENTITY.md](VISION_IDENTITY.md)** — _every action chains to a human._ Owner-
   attested delegation (human → device → agent → action), signed on this device, revocable
   transitively, verifiable offline.

What stays true from today's Agent Deck, permanently: you can see what is active; you can see
what will change; parallel work stays organized; it feels native. The vision adds _who else is
in the room_ — it never subtracts the calm, legible, single-user tool.

## Relationship to Syncr

Syncr is the coordination plane and the governance engine; Agent Deck is the premier surface.
The integration seam is the **NAPI engine contract** (`@a-streetcoder/skill-engine-native`,
ADR-0002, `docs/skill-store-contract.md`) — org-catalog capabilities (assigned manifests,
provenance verification, suggest-back, usage events, attestations) arrive as engine surface
extensions consumed through the same injectable seam. No parallel integration paths.

## Non-goals (decided, not open)

- Hosting agent execution in the cloud (Syncr M.25 / M.19 posture).
- Self-sovereign user keys as identity; any Nostr _dependency_ (wire compatibility remains a
  demand-gated option — `Syncr/docs/research-nostr.md` Phase 2).
- Voice, mobile, E2E DMs — real, later, explicitly deferred (M.25).
