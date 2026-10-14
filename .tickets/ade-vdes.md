---
id: ade-vdes
status: in_progress
deps: []
links: []
created: 2026-10-14T19:20:10Z
type: feature
priority: 1
assignee: almoretti
---
# SRV-13: tell a user to connect a provider before a session can fail on missing credentials


Owner request 2026-10-14 after SRV-11 shipped: "We should have something before a fail or an error message" for a user who has not connected a model provider yet. Today on the shared server such a user (own empty auth.json) sees an empty or wrong model picker and, on start, either `unknown model: <provider>/<id>` from validateModel (apps/server/src/routes/sessions.ts, which already resolves models per draft owner) or Pi's `No API key found for "<provider>"` after the spawn.

Wanted behaviour:

1. Server: `GET /runtime/providers` is already per user. Add a cheap boolean to the existing `GET /me` payload: `providersConnected: boolean` (any provider signedIn or configured for the requesting user's agent dir; computed with listProviders on the user roots; false on loopback is never shown because the web gates on `me`). When the draft owner has NO available model at all, draft start and validateModel answer with a stable message `No model provider connected. Connect one under Settings > Providers.` (409 on the REST path, ok:false with that error on the RPC path) instead of `unknown model`.
2. Web: when `me` is set and `me.providersConnected` is false, show one banner in the new-session / composer area and in the sessions empty state: "You have not connected a model provider yet. Connect one under Settings > Providers to start a session." with a button that opens the Providers screen. The banner disappears when the store's `me` refreshes after a successful sign-in (the Providers screen already broadcasts resources_changed on login; refetch `/me` on that signal or on returning from the Providers screen). The composer stays enabled (drafts are allowed) but a start attempt surfaces the server message above, not a raw error.
3. Docs: one sentence in docs/remote-server-poc.md Credentials section.

## Design

GUARDRAILS: checkout mirrored live to the VM by Syncthing; never git checkout/switch/stash/reset; no builds, no full suites (low memory): single test files, eslint, prettier, server and web tsc; do not commit; do not ssh. Ponytail: reuse `me` for the flag (no new route), reuse the existing error path in validateModel, one banner component used in two places, no new dependency. PI-01 (ade-7zpu) runs in parallel in a worktree and may touch routes/sessions.ts near getSupportedThinkingLevels; keep your edit there minimal and local to validateModel / draft start.

## Acceptance Criteria

Route test: with two identities, `/me` reports providersConnected true for the user whose auth.json has a credential and false for the other; starting a draft as the user with no provider returns the stable message (REST 409 and RPC ok:false). Web test: the banner renders when me.providersConnected is false and not when true or when me is null; the button navigates to Providers. Live check by the architect: the owner's `/me` through the tunnel reports true.
