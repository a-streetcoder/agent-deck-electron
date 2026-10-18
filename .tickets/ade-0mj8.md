---
id: ade-0mj8
status: closed
deps: [ade-w2zc, ade-nobk]
links: []
created: 2026-10-17T22:05:04Z
type: task
priority: 2
assignee: almoretti
parent: ade-u3ld
---
# CRB-03: sandbox policy for the broker (allow only the broker; provider hosts removed for brokered sessions)

ADR 0007 amendment: a session's policy allows exactly its broker address and port (deniedResolvedAddresses carve-out, allowedDomains entry); provider hosts leave the default allow-list for brokered sessions; the stack matrix gains a brokered turn; Doctor's sandbox check reports the broker.


## From CRB-01 (ade-w2zc)

- srt's resolved-address guard denies a name that resolves to the container's own address unless `<ip>:<port>` is in `allowedDomains`; that literal is the carve-out, not `deniedResolvedAddresses`. The product policy therefore adds the broker as `<container ip>:<port>` (and the hostname if the session is given one). srt treats an IP literal on the allow list as an explicit choice and never re-judges it.
- Inside srt the sandboxed process must proxy every host (`NO_PROXY=`, curl `--noproxy ''`, `NODE_USE_ENV_PROXY=1` for Node clients); a direct dial to the container address is `ENETUNREACH`. The env the sandbox sets for Pi's tool commands must clear `NO_PROXY`.
- Regression test: srt drops single quotes in a wrapped one-liner; the spawn path must hand srt a script or argv, never a quoted command string.

## From CRB-02 (2026-10-18)

- One-shot helpers (`runHelper`: commit messages, skill summaries) have no session record and still launch with the requester's own agent dir and real `auth.json`; they rely on the provider hosts staying in the allow-list. Before removing those hosts, give helpers a broker route (a registered helper id whose sponsor is the requester) and switch `runHelper` to the broker's launch env.
- Pi extension-registered providers inside a session are not brokered (they define their own base URL); decide whether brokered sessions may load such extensions.

## Design (architect, 2026-10-18) — read before implementing

Goal: on the shared server a brokered session has no path to a provider except through the broker. Today `DEFAULT_SANDBOX_DOMAINS` (packages/domain/src/sandboxPolicy.ts) still allows the provider hosts, so a leaked key could be used directly; and one-shot helpers still launch with the requester's real auth.json. CRB-02 (merged `d7dcab8`, `e9fe16a`, `6d7497f`) is the base; read its design and review notes on ade-nobk and `apps/server/src/credentialBroker.ts` first.

