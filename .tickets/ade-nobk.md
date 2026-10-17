---
id: ade-nobk
status: in_progress
deps: [ade-w2zc]
links: []
created: 2026-10-17T22:05:04Z
type: task
priority: 1
assignee: almoretti
parent: ade-u3ld
---
# CRB-02: the credential broker service (placeholders, sponsor per request, refresh, revocation, spend log)

The broker as a server service: one endpoint per session on the container address, placeholders per (session, secret), the secret store (members' sign-ins and API keys from their agent dirs, Environment variables marked secret with host + injection rule), sponsor selection per request from the session's shares and the prompter, OAuth refresh with pi-ai's code in the server, revocation on withdraw, per-turn spend log (sponsor, author, provider), nothing real in any session file or env (the session's auth.json and models.json carry placeholders and the broker base URL; Claude Code gets ANTHROPIC_BASE_URL and a placeholder token). Contrarian + GPT review of the header handling before merge.

