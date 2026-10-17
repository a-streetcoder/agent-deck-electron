# ADR 0009 — Subscriptions in shared sessions: whose credentials run a turn

- Status: **Proposed** 2026-10-18 (owner direction of 2026-10-18; awaiting the owner's `approved`)
- Deciders: Ale (owner), architect session
- Related: [ADR 0003](0003-shared-server-trust-model.md) (trust model: attribution, not isolation),
  [ADR 0006](0006-session-record-and-provenance.md) (session record), [ADR 0007](0007-per-session-process-sandbox.md)
  (the sandbox around every session), [ADR 0008](0008-deployment-profiles.md) (the shared-server profile),
  `docs/remote-server-poc.md` "Credentials"

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

Facts the mechanics rest on (verified 2026-10-18):

- Pi reads `auth.json` through `AuthStorage`, which reloads the file whenever its revision changes
  (`getFileRevision` / `reload` / `readLatestData`), so a session's credentials can change between
  turns without restarting Pi.
- The bridge starts Claude Code as a subprocess that inherits the Pi process environment, so its
  config folder (`CLAUDE_CONFIG_DIR`) is fixed at Pi's launch; what the folder _contains_ is not.
- A session's owner is `createdBy`; every prompt carries its author (`requestUser`), recorded by the
  session-authors store; the model catalog a session is offered is the owner's (`ownerCatalog`).

## Decision

1. **Vocabulary.** A _subscription_ is one person's credential for one provider (sign-in or key),
   stored in that person's own agent dir, as today. A turn's _sponsor_ is the person whose
   subscription runs it. Attribution (who wrote the prompt) stays separate from sponsorship (who
   pays), both recorded on the turn.
2. **The rule.** A turn runs on the prompter's own subscription for the session's provider when they
   have one. Otherwise it runs on a subscription a participant has shared into this session. If
   neither exists the prompt is refused with a message that names the missing subscription and the
   two ways out (sign in, or ask a participant to share). The owner is a participant like any other:
   their subscription is not available to others until they share it.
3. **Sharing.** `shares: { [userId]: { providers: string[] | "all", at } }` on the session record. Any
   participant shares or withdraws their own entry, for all providers or some, at any time, from the
   session header. Withdrawal applies from the next turn; a running turn finishes. Default: no
   shares. A fork carries no shares (it runs on the forker's own subscriptions, as now).
4. **The picker.** The model picker becomes two levels: first the subscription (_Yours_, then
   _<name>'s, shared_), then the models that subscription offers. The chip in the composer shows
   both, "gpt-6-luna · yours" or "claude-opus-4-8 · Ale's". A model you cannot run is shown
   under the subscription that would run it, disabled, with the reason.
5. **Mechanics.** Each session gets its own credential surface under the data dir,
   `<dataDir>/sessions/<id>/credentials/` with an `auth.json` link and a Claude Code config folder,
   and Pi launches against it. Before a turn the server points the link at the sponsor's real
   `auth.json` (Pi reloads on the revision change; token refreshes Pi writes land in the sponsor's
   own file) and the Claude Code folder at the sponsor's. Subagents and helpers of the turn inherit
   the sponsor. The sandbox re-allows the session's credential surface for reading, as it does the
   owner's dir today.
6. **Claude Code is part of the package.** The image installs a pinned Claude Code; each member
   signs in once from their own session terminal (`claude auth login` with their config folder);
   Doctor and the Providers screen report the caller's own sign-in; the per-user folder is in the
   data volume and survives upgrades. ADR 0003's "the host's login, the same for every owner" is
   superseded by this ADR.

## Cases

| Prompter                                     | Has own subscription for the provider              | A participant shared theirs | Runs on                                                    |
| -------------------------------------------- | -------------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| owner                                        | yes                                                | —                           | owner's                                                    |
| member                                       | yes                                                | —                           | member's                                                   |
| member                                       | no                                                 | yes (one)                   | that participant's                                         |
| member                                       | no                                                 | yes (several)               | the one picked in the picker; the first offered by default |
| member                                       | no                                                 | no                          | refused, with the two ways out                             |
| anyone, model is a Claude subscription model | the bridge needs the sponsor's Claude Code sign-in | same rule                   | same rule                                                  |

## Alternatives considered

- **Owner-only toggle "share my subscription".** Simpler, but it keeps the owner's credentials as
  the session's default for everyone, which is the state the owner rejected: a member with their own
  subscription would still spend the owner's.
- **One Pi process per sponsor per session.** Isolates credentials fully but doubles processes and
  splits the transcript; Pi's reload on revision makes the link swap sufficient.
- **Credentials chosen at session creation only.** Rejected: collaboration changes mid-session, and
  the owner asked for sharing at any point.

## Consequences (ticket tree, to approve)

- SUB-01 spike: a session credential surface with a swapped `auth.json` link; Pi picks up the
  change between turns without restart; the Claude bridge follows a swapped config folder. Two
  real turns on two subscriptions in one session on the VM, evidence on the ticket.
- SUB-02 record and rules: `shares` on the session record (ADR 0006 amendment), the sponsor on each
  turn event, the refusal and its message, `allowedOperations` for share/withdraw.
- SUB-03 server: the credential surface per session, the per-turn sponsor switch for prompts,
  steers, follow-ups, subagents and helpers; the sandbox re-allow; tests under both profiles.
- SUB-04 web: the two-level picker, the composer chip, the session header share controls, the
  refusal message, Providers and Doctor per user.
- SUB-05 package: Claude Code pinned in the image, per-user config folder, sign-in from the
  session terminal, runbook first-run step (absorbs ade-81m8).
- Docs: `remote-server-poc.md` "Credentials" rewritten to this ADR; ADR 0003 amended.

## Open questions for the owner

1. Default for a new session: no shares (this ADR) or the owner's subscription shared by default.
2. Whether a share may be limited to some providers or is always all-or-nothing in the first release.
3. Whether a member without any subscription may still _read_ a session they cannot prompt (today: yes).
