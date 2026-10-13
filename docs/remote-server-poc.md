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