1. **Helpers through the broker** (`SessionManager.runHelper`, `apps/server/src/SessionManager.ts` ~2312; callers in routes/git.ts and routes/resources.ts). When `credentialBroker` is injected, build the helper's env from the broker instead of `userAgentDirEnv(requester, …)`: give the broker a `registerTransient(meta)` / `forget(id)` pair where `meta` is `{ id: "helper-<uuid>", cwd, createdAt, location: { kind: "server", owner: requester } }` (whatever `SessionMeta` minimally needs; `isSessionSegment` must accept the helper id, check `sandbox.ts`), kept in an in-memory map the `session` lookup consults before the index; then `launchEnv(meta, sandboxed)`. The helper's sponsor is the requester (`latestAuthor` is undefined for it, so `sessionOwner(meta)` applies). `forget(id)` after the run (the existing `spawnHooks.forget(id)` call site) also drops the transient and its token. A helper without a requester (no user on the connection) keeps today's path. Test: a helper's env carries `PI_CODING_AGENT_DIR` under `<dataDir>/sandbox/helper-…` and the broker answers its request with the requester as sponsor; after the run the token is gone (404).
2. **Provider hosts leave the allow-list of brokered launches.** Split `DEFAULT_SANDBOX_DOMAINS` into the infrastructure hosts Pi and tools need (`pi.dev`, package registries, github.com and whatever else is in the list that is not a model provider) and `PROVIDER_SANDBOX_DOMAINS` (api.anthropic.com, api.openai.com, chatgpt.com, generativelanguage.googleapis.com, openrouter.ai, api.x.ai, api.groq.com, api.mistral.ai, api.deepseek.com, … every host in the list that serves a Pi provider). In `sandboxPolicy()`, when `input.broker` is set, the provider hosts are not added (project `allowedDomains` and owner grants still apply unchanged: they are the owner's explicit intent). Keep the exported `DEFAULT_SANDBOX_DOMAINS` as the union so nothing else changes. Tests in `packages/domain/test/sandboxPolicy.test.ts`: brokered policy has the broker literal and no provider host; non-brokered unchanged; a project-allowed provider host survives.
3. **Stack matrix row.** `apps/server/src/cli/sandboxRun.ts`, `scripts/stack-matrix.mjs`, `docs/stack-matrix.md` (SBX-06): add a "brokered turn" row that, inside a session's sandbox on the VM, (a) gets a connection refusal for `https://api.openai.com/` and `https://api.anthropic.com/`, (b) reaches the broker address with a bad token and gets 404 (proves the allow literal), (c) the owner's real turn stays the browser check. Read docs/stack-matrix.md for how rows run and report; if a row needs the broker address, `capabilities` or the server log line `[broker] listening on` gives it. Do not run the matrix yourself on the VM; the architect does.
4. **Doctor.** `serverChecks()` in `apps/server/src/routes/settings.ts`: the `server-sandbox` check (or a new `server-broker` check) reports the broker address and whether it is listening, on the shared server only; the web Doctor screen shows it like the other server checks (find how `server-*` checks are rendered; no new UI beyond the row).
5. **ADR 0007 amendment 21** (docs/adr/0007-per-session-process-sandbox.md, append after amendment 20): brokered launches allow the broker's `<ip>:<port>` literal and none of the provider hosts; helpers are brokered; the owner's dir, the operator's auth files, the shared models.json and the Claude credential file are read-denied (CRB-02); the Environment secrets path is CRB-04. Keep it to one paragraph in the existing amendment style. Runbook `docs/remote-server-poc.md`: one sentence in the broker paragraph.
6. Confirm on the ticket (architect runs the VM part): the second Codex turn shows the `426` line then SSE 200s.

Out of scope: SUB-02's preconditions (path allow-list, idle refusal, compact/rerun sponsor), Pi extension-registered providers, CRB-04.

Constraints as for CRB-02: no git tree-changing commands, no commit, single vitest files only, no builds, no secrets in code, tests or the report; symlink tests may skip on Windows. Report files changed, tests run with verbatim counts, deviations, open questions.

## Review (2026-10-18): GPT code-reviewer, one round

One should-fix, applied by the developer at the root rather than where the review pointed: srt sets its own `NO_PROXY` (private ranges included) through bubblewrap `--setenv`, which overrode the empty value from the launch env for every wrapped process, Pi included (Node's env-proxy support ignores CIDR entries, which is why Pi still reached the broker; curl honours them). The policy now carries `noProxy` (`localhost,127.0.0.1,::1` for brokered launches: a local dev server keeps working, every private address goes through srt's proxy) and pi-host puts it in front of the wrapped command next to `TMPDIR`, so Pi, tool commands, the Claude bridge, helpers, terminals and `sandbox-run` all get it; the matrix `broker-404` step no longer needs `--noproxy ''`. Developer deviation accepted: provider hosts moved from srt's global allow-list to each wrap's per-command list (a global entry would reach brokered sessions too); `DEFAULT_SANDBOX_DOMAINS` stays the union for non-brokered policies. Tests: domain sandboxPolicy 73, pi-host sandbox 39 and sandboxDomains 64, server credentialBroker 18 (+2 skipped), sandboxRun 19 (+1), profileMatrix 10, sessionManager helper cases 6; typecheck clean for domain, pi-host, server. VM checks pending: the matrix `brokered-turn` row and a second Codex turn (426 then SSE).

## VM (2026-10-18, deployed as poc-8552ca8)

- Doctor: `server-broker` ok, "Listening on 172.18.0.2:4211: sessions reach their model providers only through it".
- A Codex turn in CrunchyMurmur: three `[broker] openai-codex POST 200` lines (model turn and Pi's own title generation; no separate helper path is involved in titles, autoTitle runs inside the session's Pi). No `426` line appears because the refused-upgrade path is not logged; whether pi-ai attempted a WebSocket first is therefore not visible. Low priority: log the 426 in `spent()` if the question matters.
- `credential-spend.jsonl` has no `helper-` lines yet: no commit-message or skill-summary helper ran during the check. Covered by the unit tests; a live check happens the first time someone uses Git > Describe changes on the shared server.
- Stack matrix `brokered-turn` row: `node scripts/stack-matrix.mjs --host dev --only brokered-turn` refused to start: "only 1 GB memory available on dev; need 2". The host's `dockerd` holds 3.9 GB RSS after the day's image builds (the server container itself is at 190 MB). Running the matrix (the full one is due after this policy change) needs a Docker daemon restart on the VM, which restarts the production stack: owner's call. Ticket stays open until the matrix has run.
- Load measurements taken the same evening on the broker build are in `docs/capacity-measurements.md`.

## Stack matrix (2026-10-18, after the owner approved a Docker daemon restart on the VM)

`node scripts/stack-matrix.mjs --host dev` on HEAD 8552ca8: all ten stacks pass (pnpm-monorepo, python-uv, rust-cargo, go, java-gradle, rails, compose-app, playwright, static-site, agent-deck-electron; baseline failures only), and the new `brokered-turn` row passes: setup 0.6 s, providers-refused 0.4 s (two sandbox refusals, api.openai.com and api.anthropic.com), broker-404 0.4 s (the stand-in on the container address answered through srt's proxy without `--noproxy`, so the policy's `NO_PROXY` in front of the wrapped command does win over srt's `--setenv`). Correction to the VM note above: autoTitle runs at the idle edge through the session's broker URL, not inside the turn (found while implementing SUB-02). Closed.
