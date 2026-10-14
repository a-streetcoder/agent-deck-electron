# ADR 0003 — Shared headless host: a supported deployment with a co-worker trust model

- **Status:** Accepted (2026-10-14)
- **Qualifies:** [VISION_EDGE](../archive/vision-2026-07/VISION_EDGE.md) ("agents run on their owner's machine") — superseded by [ADR 0004](0004-orchestration-and-collaboration-direction.md), which makes the shared host the collaboration direction
- **Live setup + security model:** [remote-server-poc.md](../remote-server-poc.md)
- **Consulted:** nah-contrarian, 2026-10-14. Objections accepted:
  - (3) A server-minted bearer token cannot pass the Cloudflare Access edge on its own, so the
    desktop login must obtain a per-user Access credential. That is why ade-1vjx is a spike.
  - (5) Git identity must follow the session **owner**, not the prompt author: the Pi process env
    is fixed at start, and Access emails may be private GitHub emails.
  - (6) Per-user GitHub tokens stored under one Unix user are readable by every agent, so SRV-06
    is attribution, not isolation.

## Context

VISION_EDGE says agents run on their owner's machine and that a shared headless project host is
not committed; revisiting it is an ADR-level decision. The `poc/shared-server` branch builds and
runs that host:

- Browser or Electron shell → Cloudflare Tunnel + **Cloudflare Access** (GitHub IdP) → the Agent
  Deck server on a Linux VM, listening on loopback only and trusting the Access assertion only
  from the local `cloudflared`.
- **Pi runs as one Unix user** (`ale`) inside server-owned clones in `/srv/streetcoding`. Each
  session records `createdBy` and each user message an `author`; the UI shows both.
- **One set of provider logins** in the VM's `~/.pi/agent` (one Claude subscription, one Codex
  login) serves every user's prompts.
- The whole mode is **opt-in** behind `AGENT_DECK_TRUSTED_PROXY` (plus the `AGENT_DECK_CF_ACCESS_*`
  and `AGENT_DECK_PUBLIC_ORIGIN` variables). With it unset the server, web UI and desktop shell
  behave as before: loopback only, no identity.

## Decision

1. **The shared headless host is a supported deployment alongside the edge model, not a
   replacement.** Per-user-machine execution stays first-class and the default; nothing in the
   edge model may come to depend on the shared host.
2. **Trust model: mutually trusted co-workers on one Unix user.** Access authenticates; nothing
   authorizes. Everyone admitted by the Access policy can see and act on every session, project
   and file, and runs with the service user's filesystem, keys and tokens. Attribution
   (`createdBy`, `author`, and per-session git identity once it lands) is a **label, not an
   authorization boundary**. Real isolation (a Unix user or container per person) is out of scope
   until the audience grows beyond co-workers who trust each other.
3. **The POC lands on `main` as opt-in.** It stays behind `AGENT_DECK_TRUSTED_PROXY`, and must
   remain inert when that is unset.
4. **Shared provider logins and quota are accepted for this team.** Every user's prompts spend
   the same subscription quota and are billed and rate-limited as one account. Sharing a personal
   subscription across people may breach the provider's terms of service; we accept that risk for
   this two-person team, knowingly. It does not extend to any wider audience, where per-user
   provider credentials are a prerequisite.
   _Amended 2026-10-14 (ade-n41e):_ each user now signs in to their own providers, stored in a
   per-user Pi agent dir, and a session runs on its OWNER's credentials, so prompting someone
   else's session spends the owner's subscription. The operator's sign-ins stay in the shared
   dir and also serve sessions without an owner. This is storage and billing separation, not
   isolation: under the one Unix user any agent can read every user's `auth.json`, OAuth
   refresh tokens included.
   _Amended 2026-10-14 (ade-c7ad, PRV-01):_ the accepted terms-of-service risk covers sharing a
   subscription, not impersonation. Claude on a subscription runs only through `claude-bridge`
   (the real Claude Code under the host's login); Pi's Anthropic OAuth sign-in, which presents
   Pi as Claude Code, is no longer offered or accepted, and `anthropic/*` needs an API key.
   This applies on every server, desktop and loopback included, not only on the shared host:
   the owner's instruction and the terms problem are not specific to the shared deployment.
5. **A "Linux target" for distribution may mean this headless server deploy**, not a desktop
   package. Register rows DST-05 and DST-06 are re-scoped in the DST epic, not here.

## Consequences

- VISION_EDGE stays the default product model; it now points here for the exception.
- Before the audience widens, the known gaps close first: the REST Origin/CSRF guard (ticket
  ade-63d3, mirroring the WebSocket guard), git identity per session owner (ade-fr91), and the
  system-browser desktop login (ade-1vjx).
- The audit trail is the attribution label plus Cloudflare Access logs. It records who asked,
  not what each person was allowed to do.
- Every change on the shared path keeps the unset-env behaviour identical to the edge build;
  tests for the opt-in mode must cover the inert case.
- Shared quota means one user's heavy loop can starve the other; there is no per-user limit.
