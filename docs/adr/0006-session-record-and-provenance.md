# ADR 0006 — The session record: one versioned shape, provenance as a first-class relation

- Status: **Accepted** 2026-10-16 (owner `approved`; implementation ticket ade-os47)
- Deciders: Ale (owner), architect session
- Related: [ADR 0003](0003-shared-server-trust-model.md) (trust model), [ADR 0004](0004-orchestration-and-collaboration-direction.md) (event log as the runtime-state substrate), `VISION_ORCHESTRATION.md` principles 5, 7 and 9

## Context

`SessionMeta` (`packages/contracts/src/protocol.ts`) grew by accretion over the shared-server
and orchestration lanes. It now has about sixty top-level optional fields. The same relation,
"this session came from that one, by this operation, done by this actor", is spelled six ways:

| Field(s)                                                                              | Added by              | Means                                                     |
| ------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| `forkProvenance`, `forkedFrom { sessionId, title, owner }`                            | message fork, SRV-15a | created as a fork of another session                      |
| `sharedFrom { device, localSessionId, sharedAt, mode }`                               | SRV-12c1              | imported on the server from a device's session            |
| `sharedTo { serverOrigin, serverSessionId, device, deviceSessionId, sharedAt, mode }` | SRV-12c1, 12c3        | this copy is a frozen pointer; the live copy is elsewhere |
| `returnedFrom { serverOrigin, serverSessionId, returnedAt, mergePr }`                 | SRV-12c3              | brought back from the server                              |
| `returnPending { token, serverOrigin, serverSessionId, ref, until, mergePr }`         | SRV-12c3              | a return whose last step did not complete                 |
| `worktreeOwnerSessionId`, `loopReviewRunId`, parent links in the subagent run store   | worktrees, loops, A4  | inherits a workspace, reviews a run, spawned by a run     |

Location and ownership are implicit: a pointer is a session with `sharedTo`; the owner lives in
`createdBy` or inside `sharedTo.owner`; where the live copy runs is inferred from which of the
transfer blocks is set. Every route re-derives these rules, and the two security review rounds
of 2026-10-15 were largely about making the derivations agree.

Six worktree fields (`worktreePath`, `worktreeIdentity`, `worktreeBranch`,
`worktreeSourceBranch`, `worktreeCleanupBranchHead`, `worktreeOwnerSessionId`) and six launch
fields (`launchPlan`, `launchResourceConfig`, `providerOverride`, `modelOverride`,
`extensionsOverride`, `skillsOverride`, `thinkingOverride`, `launchResourceFingerprint`) sit flat
beside them.

A session's state is spread over five stores: the per-project `sessions.json` (the record), the
Pi session file (the transcript, owned by Pi), `session-authors.json` (attribution), the
per-project event log (lane A1), and the run and worktree stores. ADR 0004 said the older
stores become indexes over the event log; the session record itself was never folded in.

The t3code orchestration-v2 evaluation (2026-10-13) is the origin of this item. What it offers
and we take is the **provenance triple on every record**: what kind of creation, from where, by
whom (`createdBy: user | agent | system`, `creationSource`). What we do not take, as decided in
the old roadmap, is the thread/turn model, the AppThread versus provider-thread split and the
ContextHandoff machinery: they pay off only with a second engine.

## Decision

1. **One versioned session record.** `SessionMeta` gains `schemaVersion: 2` and four grouped
   objects that replace the loose fields:
   - `provenance { kind, from?, by, at }` with `kind` one of `created | forked | moved |
returned | spawned | imported | reviewed`, `from` one of `{ sessionId, serverOrigin? }`,
     `{ device, localSessionId }` or `{ runId }`, and `by` one of `{ user }`, `{ agent }` or
     `"system"`. It replaces `forkProvenance`, `forkedFrom`, `sharedFrom`, `returnedFrom`'s
     origin part, `loopReviewRunId` and the parent link of spawned children. Provenance is
     written once at creation and never rewritten.
   - `location { kind, owner, live?, transfer? }` with `kind` one of `local | server`, `live`
     one of `{ serverOrigin, sessionId }` or `{ device, sessionId }` when this copy is a frozen
     pointer, and `transfer` the in-flight hand-off (`{ direction, token, ref, until, mergePr? }`).
     It replaces `sharedTo`, `returnPending` and the `mergePr` records; `createdBy` remains the
     creator, `location.owner` is the current owner.
   - `workspace { path, identity, branch, sourceBranch, cleanupBranchHead, ownerSessionId }`
     replacing the six worktree fields.
   - `launch { plan, resourceConfig, overrides { provider, model, extensions, skills,
thinking }, fingerprint, refreshError }` replacing the flat launch fields.

2. **Explicit lifecycle.** `lifecycle` becomes `draft | running | parked | ended | pointer |
moving`, derived today from `lifecycle`, `status`, `parkedAt`, `endedAt`, `sharedTo` and the
   hand-off claims. Each route that refuses an operation (prompt, steer, rollback, fork, merge,
   move, return) does so from `lifecycle` and `location`, through one domain function
   `allowedOperations(record, actor)` in `packages/domain`, not from the presence of fields.

