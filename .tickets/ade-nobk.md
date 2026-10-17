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


## Design (architect, 2026-10-18) — read before implementing

Scope of this ticket: subscriptions (Pi providers and Claude Code) through the broker on the **shared-server profile only** (ADR 0008; the desktop profile keeps direct credentials and is untouched). Secret Environment variables through the broker moved to CRB-04 (see the epic): they need the broker to act as a forward proxy for arbitrary hosts, a different mechanism.

### Facts from the code (Pi 1.2, srt 0.0.80), verified by the architect

- Pi's `models.json` `providers.<id>` accepts `baseUrl`, `apiKey`, `headers` for a **built-in** provider: `baseUrl` is applied to every model of the provider (`provider-composer.js` ~188), a configured `apiKey` makes an api-key auth even for an OAuth-only provider such as `openai-codex` (`composeApiKeyAuth`: the "no fabricated api-key login" guard applies only when no key is configured), a literal that is not `${ENV}` or `!command` resolves to itself (`resolve-config-value.js`). The session-side `auth.json` stays `{}`.
- The Codex API (`api/openai-codex-responses.js`) derives the account id **from the access token itself**: `extractAccountId(apiKey)` splits the token on `.`, base64-decodes part 2 and reads `payload["https://api.openai.com/auth"].chatgpt_account_id`; it throws without it. So the placeholder must be JWT-shaped (three dot-separated parts, part 2 valid JSON with that claim). Codex uses a **WebSocket** transport first (`transport: "auto"`, `resolveCodexWebSocketUrl(model.baseUrl)`) and falls back to SSE per session when the socket fails: the broker must pass an `upgrade` through (header rewrite, then pipe the two sockets), or every Codex turn pays a failed attempt.
- On the server side `ModelRuntime.create({authPath: <sponsor's auth.json>, modelsPath: <operator models.json>})` (already `ownerRuntime()` in `claudeTransport.ts`) and `runtime.getAuth(providerId)` returns `AuthResult { auth: { apiKey?, headers?, baseUrl? } }` **with OAuth refresh done under the credential-store lock** (`Models.getAuth()` runs `refresh` inside `modify`; `minOAuthValidityMs` defaults to five minutes). The broker needs no OAuth code of its own. `openaiCodexOAuth.toAuth` yields `{ apiKey: access }` only; the account id comes from the token's claim as above.
- Pi **runs inside srt** (ADR 0007; `server.ts` "the process sandbox around every session's Pi"): its model calls go through srt's proxy, so the broker's `<ip>:<port>` literal must be in the policy's `allowedDomains` (CRB-01 finding 1; the hostname alone is refused as "one of this host's addresses"). `packages/pi-host/src/sandbox.ts` already adds `NODE_USE_ENV_PROXY=1`; the brokered launch env also sets `NO_PROXY=` and `no_proxy=` (CRB-01 finding 2). (The note on ade-w2zc / ADR 0009 amendment 1 that "Pi runs outside srt" was wrong and is corrected in the same commit as this design.)
- Claude Code honours `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_OAUTH_TOKEN` (CRB-01 check 9: `POST /v1/messages` with the placeholder bearer at the broker). Its Linux credential file is `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` with `claudeAiOauth.{accessToken, refreshToken, expiresAt(ms), subscriptionType}` (verify the field names on the VM against the real file; never print values).
- The current turn's author is staged by `rpcHandler.ts` `stageAuthor()` into `SessionAuthorStore.stage()`; the store has no "latest author" accessor yet.
- `runtimeEnvFiles()` layers the operator's global `.env` under every session: a provider key there would bypass the broker. `PROVIDER_CREDENTIAL_ENV_KEYS` (routes/settings.ts) names those keys.

### Shape

New `apps/server/src/credentialBroker.ts`:

