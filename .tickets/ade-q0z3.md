---
id: ade-q0z3
status: open
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
