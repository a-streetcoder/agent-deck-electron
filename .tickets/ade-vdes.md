---
id: ade-vdes
status: closed
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

## Notes

**2026-10-14T19:26:43Z**

Implemented. Server: GET /me adds user.providersConnected (listProviders on userRoots, signedIn||configured; best-effort, field omitted if the agent dir check throws so /me never loses the identity). routes/sessions.ts: ownerModels(owner) throws 409 'No model provider connected. Connect one under Settings > Providers.' when an owner has zero models; used by validateModel and at the top of launchSession (covers draft start via RPC prompt and REST POST /sessions startImmediately). Web: ProviderMissingBanner (Composer + App no-active-session), CurrentUser.providersConnected?, refreshMe on resources_changed when me is set. Docs: Credentials bullet + /me shape. Tests: remoteServerIdentity.test.ts 14 passed / 4 skipped (new SRV-13 block is skipIf(!canSymlink), skipped on this Windows box; verified via a temporary operator-email variant, 2/2 passed, file deleted); ProviderMissingBanner.test.tsx 2/2; TerminalDrawer 2/2; Composer.test.tsx 8/8. tsc server+web clean, eslint+prettier clean. Deviations: existing /me test assertions loosened toEqual->toMatchObject; no REST draft-start route exists, so REST 409 is exercised through POST /sessions startImmediately.

**2026-10-14T19:27:33Z**

2026-10-14 architect: Linux run on the VM remoteServerIdentity 18/18 (the two SRV-13 cases included). Ponytail: accepted (one flag on /me, one ownerModels guard reused by validateModel and launchSession, one banner in two places). Known: the composer prefixes the server text with its usual "Not acknowledged" line; a provider configured only through server env counts as connected.

**2026-10-14T19:46:36Z**

Correction round (GPT review). (1) routes/sessions.ts draftModels: when an owner is set, ctx.discoveredModels is filtered to providers the owner's own ModelRuntime reports configured (getProviderAuthStatus(provider).configured), so the operator's discovery no longer bypasses the no-provider guard. Test: remoteServerIdentity.test.ts SRV-13 now runs POST /runtime/models/discover (discoverModelCatalog mocked with an ext-provider model) before the REST 409 / RPC ok:false checks; verified on this Windows box through a temporary operator-email variant (2/2 passed; with the filter disabled it fails 201 vs 409), file removed. Full file: 14 passed / 4 skipped (symlink-gated). (2) wsBridge.ts refreshMe keeps the last known identity on a fetch/HTTP failure, sets null only on a successful {user:null}. New wsBridge.refreshMe.test.ts 2/2; ProviderMissingBanner.test.tsx 2/2. tsc server+web clean; eslint+prettier clean on changed files.

**2026-10-14T19:47:12Z**

2026-10-14 architect: review4 fixes accepted (discovered catalog filtered by the owner provider auth status; /me refresh keeps the last identity on failure). Known: a provider configured only through server env still counts; a credential-free extension provider is dropped from a shared-server owner picker.
