---
id: ade-4lga
status: closed
deps: []
links: []
created: 2026-10-14T17:59:27Z
type: task
priority: 1
assignee: almoretti
---
# SRV-10: shared credential writes are refused on a shared server (interim guard)

Live finding 2026-10-14: the VM has one Pi credential file (~/.pi/agent/auth.json, currently only the operator openai-codex OAuth sign-in) and the Settings > Providers screen still offers Connect and Sign out on the shared server. Any signed-in user can POST /runtime/providers/:id/login or /logout and overwrite or remove the operator credential for everyone, and PUT /runtime/env can write a provider key such as ANTHROPIC_API_KEY into the shared global .env so every user runs on it. Interim guard until SRV-11 lands per-user credentials: on a shared server (ctx.sharedServer, see ade-rpkm) (1) POST /runtime/providers/:id/login and /logout answer 409 with the error text "Not available on a shared server: provider sign-ins are shared by everyone here; per-user sign-in is coming" (one constant next to SHARED_SERVER_REFUSAL in apps/server/src/trustedProxy.ts); (2) PUT /runtime/env (both scopes) refuses a key that is a provider credential env name with 409 "Not available on a shared server: provider keys are personal, add them under Providers" - the name set comes from pi-ai (packages pi-ai env-api-keys.js: findEnvKeys / the provider to env-name table; import the exported helper or copy the table into one constant with a comment naming the source) and must include ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY; EXA_API_KEY stays writable (web search, shared by design). (3) web: ProvidersScreen when store.me is set renders Connect and Sign out disabled with the title "Not available on a shared server" and a one-line notice; RuntimeScreens shows the 409 error text as it already does for other errors.

## Design

GUARDRAILS: checkout mirrored live to the VM by Syncthing; never git checkout/switch/stash/reset; no builds, no full suites (low memory): run only the test files you touch, one at a time, plus eslint and prettier on changed files; do not commit. Smallest diff: two 409 early-returns and one key-name check in apps/server/src/routes/settings.ts, one web conditional. This is the interim half of a pair: SRV-11 removes the login/logout 409 again when it routes those calls to the per-user auth file, so keep that check in one place and comment it as such; the env key refusal stays permanently.

## Acceptance Criteria

Route test (settings): with sharedServer true, provider login and logout return 409 and the login manager and logoutProvider are never called; PUT /runtime/env with key ANTHROPIC_API_KEY returns 409 and the .env is unchanged, PUT with key EXA_API_KEY still writes; with sharedServer false everything behaves as before. Web test: ProvidersScreen with me set renders the controls disabled and the notice; with me null unchanged. docs/remote-server-poc.md Known gaps lists the refusal and the reason.


## Notes

**2026-10-14T18:04:57Z**

Implemented. Server: SHARED_SERVER_REFUSAL gains providerSignIn (interim, SRV-11 removes it) and providerKey (apps/server/src/trustedProxy.ts). In apps/server/src/routes/settings.ts, provider login/logout return 409 first when ctx.sharedServer is set, and PUT /runtime/env (both scopes) returns 409 for keys in PROVIDER_CREDENTIAL_ENV_KEYS. That constant is copied from pi-ai 0.82.0 getApiKeyEnvVars, which is not exported. EXA_API_KEY is not in the list. Web: ProvidersScreen disables Connect and Sign out (title 'Not available on a shared server') and shows a notice when me is set. RuntimeScreens unchanged, it already shows the response text. Docs: remote-server-poc.md Known gaps. Tests: remoteServerIdentity.test.ts 14/14 (new: login/logout 409 with auth.json unchanged; ANTHROPIC/OPENAI 409 with .env unchanged; EXA writes). New runtime-provider-credentials.test.ts 2/2 (loopback: ANTHROPIC_API_KEY writes; login/logout reach the 404 path, so no 409). ProvidersScreen.test.tsx 3/3. eslint, prettier --check, tsc server and web all clean. Not covered: DELETE /runtime/env can still remove a provider key on a shared server; Bedrock/AWS and Vertex ADC env names are outside the pi-ai table; the table must be re-synced when pi-ai is bumped.

**2026-10-14T18:09:12Z**

Amendment: DELETE /runtime/env now refuses PROVIDER_CREDENTIAL_ENV_KEYS with the same 409 providerKey message (both scopes) on a shared server (settings.ts). New test in remoteServerIdentity.test.ts: DELETE ANTHROPIC_API_KEY returns 409 and .env is byte-identical; DELETE EXA_API_KEY returns 200 and removes it. File 15/15. Known gaps now says PUT and DELETE, and names AWS_* (Bedrock) and GOOGLE_APPLICATION_CREDENTIALS (Vertex) as writable by design. eslint, prettier --check, server tsc clean.

**2026-10-14T18:10:54Z**

2026-10-14 architect review: accepted as is (ponytail: two early returns per route pair, one copied name table with its source named, one web boolean). DELETE guard added after the contrarian pass. Known limits: pi-ai table copied from 0.82.0 and must be refreshed on the Pi upgrade; AWS_* and GOOGLE_APPLICATION_CREDENTIALS stay writable by design.
