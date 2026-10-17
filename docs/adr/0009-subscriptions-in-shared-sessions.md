# ADR 0009 — Subscriptions in shared sessions: whose credentials run a turn, and a broker that keeps them out of sessions

- Status: **Accepted** 2026-10-18 (owner `approved`; broker first; new sessions start with no shares, a share covers all providers in the first release, members without a subscription may still read)
- Deciders: Ale (owner), architect session
- Related: [ADR 0003](0003-shared-server-trust-model.md) (trust model: attribution, not isolation),
  [ADR 0006](0006-session-record-and-provenance.md) (session record), [ADR 0007](0007-per-session-process-sandbox.md)
  (the sandbox around every session; amendment 19 deferred credential masking),
  [ADR 0008](0008-deployment-profiles.md) (the shared-server profile), `docs/remote-server-poc.md` "Credentials"
  and "Known gaps" (the SBX-05 evidence)

## Context

On the shared server every session runs on its **owner's** credentials: the owner's Pi agent dir holds
their provider sign-ins and API keys, and a prompt from any other member runs in that same Pi
process, so it spends the owner's subscription (ADR 0003, SRV-11). The Claude bridge went further:
one host Claude Code login for everyone, which the image never shipped (ade-81m8), so Claude
subscription models never worked on the server at all.

The owner's direction (2026-10-18): a subscription belongs to a person, for every provider (a Claude
Code sign-in, the Codex ChatGPT sign-in, an API key). A collaborator in a session either brings their
own or uses one that a participant has **shared into that session**. Sharing is a choice any
participant can make for a session, at any time, and the model picker must show, clearly labelled,
which subscription a choice runs on. Nothing runs on somebody's subscription without that person's
explicit share.

Asked how the subscriptions would be stored securely, the honest answer was: they are plain files
under one Unix user, the sandbox keeps a session from reading other members' files but not its
own owner's, and a share implemented by linking a file into a session would hand the sponsor's
refresh token to everyone in that session. The owner chose **broker first**: no sharing until a
credential proxy keeps tokens out of sessions altogether.

Facts the design rests on (verified 2026-10-17/18):

- Pi's `models.json` can point a provider at another `baseUrl` with its own `apiKey` and
  `headers` (`core/model-config.js`), for custom and known providers alike.
- Claude Code honours `ANTHROPIC_BASE_URL` and takes its subscription token from
  `CLAUDE_CODE_OAUTH_TOKEN` (the Agent SDK passes both), so it can be pointed at a proxy with a
  placeholder token.
- OAuth refresh for the sign-in providers lives in `@earendil-works/pi-ai` (`auth/oauth/*`), which
  the server already depends on, so a broker in the server process can refresh tokens itself.
- The SBX-05 spike measured a terminating proxy inside the sandbox at +0.9 ms per request locally
  and +12% median on remote calls, with SSE streamed incrementally and 50 MB bodies intact; what
  failed was the runtime's process-wide, name-keyed masking (cross-user leak), WebSocket upgrades,
  HTTP/2 and Basic auth. Those are properties of that implementation, not of the idea.
- Inside the sandbox the runtime refuses loopback upstreams and the policy denies the host's own
  addresses; the SBX-05 echo server was reached on the container's address with an explicit allow.
- A session's owner is `createdBy`; every prompt carries its author (`requestUser`); the model
  catalog a session is offered is the owner's (`ownerCatalog`).

## Decision

1. **Vocabulary.** A _subscription_ is one person's credential for one provider (sign-in or key),
   stored in that person's own agent dir, read only by the server. A turn's _sponsor_ is the person
   whose subscription runs it. Attribution (who wrote the prompt) stays separate from sponsorship
   (who pays); both are recorded on the turn.
