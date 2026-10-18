---
id: ade-q0z3
status: in_progress
deps: [ade-nobk]
links: []
created: 2026-10-17T22:05:05Z
type: task
priority: 2
assignee: almoretti
parent: ade-u3ld
---
# SUB-02: session record shares, sponsor per turn, refusal rules

ADR 0006 amendment: shares on the session record ({[userId]: {providers: 'all', at}}), sponsor on each turn event, allowedOperations for share/withdraw (own entry only), the refusal (409 / RPC ok:false) with the message naming the missing subscription and the two ways out; prompts, steers and follow-ups all enforced; forks carry no shares.


## Preconditions from the CRB-02 reviews (2026-10-18), required before shares can be enabled

1. Broker path allow-list per API kind: only the model endpoints (`/v1/messages*`, `/v1/responses*`, `/v1/chat/completions`, `/v1/models`, Codex `/codex/responses`) may be forwarded; everything else answers 403. A sponsor's credential must spend, never act (OpenAI `/v1/files/{id}/content`, ChatGPT `backend-api/*`, Anthropic `/api/oauth/*`).
2. The broker refuses a session's requests while that session has no running turn (SessionManager knows), so a leftover background job, a terminal or a planted git hook cannot spend the last author's subscription between turns. Add this limit to ADR 0009's security model.
3. Compaction (rpcHandler compact), rerun (historyActions) and `/mcp login` record the requester as the current sponsor; today they bill the last author or the owner.
4. The sponsor of each turn goes on the turn event (already in this ticket's scope) and the spend log line gains the model id.

## Design (architect, 2026-10-18) — read before implementing

Base: CRB-02 (`d7dcab8`, `e9fe16a`, `6d7497f`) and CRB-03 (`8552ca8`), both merged; read their design and review sections on ade-nobk and ade-0mj8 and `apps/server/src/credentialBroker.ts` first. `shares` already exists on the session record (`packages/contracts/src/protocol.ts`, `providers: "all"` only in this release) and the broker already consults it when it picks a sponsor; `materializeHistoryFork` already drops it. This ticket makes shares usable and closes the four preconditions listed above. Shared-server profile only; the desktop refuses the new operations.

### 1. Operations and routes

- `SessionOperation` (packages/domain/src/sessionRecord.ts) gains `share` and `withdraw`. `share`: allowed for any signed-in user on a server-side session that is not ended, moving or a pointer (reuse the lifecycle rules the other operations use); refused on the local side ("Subscriptions are shared on the server only"). `withdraw`: as `share`, and only when `record.shares?.[user.id]` exists ("You have not shared a subscription into this session"). The operator is a participant like anyone else here (no override).
- Routes in `apps/server/src/routes/sessions.ts`: `POST /sessions/:id/shares` (body `{ providers: "all" }`, strict) sets `shares[user.id] = { providers: "all", at: now }`; `DELETE /sessions/:id/shares` removes the caller's own entry. Both go through `sessionRefusal(operations, meta, "share"|"withdraw", user)`, mutate through the same chokepoint the other meta mutations use (so `session_meta` is broadcast and the index persisted), and answer the updated record. A share applies from the broker's next request (it reads the record per request; nothing cached).
- Event log: one event per change (`share.added` / `share.withdrawn`, actor = the user) through the existing producers in `apps/server/src/eventProducers.ts`; find the pattern the other session-level events use and keep the payload to `{ userId }`.
- Import, move and return paths must not carry `shares` (sessionTransfer.ts copies explicit fields; confirm and add a test).

### 2. The refusal at prompt time

- New broker method `canSponsor(meta, providerId, user): Promise<{ ok: true } | { ok: false; error: string }>` that reuses the candidate walk of `sponsor()` (own credential first, then sharers) without performing a request. `claude-bridge` maps to the broker provider `claude-code`.
- Every entry that starts model work on the shared server checks it before Pi sees the message: `stageAuthor` sites in `apps/server/src/rpcHandler.ts` (prompt, steer, follow-up), `POST /sessions/:id/prompt`, `compact` (rpcHandler ~1074), rerun (`apps/server/src/historyActions.ts` action "rerun"), `/mcp login` (`apps/server/src/routes/mcp.ts` ~497). The provider is the session's current model's (`state.model.provider` on a live session, the launch plan's for a draft). Refusal: HTTP `409 { code: "subscription", error }`, RPC `ok: false` with the same `error`, text: `<provider> needs a subscription: sign in under Settings > Providers, or ask a participant to share theirs` (the broker's own text; keep one constant). Members without a subscription may still read (owner's default).
- Those same entry points record the requester as the running turn's sponsor of first choice: `SessionManager.beginSponsoredWork(sessionId, user)` sets an in-memory "current requester" the broker's `latestAuthor` dep consults before `SessionAuthorStore.latest()`, and marks the session as having a running turn (see 3). It clears when the session reports idle (the same place `activity` flips, or the turn-end event). Prompts already stage the author; compact, rerun and `/mcp login` did not (contrarian finding 10).

### 3. The two broker preconditions

- **Idle refusal.** `CredentialBrokerDeps.turnRunning(sessionId): boolean`; a request for a session with no running turn answers `409 { error: "No turn is running in this session" }` and a spend line with status 409. Running = between a prompt/steer/follow-up/compact/rerun/`/mcp login` being accepted and the session reporting idle; transient (helper) records count as running for their lifetime. Pi's own autoTitle call happens inside the turn (verified on the VM); if a legitimate call shows up after idle in your tests, widen the window by a few seconds after idle rather than dropping the rule, and say so.
- **Path allow-list per provider.** A const table in the broker: provider id (or `default`) to allowed path prefixes after the provider segment. Start with: `anthropic` and `claude-code`: `/v1/messages`, `/v1/models`; `openai`: `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`; `openai-codex`: `/codex/responses`, `/codex/models`; `google`: `/v1beta/models`; `openrouter`: `/api/v1/chat/completions`, `/api/v1/models`, `/api/v1/key`; `default`: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`, `/chat/completions`, `/models`. Anything else answers 403 (spend line 403). Match on the normalized pathname (collapse `//`, no `..`). Verify the Codex and Anthropic prefixes against pi-ai 1.2's api modules (`dist/api/*.js` build the URLs) and against what the VM log shows; adjust the table rather than the rule.
- The spend line gains `model` (`deps.currentModel(sessionId)` returns `provider/id` or undefined).

### 4. Sponsor on the turn event

`turnPrompted(sessionId, actor, mode, text)` gains the resolved sponsor (`{ userId }`) when the broker is present; the event schema's optional field is `sponsor`. Readers that render turn events ignore unknown fields today; confirm.

### 5. Docs

- ADR 0006 amendment 7: `shares` on the record, who may change it, forks/imports/moves carry none.
- ADR 0009 amendment 4: the security model gains the idle refusal and the path allow-list; shares are enabled from this ticket.
- Runbook `docs/remote-server-poc.md`: a short "Sharing a subscription" paragraph (routes, what a share lets others do, how to withdraw, that the picker arrives with SUB-04).

### 6. Tests (single files)

domain: `share`/`withdraw` in the operations table (server session, local session, ended, no own entry). server: the two routes (201/200, 409 refusals, record and event), the prompt refusal over HTTP and RPC (a prompter without a credential: 409 / `ok:false`; with a sharer present: accepted and the sponsor on the turn event), compact/rerun/mcp-login recording the requester, broker `canSponsor`, idle refusal (409 and spend line), the allow-list (one case per row plus a 403), `model` in the spend line; `sessionTransfer` test that `shares` is not exported or imported; `profileMatrix`: the share route answers on the shared server and is refused on the desktop.

Out of scope: the web (SUB-04), Claude Code in the image (SUB-05), CRB-04. Constraints as for CRB-02/03: no git tree-changing commands, no commit, single vitest files only, no builds, no secrets, desktop unchanged. Report files, tests with counts, deviations, open questions.
