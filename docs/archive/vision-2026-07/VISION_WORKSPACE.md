# VISION_WORKSPACE — projects where humans and agents collaborate

_Decision of record: Syncr #123 (M.23 conversation layer), #124 (M.24 job lifecycle), #125
(M.25 north star). Inspired by block/buzz; governed variant. 2026-07-29._

## The shape

A **Project** is the unit of collaboration: members (humans _and_ agents), assigned assets
(skills/prompts/loops via the Syncr catalog), entitled tools, channels, and jobs. The project
channel is _where governance binds_: an agent in the channel operates under project-scoped
entitlement intersections, and every action carries its owner-attested chain. Chat is the UX
wrapper around the governance engine — not a separate product bolted on.

The core insight lifted from Buzz: **collapse conversation and artifacts into one addressable
event log.** A patch is a message. A review comment is a reply. A job result is an event
threaded on the object it touched. An approval is an event. No Slack-next-to-GitHub split;
"seven tabs pretending they know about each other" becomes one stream with one identity model.

## The event model (Syncr-side, #123)

- Every message anchors to an addressable object (FQN): a channel, a suggestion, a skill
  version, a diff hunk, an access request, an agent job.
- Channel types from day one: `project` / `review` / `dm` — even though the **first shipped
  slice is review threads only** (PR-style threaded comments on suggestions and diff hunks).
  Retrofitting channels under a threads-only model would be a rewrite; designing channel-first
  costs nothing now.
- Offline-authorable by construction (VISION_EDGE): client-generated content-addressed ids,
  idempotent upload, ingest-order authority.

## Agent jobs (#124)

Delegation with a visible lifecycle: `request → accepted → progress → result | error | cancel`,
every transition a signed event. On top of it:

- **Needs-action feed** (Buzz's "Home"): one query across a user's pending world — reviews
  assigned to them, access requests, device approvals, mentions, finished jobs.
- **Job board**: address a job to an agent (or capability); it queues until the owner's host
  claims it. Claim semantics serialize per conversation (one in-flight prompt per channel,
  mention-batching — the buzz-acp pool pattern).
- Attribution no competitor has: not "an agent did X" but "this agent, authorized by this
  human, on this device, did X — verifiably."

## Clients

Agent Deck (Electron) is the native workspace; `apps/web` grows into the browser workspace for
members without the app. Same event stream, same identity, one design system.

## Staging (each stage independently justified)

1. Review threads on suggestions/diffs (the thin slice; Continue.dev's vacated ground).
2. Project channels — chat anchored to real work.
3. Agents in channels — M.24 jobs, needs-action feed, job board.
4. Workspace polish — presence, notifications, search.

Deferred explicitly (M.25): E2E-encrypted DMs, mobile/push, message search+retention at team
scale (needs its own design pass before the first team onboards), voice.

## Direction under consideration (not yet decided)

**ACP (Agent Client Protocol) as the harness seam** — Buzz drives Goose, Codex, and Claude
Code through one stdio JSON-RPC interface with a runtime catalog as the single source of truth
per harness. Agent Deck is pi-native today; generalizing via ACP would let project agents be
any harness. Tracked as design input on Syncr #111 — decide when agents-in-channels (stage 3)
is scoped.