2. **The credential broker.** Sessions never hold a real credential. The server runs one broker
   per session: an HTTP endpoint on the container's address that the session's sandbox may reach,
   with one placeholder per provider. Pi's `models.json` for the session points each provider at
   the broker with its placeholder; Claude Code gets `ANTHROPIC_BASE_URL` and a placeholder
   `CLAUDE_CODE_OAUTH_TOKEN`. The broker validates the placeholder, swaps in the sponsor's real
   authorization (and the provider's extra headers, such as the Codex account id), forwards to the
   provider over TLS, streams the response back, and refreshes OAuth tokens itself with pi-ai's
   code. The session's `auth.json` holds placeholders only; the sponsor's file is never linked
   anywhere. Withdrawing a share stops the broker; there is nothing in the session to copy.
3. **The rule.** A turn runs on the prompter's own subscription for the session's provider when they
   have one. Otherwise it runs on a subscription a participant has shared into this session. If
   neither exists the prompt is refused with a message that names the missing subscription and the
   two ways out (sign in, or ask a participant to share). The owner is a participant like any other:
   their subscription is not available to others until they share it. The sponsor switch between
   turns happens in the broker's memory.
4. **Sharing.** `shares: { [userId]: { providers: string[] | "all", at } }` on the session record. Any
   participant shares or withdraws their own entry at any time from the session header. Withdrawal
   applies from the next request the broker sees; a running turn finishes. Default: no shares. A
   fork carries no shares. Doctor lists the sessions where the caller's subscription is shared.
5. **The picker.** Two levels: first the subscription (_Yours_, then _<name>'s, shared_), then the
   models that subscription offers. The composer chip shows both ("gpt-6-luna · yours",
   "claude-opus-4-8 · Ale's"). A model you cannot run is listed under the subscription that would
   run it, disabled, with the reason.
6. **Sandbox.** The session's policy allows exactly its broker's address and port (ADR 0007
   amendment); the provider hosts themselves leave the default allow-list once every provider the
   session uses goes through the broker, so a session has no path to a provider except with the
   broker's consent. Subagents and helpers of a turn inherit its sponsor.
7. **Environment secrets go through the same broker.** A variable in the Environment screen
   (global or project) can be marked _secret_ with an injection rule: the hosts it may reach and
   how it is sent (bearer, header name, query parameter). A secret variable reaches the session as
   a placeholder and the broker expands it only on requests to those hosts; an unmarked variable
   keeps today's behaviour, injected raw, which stays right for values that are not credentials.
   On the shared server a project's secrets are the project's, shared by its members as the
   variables are today; the broker changes what a session can read, not who may use them. A
   secret used outside HTTP to its hosts (a CLI sending it elsewhere, Basic auth) cannot be
   expanded; the rule says so when it is set, and the owner may still choose raw injection.
8. **Claude Code is part of the package.** The image installs a pinned Claude Code; each member
   signs in once from their own session terminal with their config folder, which stays in the
   member's dir in the data volume and is read only by the server. ADR 0003's "the host's login,
   the same for every owner" is superseded.

## Security model, stated

- The server process holds every member's credentials, as it does today (ADR 0003's one Unix
  user). The broker moves them out of sessions, out of transcripts and out of the terminal.
- A share lets a session's participants _spend_ a subscription through the broker while the share
  lasts; it never lets them _read_ it. Spending is logged per turn with sponsor and author.
- What the broker cannot cover: a provider whose client pins certificates or needs a transport the
  broker does not pass (WebSockets, HTTP/2). Pi's and Claude Code's HTTP clients need neither;
  if one appears, that provider is simply not brokered and not shareable.
- The broker is a new piece of security-relevant code in the request path; it ships with a
  contrarian and GPT review of its header handling, and the stack matrix gains a brokered turn.

## Cases

| Prompter                          | Has own subscription for the provider                | A participant shared theirs | Runs on                                                    |
| --------------------------------- | ---------------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| owner                             | yes                                                  | —                           | owner's, through the broker                                |
| member                            | yes                                                  | —                           | member's, through the broker                               |
| member                            | no                                                   | yes (one)                   | that participant's                                         |
| member                            | no                                                   | yes (several)               | the one picked in the picker; the first offered by default |
| member                            | no                                                   | no                          | refused, with the two ways out                             |
| anyone, Claude subscription model | the sponsor's Claude Code sign-in through the broker | same rule                   | same rule                                                  |

## Alternatives considered

- **Link the sponsor's `auth.json` into the session.** Pi would pick it up between turns (it reloads
  on file revision), but every participant of the session could read the refresh token for as long
  as the share lasted and keep a copy. Rejected by the owner.