- `CredentialBroker` with `start()` / `stop()`: Node `http` server on `AGENT_DECK_BROKER_HOST` (default: the first non-internal IPv4 of `os.networkInterfaces()`, the container address) and `AGENT_DECK_BROKER_PORT` (default 4211); never published by Compose. Logs `[broker] listening on <ip>:<port>` through `serverLog`.
- Session registration is stateless: a per-install secret in `<dataDir>/broker-secret` (0600, created once) and `token = hmac-sha256(secret, sessionId)`; the URL is `http://<ip>:<port>/<sessionId>/<token>/<providerId>/<rest>` (`providerId` is a Pi provider id, or `claude-code` for Claude Code). Verify with `timingSafeEqual`; unknown session or bad token: 404 with no detail.
- Placeholder (one per session, the same for every provider): `ph.<base64url of {"https://api.openai.com/auth":{"chatgpt_account_id":"ph-acct-<token>"}}>.<token>`, JWT-shaped for the Codex claim above; the account placeholder is `ph-acct-<token>`. The broker replaces the full placeholder string and the account placeholder wherever they appear in header values and query values (the spike's `expand()`), then merges the sponsor's `auth.headers` over the request headers, sets `host`, and pipes request and response bodies unchanged (status and headers copied; no buffering; the spike's broker is the reference shape). For Codex the account id is the `chatgpt_account_id` claim of the sponsor's real access token (six lines; pi-ai does not export `extractAccountId`). Handle `upgrade` the same way (rewrite the handshake headers, `net`/`tls` connect to the upstream, pipe both sockets).
- Upstream for a provider: the operator runtime's provider base URL (`runtime.getProvider(id)?.baseUrl`, falling back to its first model's `baseUrl`); for `claude-code`: `https://api.anthropic.com`. Per-model `baseUrl` overrides in the operator's models.json are not honoured on brokered sessions (documented in the runbook).
- Sponsor per request: `author = sessionAuthors.latest(sessionId) ?? sessionOwner(record)`; candidates `[author, ...Object.keys(record.shares ?? {})]`; the first whose credentials cover the provider wins (`runtime.hasConfiguredAuth(providerId)` on the candidate's own agent dir; for `claude-code` a credentials file whose `expiresAt` is in the future). None: `401 {"error": "<provider> needs a subscription: sign in under Settings > Providers, or ask a participant to share theirs"}`. The `ModelRuntime` per user is cached 60 s (sign-ins show within a minute). `record.shares` becomes an optional field of the session record now (`Schema.optional(Schema.Record({key: Schema.String, value: Schema.Struct({providers: Schema.Literal("all"), at: Schema.String})}))`); SUB-02 adds the routes, rules and events.
- Claude Code sponsor token: read `<userClaudeConfigDir>/.credentials.json` (operator: the host's `~/.claude`, so the current VM login keeps working for the owner; others: `<dataDir>/users/<hash>/claude`, a helper `userClaudeConfigDir(dataDir, userId)` next to `userAgentDir` for SUB-05 to reuse). Within five minutes of `expiresAt`: run `claude auth status --json` with that `CLAUDE_CONFIG_DIR` once and re-read; still expired: 401 naming the sponsor's sign-in. Whether `auth status` refreshes is unknown; record what the VM shows on the ticket, SUB-05 owns the final refresh story.
- Spend log: one line per upstream request appended to `<dataDir>/credential-spend.jsonl`: `{at, sessionId, provider, sponsor, author, status, ms}` (user ids, never credentials). Rotation is out of scope.
- `sessionCredentials(meta, sandboxed)` (same module or `sessionAgentDir.ts`): creates `<dataDir>/sandbox/<sessionId>/agent` with `ensureUserAgentDir(sharedAgentDir, dir, sandboxed, { except: ["models.json"] })` (extend the function with an `except` list; `auth.json` stays the `{}` it writes), then writes `models.json`: the operator's shared models.json parsed (absent: `{}`), and for every id in `runtime.getRegisteredProviderIds()` of the operator runtime `providers[id] = {...existing, baseUrl: <broker>/<sessionId>/<token>/<id>, apiKey: <placeholder>}`, dropping `modelOverrides[*].baseUrl` and `models[*].baseUrl`. Returns the launch env: `PI_CODING_AGENT_DIR=<dir>`, `ANTHROPIC_BASE_URL=<broker>/<sessionId>/<token>/claude-code`, `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>`, `CLAUDE_CONFIG_DIR=<dataDir>/sandbox/<sessionId>/claude` (created; the session's Claude Code writes its state there), `NO_PROXY=`, `no_proxy=`. `spawnHooks.forget()` already removes `<dataDir>/sandbox/<sessionId>`.

Wiring:

- `SessionManager.ownerLaunchEnv`: when a `credentialBroker` is injected (new optional constructor parameter, shared-server only), use `credentialBroker.launchEnv(meta, launch)` **instead of** `userAgentDirEnv(...)`, and strip `PROVIDER_CREDENTIAL_ENV_KEYS` (export the set from a shared place, e.g. `sessionEnv.ts`) from the layered env. Helpers and children go through the same chokepoint (they already call `ownerLaunchEnv`), so they inherit the session's broker URL and the turn's sponsor.
- Sandbox policy: `SessionSandboxDeps.broker?: string` (`<ip>:<port>`) flows into the `sandboxPolicy` input as `broker?` and is pushed into `allowedDomains`. Removing the provider hosts from brokered sessions, the stack matrix row and Doctor stay CRB-03 (now depending on this ticket).
- `SessionAuthorStore.latest(sessionId): UserIdentity | undefined` (the newest staged turn's author).
- `server.ts`: construct and start the broker when `sharedServer`; stop it in the shutdown path; `capabilities.broker: true` for SUB-04. `/me` and Doctor changes are not part of this ticket.
- Runbook `docs/remote-server-poc.md`: a short "Credential broker" paragraph (address, env vars, spend log, the per-model baseUrl limitation); the full "Credentials" rewrite waits for SUB-02/04.

Tests (vitest, run single files; no Playwright, no full suite on this machine):

- `apps/server/test/credentialBroker.test.ts` against a local echo upstream: bearer, `x-api-key`, query and `chatgpt-account-id` placeholders swapped (the echo reports PLACEHOLDER/real, never values); the JWT-shaped placeholder decodes under `extractAccountId`'s algorithm; sponsor order (author's own, then a sharer, then 401); bad token gives 404; a 1 MB streamed body passes unchanged; a WebSocket upgrade is piped (use `ws` if already in the dependency tree, else a raw handshake); one spend-log line per request.
- `apps/server/test/sessionAgentDir.test.ts` (or inside `userAgentDirs.test.ts`): generated `models.json` (every provider rewritten to the broker URL and the placeholder, per-model baseUrl dropped), `auth.json` is `{}`, shared links present, `except` honoured; the env strip of provider keys. Symlink tests fail with EPERM on Windows (known); keep them, they run on the VM.
- `packages/domain` sandbox policy test: the broker literal appears in `allowedDomains` when given.
- `profileMatrix.test.ts`: `capabilities.broker` true on shared-server, absent on desktop.

Out of scope here: the web picker (SUB-04), share routes (SUB-02), Claude Code in the image and per-user sign-in (SUB-05), Environment secrets (CRB-04), removing provider hosts from the allow-list (CRB-03).

### Validation after merge (architect, on the VM)

Deploy; from the owner's browser one Codex turn on `openai-codex:gpt-6-luna` in CrunchyMurmur; expect `[broker] openai-codex ... 200` lines in the server log, the session's `models.json` carrying only `ph.` values, `credential-spend.jsonl` naming sponsor = author = the owner, and no real token anywhere under `<dataDir>/sandbox`.
