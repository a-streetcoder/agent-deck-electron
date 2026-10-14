# Remote server POC: one server, two people, Cloudflare Access identity

Status: proof of concept on branch `poc/shared-server`. Everything here is opt-in through
environment variables; with them unset the server, web UI and desktop shell behave exactly as
before (loopback only, no identity).

The Agent Deck **server** runs on a Linux VM. `cloudflared` on the same VM publishes it as
`https://deck.moretti.cc` behind **Cloudflare Access** with GitHub as the identity provider.
Ale and Andrea reach it from a browser or from the Electron shell; each request carries the
email Cloudflare verified, the server records who created each session and who sent each
prompt, and the UI shows it.

## Environment variables

Server (`apps/server`):

| Variable                            | Example                                        | Meaning                                                                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_DECK_TRUSTED_PROXY`          | `cloudflare`                                   | Turns the mode on. Every HTTP request and `/rpc` upgrade must then carry a valid Access assertion (except `GET /health` and the Pi tool bridge `/bridge`, which has its own per-session token). |
| `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN`  | `streetcoding-collective.cloudflareaccess.com` | Access team domain. Issuer is `https://<team-domain>`, JWKS is fetched from `https://<team-domain>/cdn-cgi/access/certs`.                                                                       |
| `AGENT_DECK_CF_ACCESS_AUD`          | `<application audience tag>`                   | The Access application's AUD tag (Zero Trust dashboard, application overview).                                                                                                                  |
| `AGENT_DECK_PUBLIC_ORIGIN`          | `https://deck.moretti.cc`                      | Browser origin accepted by the WebSocket origin guard in addition to loopback.                                                                                                                  |
| `AGENT_DECK_PROJECT_ROOT`           | `/home/deck`                                   | Root that `GET /fs/dirs` may browse (default: the server user's home).                                                                                                                          |
| `AGENT_DECK_CF_ACCESS_JWKS_URL`     | _(unset)_                                      | Override of the JWKS URL. Tests and staging only.                                                                                                                                               |
| `AGENT_DECK_DESKTOP_RECOVERY_TOKEN` | _(any secret)_                                 | Pre-existing. Set the same value on the VM and in the desktop launcher so the shell's "reveal" calls are accepted.                                                                              |

Desktop (`apps/desktop/main.js`):

| Variable                            | Example                                        | Meaning                                                                                                        |
| ----------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `AGENT_DECK_REMOTE_SERVER_URL`      | `https://deck.moretti.cc`                      | Attach to this origin: spawn no server, load the renderer from it, treat it as the control plane.              |
| `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN`  | `streetcoding-collective.cloudflareaccess.com` | Optional. Pins the in-window login round-trip to this team's Access pages (else any `*.cloudflareaccess.com`). |
| `AGENT_DECK_DESKTOP_RECOVERY_TOKEN` | _(same as the VM)_                             | Optional. Honored instead of a random per-launch token.                                                        |

`AGENT_DECK_SERVER_URL` (loopback attach, used by `pnpm dev` and the SSH-tunnel launcher) is
unchanged and mutually exclusive with `AGENT_DECK_REMOTE_SERVER_URL`.

## Server surface

- `GET /me` returns `{ "user": { "id", "email", "name"? } }`, or `{ "user": null }` when the
  proxy mode is off. The web UI calls it at bootstrap for "Signed in as".
- `GET /fs/dirs?path=…` lists the subfolders of a server directory (`{ root, path, parent, dirs }`),
  confined to `AGENT_DECK_PROJECT_ROOT`, directories only, hidden folders skipped, symlinks never
  followed out of the root. The project picker uses it so nobody has to type absolute Linux paths.
- Requests without a valid assertion get `401 { code: "unauthenticated" }`. The assertion is
  read from the `cf-access-jwt-assertion` header cloudflared injects, falling back to the
  `CF_Authorization` cookie.
- Verification (`apps/server/src/trustedProxy.ts`, `node:crypto`, no new dependency): RS256
  signature against the cached JWKS (refreshed on an unknown `kid`, at most every 30 s),
  `iss`, `aud` (string or array), `exp`, `iat`/`nbf` with 60 s skew, and a non-empty `email`.
- Identity on data (all optional fields, old data still decodes):
  - `SessionMeta.createdBy: { id, name? }` stamped by `POST /sessions` (drafts and immediate
    launches), persisted in `sessions.json`.
  - `UserCell.author: { id, name? }` on user messages. The RPC handler stages the connection's
    user on every `prompt` / `steer` / `follow_up`; the user-cell decorator binds it to the cell
    Pi echoes back (live, and again on history rebuild by stable entry id). Stored in
    `session-authors.json` next to the session index, so snapshots and replay carry it.

## VM setup (Linux, shared OS user)

Checkout and dependencies as in the development guide (`pnpm install`, `pnpm build:native`,
`pnpm build:web` so the server serves the UI). Then two **user** services.

`~/.config/systemd/user/agent-deck-server.service`:

```ini
[Unit]
Description=Agent Deck server (shared, behind Cloudflare Access)
After=network-online.target

[Service]
WorkingDirectory=%h/AI Playground/a-streetcoding/agent-deck-electron
Environment=PORT=4200
Environment=AGENT_DECK_TRUSTED_PROXY=cloudflare
Environment=AGENT_DECK_CF_ACCESS_TEAM_DOMAIN=streetcoding-collective.cloudflareaccess.com
Environment=AGENT_DECK_CF_ACCESS_AUD=<aud tag from the Access application>
Environment=AGENT_DECK_PUBLIC_ORIGIN=https://deck.moretti.cc
Environment=AGENT_DECK_DESKTOP_RECOVERY_TOKEN=<shared secret>
ExecStart=/usr/bin/env pnpm --filter @agent-deck/server dev
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

`~/.cloudflared/config.yml` (tunnel created with `cloudflared tunnel create agent-deck` and
routed with `cloudflared tunnel route dns agent-deck deck.moretti.cc`):

```yaml
tunnel: <tunnel id>
credentials-file: /home/<user>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: deck.moretti.cc
    service: http://127.0.0.1:4200
  - service: http_status:404
```

`~/.config/systemd/user/cloudflared.service`:

```ini
[Unit]
Description=cloudflared tunnel for Agent Deck
After=network-online.target

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel run agent-deck
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
loginctl enable-linger "$USER"          # services survive logout
systemctl --user daemon-reload
systemctl --user enable --now agent-deck-server cloudflared
systemctl --user status agent-deck-server cloudflared
journalctl --user -u agent-deck-server -f
```

Cloudflare Zero Trust: add GitHub as a login method; create a self-hosted application for
`deck.moretti.cc` with a policy allowing the two emails; copy its **Application Audience (AUD)
tag** into `AGENT_DECK_CF_ACCESS_AUD`. Session duration is the Access setting (the Electron
shell keeps the cookie in its persistent session).

Check from the VM (bypasses cloudflared, so expect 401 without an assertion):

```sh
curl -s http://127.0.0.1:4200/health          # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4200/me   # 401
```

and from a signed-in browser: `https://deck.moretti.cc/me` shows your identity.

## Clients

- **Browser**: open `https://deck.moretti.cc`, sign in with GitHub. The served web build works
  as is; the sidebar shows "Signed in as", session rows show the creator's initials, user
  messages show their author.
- **Desktop (Windows)**: double-click `win\Agent Deck Remote (cloudflare).cmd`. It sets
  `AGENT_DECK_REMOTE_SERVER_URL=https://deck.moretti.cc` and starts Electron from
  `apps/desktop`; extra arguments (for example `--remote-debugging-port=9222`) pass through to
  Electron. Startup order in remote mode: the window opens on the remote origin at once (no
  pre-window health wait, since Access answers a login redirect, never 200, before a cookie
  exists); the first launch shows the Access login inside the window (allowed navigation: the
  app origin, the team's `cloudflareaccess.com` pages, `github.com`); once the main frame has
  loaded a page on the app origin the shell runs the session-aware `/health` check and the
  badge refresh, and only a failure at that point shows the "failed to start" dialog. Every
  other link still opens in the system browser. To enable "Reveal …" actions that need the
  recovery token, set `AGENT_DECK_DESKTOP_RECOVERY_TOKEN` in the launcher to the VM's value.
  **Folders are chosen on the server**: the preload reports `remote: true`, so the native
  folder/file pickers are disabled (they would pick paths on your PC) and "Add project" opens
  the in-popover server folder browser (`/fs/dirs`) plus the type-a-path input, exactly like a
  browser. The same server folder browser is reachable from every add-project entry: the
  toolbar project picker, the Projects screen's "Add Projects…" dialog, and the "Add project…"
  button next to the new-session Project dropdown (which also selects the new project for the
  draft). Skill-folder and prompt-file imports fall back to their typed-path inputs likewise.
- **Desktop over SSH** (`win\Agent Deck Remote (dev VM).cmd`) still works, but through the
  tunnel the server sees loopback requests with no assertion, so with the proxy mode on it
  answers 401. Use one mode or the other on the VM.

## Operations

Verified on the live VM (`ssh dev`, user `ale`) on 2026-10-14. The live layout differs from the
generic setup above in two places: the checkout is `~/ai-playground/a-streetcoding/agent-deck-electron`
(the Syncthing replica of the PC checkout), and the tunnel unit is `cloudflared-agent-deck`.

### Daily use

- **Browser**: `https://deck.moretti.cc`, Cloudflare Access with GitHub login, 7-day session.
  `/me` shows your identity.
- **Desktop**: `win\Agent Deck Remote (cloudflare).cmd` (Electron with
  `AGENT_DECK_REMOTE_SERVER_URL=https://deck.moretti.cc` and `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN`;
  extra arguments pass through, for example `--remote-debugging-port=9222`). The first run shows
  the Access/GitHub login inside the window. GitHub passkey 2FA returns 404 there; use an
  authenticator app or SMS until the system-browser login lands (ticket ade-1vjx).
- In remote mode the UI is the same, plus "Signed in as <github email>" under the logo, an
  initials chip on session rows, an author label above user messages, and folder pickers that
  browse the VM (no native dialogs).
- **Projects** live on the VM in `/srv/streetcoding` as server-owned git clones (today
  CrunchyMurmur and agent-deck-electron). To register one, clone it there
  (`ssh dev`, `cd /srv/streetcoding && git clone <url>`), then Projects → Add Projects… and either
  use the folder browser (rooted at `AGENT_DECK_PROJECT_ROOT=/srv/streetcoding`) or Monitored
  folders (`/srv/streetcoding` → Add folder → add each discovered repo). Registration is server
  state (`projects.json`). Private repos and pushes need `gh auth login` on the VM, which is not
  done yet; a bot account would be cleaner than a personal login.

### Dev loop and deploy

Syncthing mirrors saves from the PC checkout to the VM checkout in about 5–15 s; `.git` metadata
lags by minutes, so never run git on the VM copy. `node_modules` are not synced.

The service runs `pnpm --filter @agent-deck/server dev`, which is tsx **without** watch:

- Changes in `apps/server`, `packages/contracts`, `packages/domain` or `packages/pi-host` need
  `systemctl --user restart agent-deck-server`.
- Web changes need `pnpm build:web` on the VM (the server serves `apps/web/dist`); no restart,
  hard-reload the browser.
- Desktop changes are PC-side only.

Deploy one-liner from the PC:

```sh
ssh dev 'cd ~/ai-playground/a-streetcoding/agent-deck-electron && pnpm build:web && export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user restart agent-deck-server && sleep 8 && curl -s 127.0.0.1:4200/health'
```

The Syncthing ignore file (`E:\AI Playground\.stignore`, kept identical on PC and VM, not synced
itself) excludes `packages/loop-catalog-native/native/` and, since 2026-10-14, the
agent-deck-electron `dist/`, `release/`, `build/pi-runtime`, `build/skill-engine-native` and
`apps/web/dist`, so PC builds no longer overwrite what the VM serves.

Must not:

- Switch branches, `git checkout` or `git stash` in the PC checkout while the VM depends on the
  tree.
- Expect `packages/loop-catalog-native/native/` to sync: each OS builds its own and the PC
  prebuild wipes it.
- Change `pnpm-lock.yaml` without re-running `pnpm install --frozen-lockfile` on the VM with
  `GITHUB_TOKEN=$(gh auth token)` exported.
- Commit `.sync-conflict-*` files.
- Run `pnpm install` or builds on the VM while a session is executing.

### Observability

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
journalctl --user -u agent-deck-server -f
journalctl --user -u cloudflared-agent-deck -f   # four "Registered tunnel connection" lines = healthy
curl -s 127.0.0.1:4200/health                    # {"ok":true}
curl -s 127.0.0.1:4200/me                        # 401 "missing Cloudflare Access assertion" is correct locally
```

From a signed-in browser `/me` returns `{"user":{...}}`; without the cookie it is a 302 to the
Access login.

Data directory on the VM, `~/.local/share/agent-deck-electron/`: `sessions.json`,
`session-authors.json` (owner and per-turn author records keyed by session id), `projects.json`,
`session-worktrees/`, `checkpoints/`, `plan-events/`, `composer-drafts/`, `Subagent Runs/`,
`loop-artifacts/`. Pi transcripts are in `~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl`.
A session's owner is in `session-authors.json` under its id, `turns[].author.id` (the email), or
on the initials chip.

### Access and identity

- **Add a user**: Cloudflare Zero Trust → Access → Applications → "Agent Deck · Streetcoding
  Collective" → policy "Streetcoding Collective" → Include → the person's GitHub-account email.
  GitHub is the only identity provider. Any Access-authenticated email becomes a user; there is
  no server-side allowlist yet.
- **JWT path**: cloudflared injects `cf-access-jwt-assertion` (the server also accepts the
  `CF_Authorization` cookie); `apps/server/src/trustedProxy.ts` verifies RS256 against
  `https://streetcoding-collective.cloudflareaccess.com/cdn-cgi/access/certs`, checks `iss`,
  `aud` (`AGENT_DECK_CF_ACCESS_AUD`), `exp` and `iat`, requires a loopback `remoteAddress` and
  extracts the email. `/health` and `/bridge` are exempt.
- **Failure signatures**: tunnel down → Cloudflare 530/502 (the server is unaffected); Access
  misconfigured → 403 from Cloudflare; server down → 502.
- **Local test with a real identity**: copy the `CF_Authorization` cookie value from a signed-in
  browser, then on the VM `curl -H "cf-access-jwt-assertion: <value>" 127.0.0.1:4200/me` → 200.

### Desktop login

Spike ade-1vjx, **decision 2026-10-14: candidate 1 (cloudflared non-browser flow) works**. Goal:
sign in through the system browser (passkeys work there) and never render a GitHub page inside
Electron.

- **Mechanism**: `cloudflared access login https://deck.moretti.cc` opens the system browser,
  completes the Access/GitHub login there and caches a per-user, per-application token in
  `%USERPROFILE%\.cloudflared` (`deck.moretti.cc-<aud>-token`, plus an org token).
  `cloudflared access token -app=https://deck.moretti.cc` prints it without a browser while it
  is valid. The edge accepts it in a `cf-access-token` request header and forwards the usual
  `cf-access-jwt-assertion` to the server, so `trustedProxy.ts` needed no change.
- **Proof (Windows PC, cloudflared 2025.8.1)**: login completed in the already signed-in system
  browser with no prompt; `GET /me` with the header → 200 and the user JSON; `GET /health` → 200;
  WebSocket upgrade to `/rpc` with the header → 101; without the header `/me` → 302 to Access.
  The recovery routes also pass through: `trash-path` → 403 without
  `x-agent-deck-desktop-recovery-token`, a store answer with it.
  Electron: a shell started with `AGENT_DECK_CLOUDFLARED` set and a fresh `--user-data-dir`
  (no Access cookie) opened straight on `https://deck.moretti.cc/` showing "Signed in as" the
  GitHub user, with no Access or GitHub page or frame in the window.
- **Token lifetime**: `exp - iat` = 168 h (the Access session length), `type: app`, `aud` =
  the application AUD the server verifies.
- **Code (opt-in)**: with `AGENT_DECK_CLOUDFLARED` set to the cloudflared path, remote-mode
  `bootstrap()` in `apps/desktop/main.js` runs `access token` (and `access login` only when no
  valid token is cached, `cloudflaredAccessToken` in `remote-server.js`), then adds
  `cf-access-token` to every `https://` and `wss://` request to the remote host via
  `session.defaultSession.webRequest.onBeforeSendHeaders`. That covers renderer fetches, the
  `/rpc` WebSocket upgrade and `controlPlaneFetch`. Unset keeps the in-window login. The
  launcher `win\Agent Deck Remote (cloudflare).cmd` has the line ready to uncomment.
- **Renewal**: the token is read once per launch. An expired token fails `access token`, so the
  next launch runs `access login` again (system browser). Mid-run expiry is not handled: Access
  would redirect the window to its login. Restart the app. No exchange endpoint is needed, so
  the server-minted token design in
  [handover-shared-server-poc.md](handover-shared-server-poc.md) stays shelved.
- **Not covered**: candidate 2 (`agentdeck://` callback plus cookie copy) was not tried.

### Recovery

- **Bad deploy**: fix or `git revert` on the PC checkout (never `git reset --hard` while synced),
  wait for the sync, then `pnpm build:web` and restart.
- Stray `*.sync-conflict-*` files mean both sides edited a file.
- **Restart order**: `agent-deck-server` first, then `cloudflared-agent-deck` only if its log
  shows no registered connections. `loginctl enable-linger ale` is set.
- The server runs as `ale` with the full filesystem and `ale`'s Pi/Claude logins; attribution is
  a label, not isolation.
- Killing the service mid-session leaves Pi children to `KillMode=control-group` cleanup.
- The VM has about 8 GB RAM shared with Syncthing and another sandbox user: no parallel loops
  with many children.
- Nothing on the branch is pushed; the VM tree is the only other copy.

### Live systemd units

`~/.config/systemd/user/agent-deck-server.service`: `WorkingDirectory` the synced checkout,
`PORT=4200`, `ExecStart` `pnpm --filter @agent-deck/server dev`, `Restart=on-failure`,
`KillMode=control-group`. The drop-in `agent-deck-server.service.d/remote.conf` sets
`AGENT_DECK_TRUSTED_PROXY=cloudflare`, `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN`,
`AGENT_DECK_CF_ACCESS_AUD`, `AGENT_DECK_PUBLIC_ORIGIN=https://deck.moretti.cc` and
`AGENT_DECK_PROJECT_ROOT=/srv/streetcoding` (and, once ticket ade-gloc is done,
`AGENT_DECK_DESKTOP_RECOVERY_TOKEN`). The tunnel runs as `cloudflared-agent-deck.service`.

## Origins

- WebSocket (`apps/server/src/wsHandler.ts`): the guard used to accept only loopback origins
  whose host equals the request's `Host`; it now also accepts `AGENT_DECK_PUBLIC_ORIGIN`
  verbatim, so `Origin: https://deck.moretti.cc` is admitted (and tested) regardless of the
  Host cloudflared forwards. Non-browser clients without an Origin are still admitted and then
  authenticated by the assertion.
- REST: the only origin check is the browser-CSRF guard on the two terminal-launching POSTs
  (`apps/server/src/routes/settings.ts`); it compares the Origin host with `Host`, which
  matches through cloudflared, and now also accepts the public origin explicitly. No other
  REST route checks Origin (see Known gaps).

## Security model

- **Trust is loopback-only.** The server believes `cf-access-jwt-assertion` only when the TCP
  peer is `127.0.0.1`/`::1`, that is, cloudflared on the same VM. A request from any other
  address, or without a verifiable assertion, is refused. Nothing listens on a non-loopback
  interface; the only way in is the tunnel, and the tunnel only forwards what Access admitted.
- **The assertion is verified, not trusted.** Signature against the team JWKS, issuer, audience,
  expiry. A forged header on a loopback request fails verification.
- **Authentication, not authorization.** Both users see and can act on every session, project
  and resource. `createdBy`/`author` are labels for attribution and display; they gate nothing.
- **Shared OS user executes agents.** Every Pi process, worktree, shell and file write on the
  VM runs as the service's Unix user with that user's keys and tokens. Attribution is a label,
  not isolation: either person can act in the other's session, and the audit trail is the
  label plus Access logs.
- **Desktop shell.** With `AGENT_DECK_REMOTE_SERVER_URL` set, the https origin is the
  privileged control plane: IPC handlers accept only frames from that origin (or the Vite dev
  origin), the in-app browser and preview guests may never navigate to it, and the shell's own
  control-plane calls go through Electron's session so the Access cookie, not a header, is the
  credential.

### Known gaps (POC)

- The REST surface still has no Origin/CSRF guard (roadmap Track 1 #3). Access and the
  Electron navigation guards stand in front of it, but a signed-in browser tab remains
  cross-site-requestable from other sites; mirror the WebSocket guard onto mutating REST
  routes before widening the audience.
- `session-authors.json` is one file rewritten per message and never pruned on session
  deletion; fine for two people, not for a fleet.
- No per-user authorization, quotas or private sessions; no identity in Loops or subagent
  runs beyond the parent session's `createdBy`.