- **The runtime's own masking (SBX-05).** One registry per server process keyed by variable name:
  one user's token reaches another user's requests. Rejected with evidence (ADR 0007 am. 19).
- **One Pi process per sponsor per session.** Isolates nothing the broker does not, doubles
  processes and splits the transcript.
- **Owner-only toggle.** Keeps the owner's credentials as everyone's default; the owner rejected it.

## Consequences (ticket tree; epic ade-u3ld)

- CRB-01 (ade-w2zc) spike (VM): a broker in the server process on the container address; a sandboxed Pi
  completes real turns on Anthropic (key) and Codex (sign-in, account header) through placeholders;
  Claude Code completes a turn through `ANTHROPIC_BASE_URL`; SSE streams; the sandbox allows only
  the broker; overhead measured against SBX-05's numbers. Evidence on the ticket; go/no-go.
- CRB-02 (ade-nobk) broker service: per-session placeholders for subscriptions and secret Environment
  variables, sponsor selection per request, OAuth refresh in the server, revocation, per-turn
  spend log, no credential in any session file or env; the Environment store gains the secret
  flag and injection rule.
- CRB-03 (ade-0mj8) sandbox: the broker allow and the provider hosts' removal from brokered sessions (ADR 0007
  amendment), stack matrix row.
- SUB-02 (ade-q0z3) record and rules: `shares` on the session record (ADR 0006 amendment), sponsor on each turn
  event, the refusal and its message, `allowedOperations` for share and withdraw.
- SUB-04 (ade-9syd) web: the two-level picker, the composer chip, the session header share controls, the
  refusal message, Providers and Doctor per user, the Environment screen's secret flag and rule.
- SUB-05 (ade-k1nc) package: Claude Code pinned in the image, per-user config folder, sign-in from the
  session terminal, runbook first-run step (absorbs ade-81m8).
- Docs: `remote-server-poc.md` "Credentials" rewritten to this ADR; ADR 0003 and ADR 0007 amended.

## Open questions for the owner (answered 2026-10-18)

1. Default for a new session: **no shares**.
2. A share is **all-or-nothing across providers** in the first release.
3. A member without any subscription **may still read** a session they cannot prompt.

## Amendments

1. **2026-10-18, from CRB-01 (ade-w2zc).** The spike ran curl, Node fetch and Claude Code inside srt
   against a broker on the container address. All checks passed (header, query and bearer
   placeholders swapped; 2 MB up and 20 MB down streamed; SSE unbatched; direct provider host
   refused; +0.2 ms per request for the broker). Three facts bind the implementation: srt denies a
   hostname that resolves to the container's own address unless `<ip>:<port>` is itself in
   `allowedDomains` (that literal is the carve-out, not `deniedResolvedAddresses` as the decision's
   point 6 and CRB-03 said); inside srt every host goes through srt's proxy, so the launch env
   clears `NO_PROXY` and Node clients get `NODE_USE_ENV_PROXY=1` (Pi's own launch already has it);
   srt drops single quotes from a wrapped one-liner, so the spawn path hands it a script or argv.
   Pi itself runs inside srt (ADR 0007), so the broker allow is a precondition of the first
   brokered turn and moves into CRB-02; CRB-03 keeps the removal of the provider hosts. The real
   Codex turn is the first brokered turn on the deployed CRB-02 server.
2. **2026-10-18, sequencing of decision 7.** Secret Environment variables through the broker split
   off into CRB-04: a subscription rides a base URL the session's Pi honours, an arbitrary tool
   command talking to an arbitrary host does not, so that path needs the broker on the sandbox's
   outbound route (srt `parentProxy` with MITM for the marked hosts, or an explicit broker URL per
   host), decided in CRB-04's design pass. The decision stands; only the order changes.
3. **2026-10-18, from the CRB-02 design.** Pi 1.2 derives the Codex account id from the access
   token's own claim (`extractAccountId`), so the session placeholder is JWT-shaped with a
   placeholder claim the broker also swaps; the Codex API opens a WebSocket first and falls back to
   SSE, so the broker passes upgrades through (the "cannot cover WebSockets" consequence above is
   narrowed to protocols the broker does not pipe). OAuth refresh is pi-ai's own, run by
   `ModelRuntime.getAuth()` under the credential-store lock in the server; the broker adds none.
