# VISION_EDGE — execution at the edge, coordination in the cloud

_Decision of record: Syncr #125 (M.25 execution model) + #122 ADR notes. 2026-07-29._

**Agents run on their owner's machine. Period — including in the multiuser future.**

_Exception: an opt-in shared headless host for trusted co-workers, see [ADR 0003](docs/adr/0003-shared-server-trust-model.md)._

The cloud (Syncr) is the coordination plane: identity, projects, channels, events, jobs, audit.
The edges — each member's Agent Deck — execute. Code, worktrees, API keys, model traffic, and
agent runtime never touch the coordination plane. This is simultaneously our privacy posture
("your agents' work never touches our servers"), our cost posture (we host no compute), and
Buzz's own proven model (buzz-acp pools on members' machines watching a shared stream).

## Owner-online is the model, not a stopgap

A project agent is reachable when its owner's Agent Deck is online. A job request addressed to
an offline member's agent sits `pending` in the event stream until their host comes online and
claims it (Syncr M.24). Presence makes this legible, never embarrassing:
`@release-agent — owner offline, 2 jobs queued`.

**Edge execution stays the product default.** A shared headless host is supported only as the
opt-in deployment for mutually trusted co-workers described in
[ADR 0003](docs/adr/0003-shared-server-trust-model.md); per-user-machine execution remains
first-class regardless.

## Offline mode is first-class

Agent Deck must run fully offline for a user when collaboration isn't needed:

- Local sessions, local agents, local skill edits — the engine's three-tree sync was built for
  exactly "work locally, reconcile later".
- **Locally-authored events** (messages, review comments, job requests/results for the user's
  own agents) accumulate in a local outbound queue and sync on reconnect. Event ids are
  client-generated and content-addressed, so they are stable without a server round-trip;
  ordering authority is ingest order at the coordination plane, never client clocks (Syncr #123).
- Device-side signing (VISION*IDENTITY) is what makes offline work \_verifiable*: events signed
  while offline validate at upload. The compensating control is verification-at-upload — a
  deprovisioned user's offline backlog is rejected at sync and surfaced to admins (Syncr #122).
- The guarantee, stated as product truth: **collaboration features degrade offline; personal
  agent use never does.** The cloud is never required for the tool to function.

## Engineering consequences

- Every collaboration feature must specify its offline behavior at design time (queue, stale,
  or unavailable) — "requires connectivity" is a decision, not a default.
- The local event store + outbound queue is core infrastructure, not a cache.
- The one open prerequisite before any multiplayer exposure: the REST origin/CSRF guard
  (roadmap Track 1 #3) — the WS local-origin guard must be mirrored onto mutating REST routes.