3. **The transcript boundary is unchanged.** The Pi session file stays Pi's; the record keeps
   `piSessionFile` and gains `transcriptSha256` (written at move, return and fork so stale
   copies are detectable). The live mirror and the transfers already work from the file.

4. **Source of truth and indexes.** `sessions.json` remains the record store (one JSON per
   project, as today). `session-authors.json` is retired: per-message authorship is already in
   the event log (lane A1); the server projects authors from it. `provenance` is also emitted as
   a `session.created` event with the same triple, so lineage across sessions is a query over
   the log, not a new store.

5. **Lineage is a pure function, not a feature.** `lineage(records, sessionId)` in
   `packages/domain` walks `provenance.from` in both directions and feeds the existing fork
   chips, pointer banners and Run tree. No new store, no new screen, no graph database
   (`VISION_ORCHESTRATION.md` principle 9).

6. **Migration once, on load.** Records without `schemaVersion` are mapped to version 2 the
   first time a project is opened and written back once; unknown fields are preserved; the
   mapping is a pure function with a test per old field. Clients that send old shapes to
   `PATCH` routes are refused with 400 after the migration ships on both sides (the branch is
   not on `main`; two people hold data).

## Alternatives considered

- **Lineage first, as its own feature with its own store.** Rejected: it is one relation inside
  the record; defining it before the record means defining it twice, and a lineage store with
  views is the ontology layer the vision excludes unless it answers a user question the
  existing chips do not.
- **Adopt t3code's thread/turn model.** Rejected again (as in the 2026-10-14 roadmap): Pi owns
  the turn structure; a second thread model would duplicate the Pi file.
- **Leave the grown shape and document it.** Rejected: the six spellings are where the review
  rounds found inconsistencies; documentation does not remove the re-derivation in each route.
- **Move the record into the event log entirely.** Deferred: ADR 0004 allows it, but the record
  is read on every list and the log is append-only per project; a projection cache would be
  needed first. The versioned record keeps that door open.

## Consequences

- One ticket (SES-01) implements the record, the migration, the domain functions and the route
  and web switch, with the fork, move, return, merge and worktree tests as the regression net.
  The 2026-10-15 security dispositions are re-checked against `allowedOperations`.
- `docs/orchestration-reference.md` gains a "Session record" section with the shape and the
  lifecycle table; `remote-server-poc.md` transfer sections reference `location` instead of the
  old blocks.
- Future operations (ACP nodes, scheduled runs) add a `provenance.kind` value, not a new block.

## Amendments (2026-10-16, from the SES-01 implementation and its reviews)

The implementation deviates from the text above in six places. Each is recorded here so the
ADR stays the source of truth; none changes the direction.

1. **`session-authors.json` stays, for now.** Attribution matches a stored hash of each prompt
   to the Pi entry that echoes it; the event log (`turn.prompted`) carries neither the hash nor
   the entry id, so the projection in decision 4 cannot be built from it yet. The store remains
   the single source of authorship until the log carries what the projection needs; retiring it
   is a follow-up, not part of SES-01.
2. **`launch` has one `resourceConfig` and no `overrides` object.** The per-session overrides
   were always inside the pinned resource config; a second object would duplicate them. Shape:
   `launch { plan, resourceConfig, fingerprint, refreshError }`.
3. **`location.transfer` is `{ direction, token, serverOrigin, sessionId, ref?, until }`** and
   `mergePr` sits on `location`, not inside `transfer`: on a device the pull request outlives
   the hand-off, or the merge warning would disappear when the return completes. Finishing the
   return needs the server origin and the server session id.
4. **Provenance is kept on return.** A session that comes back keeps the provenance it was
   created with (write-once holds). The server copy it came back from is recorded in
   `location.transfer` while the hand-off is open and, durably, in the `session.shared` event.
   A device→server→device round trip is therefore a query over the log, not a walk over
   `provenance.from`; `lineage()` covers forks and reviews. `kind: "returned"` appears only on
   migrated legacy records.
5. **`spawned` has no producer yet.** Spawned children have no session record of their own
   (they live in the run store), so there is nothing to stamp; the kind stays reserved.
6. **`by` is `{}` for a person on a device without sign-in.** There is no identity to record;
   `lineage()` does not read `by`.

Two rules the reviews added: `location.kind` is set from the running process on every load,
never trusted from the file (a data directory opened once on the wrong side must not stamp
its records for good); and legacy keys found on an already-versioned record (written by an
older build sharing the data directory) are mapped and win, then removed. Rollback to an older
build means restoring `sessions.v1.bak.json` over `sessions.json` first. `transcriptSha256` is
the hash of the transcript as the creating operation carried it: the export envelope at move
and return (what the import duplicate check compares), the file as written at fork.
