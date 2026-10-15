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

| Variable                            | Example                                        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_DECK_TRUSTED_PROXY`          | `cloudflare`                                   | Turns the mode on. Every HTTP request and `/rpc` upgrade must then carry a valid Access assertion (except `GET /health` and the Pi tool bridge `/bridge`, which has its own per-session token).                                                                                                                                                                                                                                                                                                |
| `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN`  | `streetcoding-collective.cloudflareaccess.com` | Access team domain. Issuer is `https://<team-domain>`, JWKS is fetched from `https://<team-domain>/cdn-cgi/access/certs`.                                                                                                                                                                                                                                                                                                                                                                      |
| `AGENT_DECK_CF_ACCESS_AUD`          | `<application audience tag>`                   | The Access application's AUD tag (Zero Trust dashboard, application overview).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `AGENT_DECK_PUBLIC_ORIGIN`          | `https://deck.moretti.cc`                      | Browser origin accepted by the WebSocket origin guard in addition to loopback.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `AGENT_DECK_PROJECT_ROOT`           | `/home/deck`                                   | Root that `GET /fs/dirs` may browse (default: the server user's home).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `AGENT_DECK_HOST`                   | `0.0.0.0`                                      | Bind address (default `127.0.0.1`). Only loopback values (`::1` and `localhost` bind as `127.0.0.1`) or the wildcards `0.0.0.0` / `::` (dual-stack in Node) since the Pi tool bridge always calls `127.0.0.1`; a wildcard refuses to start unless `AGENT_DECK_TRUSTED_PROXY=cloudflare` or `AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST=1` (local smoke tests only). A non-empty `AGENT_DECK_TRUSTED_PROXY` other than exactly `cloudflare` refuses to start (a typo would turn authentication off). |
| `AGENT_DECK_CF_ACCESS_JWKS_URL`     | _(unset)_                                      | Override of the JWKS URL. Tests and staging only.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `AGENT_DECK_DESKTOP_RECOVERY_TOKEN` | _(any secret)_                                 | Pre-existing. Set the same value on the VM and in the desktop launcher so the shell's "reveal" calls are accepted.                                                                                                                                                                                                                                                                                                                                                                             |
| `AGENT_DECK_OPERATOR_EMAIL`         | `operator@example.com`                         | The Access email whose sessions keep using the shared `~/.pi/agent` (see [Credentials](#credentials)). Unset: every user, the operator included, gets an own agent dir.                                                                                                                                                                                                                                                                                                                        |
| `AGENT_DECK_GITHUB_CLIENT_ID`       | `Ov23li...`                                    | GitHub OAuth App client id for per-user GitHub connections (see [GitHub](#github-connection)). Unset: connecting answers 409 "GitHub app not configured".                                                                                                                                                                                                                                                                                                                                      |

Desktop (`apps/desktop/main.js`):

| Variable                            | Example                                        | Meaning                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_DECK_REMOTE_SERVER_URL`      | `https://deck.moretti.cc`                      | Attach to this origin: spawn no server, load the renderer from it, treat it as the control plane.                                                                                                                           |
| `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN`  | `streetcoding-collective.cloudflareaccess.com` | Optional. Pins the in-window login round-trip to this team's Access pages (else any `*.cloudflareaccess.com`), and the team a team server sign-in may use without a check against it (see [Desktop login](#desktop-login)). |
| `AGENT_DECK_DESKTOP_RECOVERY_TOKEN` | _(same as the VM)_                             | Optional. Honored instead of a random per-launch token.                                                                                                                                                                     |
| `AGENT_DECK_SHARED_SERVER_URL`      | `https://deck.moretti.cc`                      | Dev override of **Settings > Team server** (local mode). Set, it wins over the stored setting and the screen says so.                                                                                                       |
| `AGENT_DECK_CLOUDFLARED`            | `C:\Tools\cloudflared.exe`                     | Dev override (wins over the saved one): the cloudflared used to sign in. When unset it is found or downloaded (see Desktop login below).                                                                                    |

`AGENT_DECK_SERVER_URL` (loopback attach, used by `pnpm dev` and the SSH-tunnel launcher) is
unchanged and mutually exclusive with `AGENT_DECK_REMOTE_SERVER_URL`.

## Server surface

- `GET /me` returns `{ "user": { "id", "email", "name"?, "providersConnected"? } }`, or `{ "user": null }` when the
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
- Git identity follows the session **owner** (`apps/server/src/gitIdentity.ts`): every Pi
  launch of a session with `createdBy` (create, resume, fork, refresh) gets
  `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL`, fixed at spawn so a later prompt
  author cannot change them. The two commits the app composes, the worktree auto-commit and the
  worktree merge commit (`POST /sessions/:id/merge`), use the same identity and add a
  `Co-authored-by:` trailer for each other prompt author of the session. Checkpoint refs,
  terminals and project-level commits from the Git panel are unchanged. A session without
  `createdBy` (no trusted proxy) keeps the machine's git config.

## Install on a server

The shared server is the published image ([Container image](#container-image)) run by Docker
Compose from [`deploy/compose.yaml`](../deploy/compose.yaml) with a `cloudflared` sidecar. The
server binds `127.0.0.1` and trusts Access assertions only from a loopback peer, so `cloudflared`
shares the server container's network namespace (`network_mode: service:net` on both) and reaches
it on `127.0.0.1:4200`; the namespace belongs to a placeholder `net` service (the `pause` image), so
a server restart does not strand `cloudflared`. No port is published on the host: the only way in
is the tunnel.

### Prerequisites

Created once:

- A Linux x64 host with Docker Engine and the Compose plugin (`docker compose version`, 2.17 or
  later), and outbound access: https (443) to GHCR, Cloudflare, GitHub and the model providers, and
  port 7844 (UDP for QUIC, or TCP) to Cloudflare for the tunnel.
- A published release: the image exists on GHCR only after the first `v*` tag (a manual run of
  the workflow publishes `sha-<short>` only). The package is private by default: either make it
  public (GitHub, the package's settings), or run `docker login ghcr.io` on the host with a token
  that has `read:packages`.
- A Cloudflare tunnel created in the dashboard (Zero Trust > Networks > Tunnels > Create, type
  Cloudflared). Copy its token (the `--token` value of the install command) for `TUNNEL_TOKEN`, and
  add a public hostname (for example `deck.example.com`) with service `http://127.0.0.1:4200`.
  Use `127.0.0.1`, not `localhost`: the server does not listen on `::1`.
- GitHub as an Access login method (Zero Trust > Settings > Authentication), which needs its own
  GitHub OAuth App with callback URL `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
  and a client secret. Then an Access self-hosted application for the hostname with a policy listing
  the allowed emails. Note the team domain (`<team>.cloudflareaccess.com`) and the application's
  AUD tag.
- A second GitHub OAuth App, with device flow enabled, for per-user GitHub connections; note its
  client id (see [GitHub connection](#github-connection)).

### Install

1. Copy `deploy/compose.yaml` and `deploy/.env.example` into a folder on the host, for example
   `~/agent-deck/`, and rename the template to `.env` (`chmod 600 .env`: it holds secrets).
2. Fill `.env`. Every variable has a one-line comment there. `AGENT_DECK_TRUSTED_PROXY=cloudflare`
   and `PORT=4200` are fixed in `compose.yaml`, so authentication cannot be switched off from
   `.env`. `cpus` in `compose.yaml` must not exceed the host's CPU count (`nproc`).
3. Start it:

   ```sh
   docker compose pull
   docker compose up -d
   docker compose ps      # agent-deck "healthy", cloudflared "running"
   ```

4. One-off setup inside the container (it persists in the volume; the server creates
   `AGENT_DECK_PROJECT_ROOT` itself):

   ```sh
   docker compose exec agent-deck git config --global user.name "Agent Deck"
   docker compose exec agent-deck git config --global user.email "agent-deck@example.com"
   ```

   The git identity is for sessions without an owner; owned sessions commit as their owner. For
   `git@` remotes copy a key into `/data/home/.ssh` as the server user, so it is owned by
   `agentdeck` with mode 600 in a 700 folder (root in the container has no capabilities to fix
   ownership later):

   ```sh
   docker compose exec -T agent-deck sh -c 'umask 077 && mkdir -p ~/.ssh && cat > ~/.ssh/id_ed25519' < ./id_ed25519
   docker compose exec agent-deck sh -c 'ssh-keyscan github.com >> ~/.ssh/known_hosts'
   ```

   Or use https with each user's GitHub connection, or `docker compose exec agent-deck gh auth login`.

5. Open the public URL: Access asks for the GitHub login, then the UI loads; `/me` shows your
   identity. Each user signs in to model providers under Settings > Providers.

### Upgrade and rollback

Back up the volume first (below): a newer version may migrate the data in a way an older one does
not read.

To upgrade, set `AGENT_DECK_IMAGE_TAG` in `.env` to the new version, then:

```sh
docker compose pull && docker compose up -d
```

To roll back, set `AGENT_DECK_IMAGE_TAG` in `.env` to the previous version and run
`docker compose up -d` again (restore the backup if the newer version changed the data). Pin
`AGENT_DECK_IMAGE_TAG` rather than running `latest`, so you always know which version to go back
to. If `cloudflared` ever loses the server (Cloudflare 502 while `agent-deck` is healthy), recreate
the stack: `docker compose up -d --force-recreate`.

### Backup and restore

All state is in the named volume `agent-deck-data`, mounted at `/data`: the session index and
server state, session worktrees, per-user Pi agent dirs and GitHub tokens (`users/`), project clones
(`projects/`) and the home (`home/`: Pi transcripts, settings, skills, `gh` login, `.gitconfig`,
`.ssh`). See the volume table under [Container image](#container-image). Compose prefixes the
volume with the project name, fixed to `agent-deck` in `compose.yaml`: the volume is
`agent-deck_agent-deck-data`.

```sh
docker compose stop
docker run --rm -v agent-deck_agent-deck-data:/data -v "$PWD":/backup debian:bookworm-slim \
  sh -c "umask 077 && tar czf /backup/agent-deck-data-$(date +%F).tgz -C /data ."
docker compose start
```

Restore into an empty `/data`, with the stack stopped, so no file of the current state is left
mixed with the backup:

```sh
docker compose down                          # removes the containers, keeps the volume
docker run --rm -v agent-deck_agent-deck-data:/data -v "$PWD":/backup debian:bookworm-slim \
  sh -c "find /data -mindepth 1 -delete && tar xzf /backup/agent-deck-data-<date>.tgz -C /data"
docker compose up -d
```

The archive holds every user's credentials: store it like a secret.

### Logs

```sh
docker compose logs -f agent-deck
docker compose logs -f cloudflared    # "Registered tunnel connection" lines = healthy
docker compose exec agent-deck node -e "fetch('http://127.0.0.1:4200/health').then(r=>r.text()).then(console.log)"
```

## Legacy: source checkout on the VM

How the VM ran before the container package; 17c (ade-siqi) retires it.

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
- **Desktop in local mode with a shared server** (SRV-12b, SRV-16a): open **Settings > Team
  server**, enter the server address (`https://deck.moretti.cc`) and Save. Only a bare https
  origin is accepted (no path, query, credentials or port 0; plain host name labels, an IPv4 or
  a bracketed IPv6 literal); an empty field clears it. The value is stored per machine in
  Electron userData (`team-server.json`, `{ serverUrl, cloudflaredPath? }`; `cloudflaredPath`
  is the cloudflared Settings downloaded, see [Desktop login](#desktop-login); keys the app
  does not know are kept on Save; a
  missing or corrupt file reads as not configured). The status line reads "Not configured" or
  the sign-in status (see [Desktop login](#desktop-login)), and the screen adds "Set by
  AGENT_DECK_SHARED_SERVER_URL (dev override)" when that variable is set: it is a dev override
  and wins over the setting. Saving a different
  address replaces main's shared-server client (its token and sign-in state start over; an
  empty address drops it, so no network call is made), flushes the composer drafts and reloads
  the window, which then works with the new server (SRV-16b; the preload asks main for the
  origin at every load). Save is refused while a session move or bring-back runs in this
  window, and no move or bring-back starts between a Save and its reload. If the draft flush
  fails or times out the window is not reloaded, and Make shared and the mirror refuse with
  "Restart Agent Deck" until it is. The status line and the sidebar footer ("Team server:
  signed in") show the sign-in, with **Sign in**, **Sign out** and **Remove cached token**
  next to it. Save is also refused while Make shared runs. Sign-in needs
  cloudflared, found or downloaded as in [Desktop login](#desktop-login). With a
  server set, the Projects screen offers **Make shared** on each local project (see
  [Make shared from the desktop](#make-shared-from-the-desktop)). Not configured, the app looks
  exactly like local Agent Deck (the setting is reached from Settings or the command palette).
  In remote mode none of it is shown, and main refuses every `team-server:*` call (that page
  comes from the server).
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
  CrunchyMurmur and agent-deck-electron). Add one from its GitHub repository (see
  [Shared projects from a repository](#shared-projects-from-a-repository)), or clone it there
  (`ssh dev`, `cd /srv/streetcoding && git clone <url>`), then Projects → Add Projects… and either
  use the folder browser (rooted at `AGENT_DECK_PROJECT_ROOT=/srv/streetcoding`) or Monitored
  folders (`/srv/streetcoding` → Add folder → add each discovered repo). Registration is server
  state (`projects.json`). Pushes and pull requests run as the session owner once they connect
  GitHub under Settings > Providers (see [GitHub connection](#github-connection)); otherwise
  they use whatever `gh auth login` or git credentials the VM has.

### Dev loop and deploy

A server installed from the image upgrades as in [Install on a server](#upgrade-and-rollback);
what follows is the legacy source-checkout loop.

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
itself) excludes the machine-local native folders `packages/loop-catalog-native/native/` and
`packages/skill-engine-native/native/` and, since 2026-10-14, the agent-deck-electron `dist/`,
`release/`, `build/pi-runtime` and `apps/web/dist`, so PC builds no longer overwrite what the VM
serves.

The skill engine addon (vendored Rust, ADR 0005) is built on the VM, not synced. After a change
under `packages/skill-engine-native`, or on first setup, build it before restarting the unit:

```sh
PATH=$HOME/.cargo/bin:$PATH pnpm --filter @agent-deck/skill-engine-native build
```

`PATH` is set because a non-interactive `ssh dev` shell does not load cargo's profile. Not the full
`pnpm build:native`: it also rebuilds `loop-catalog-native`, whose prebuild empties its `native/`
folder under the running service although that addon has not changed.

Must not:

- Switch branches, `git checkout` or `git stash` in the PC checkout while the VM depends on the
  tree.
- Expect `packages/loop-catalog-native/native/` or `packages/skill-engine-native/native/` to sync:
  each OS builds its own and the PC prebuild wipes them.
- Change `pnpm-lock.yaml` without re-running `pnpm install --frozen-lockfile` on the VM (no token
  needed any more).
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

`git-identities.json` (operator-maintained, optional, no UI) maps an Access email to the
identity its sessions commit with. It is read on every launch and app commit, so an edit applies
to the next one; a malformed file is logged and ignored.

```json
{ "user@example.com": { "name": "User Name", "email": "12345+user@users.noreply.github.com" } }
```

A user with no entry commits as their Access name (else the email's local part) with the Access
email, never as the VM's default identity. Add an entry for anyone whose Access email is a
private GitHub email: GitHub rejects pushes whose commits expose it.

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

The local desktop app signs in to the team server set in **Settings > Team server** (SRV-16a)
through cloudflared in the **system browser** (passkeys work there); no GitHub or Access page is
ever rendered inside Electron, and the Access token stays in Electron main.

- **Mechanism** (spike ade-1vjx, decided 2026-10-14): `cloudflared access login <origin>` opens
  the system browser, completes the Access/GitHub login there and caches a per-user,
  per-application token in `%USERPROFILE%\.cloudflared`. `cloudflared access token -app=<origin>`
  prints it without a browser while it is valid (168 h, the Access session length). The edge
  accepts it in a `cf-access-token` request header and forwards the usual
  `cf-access-jwt-assertion`, so `trustedProxy.ts` needed no change. Proven on Windows with
  cloudflared 2025.8.1: `/me` 200, `/rpc` upgrade 101, without the header 302 to Access.
- **Status** (`apps/desktop/team-server-status.js`): main keeps one status per configured
  server, `off` (no server), `needsSignIn`, `signingIn`, `signedIn` (with the `/me` user's name
  and email and the Access team, only when `/me` answers 200 with a user that has a string
  email or name), `unreachable` (no answer, or any status other than 200 and 403; a 200 of
  another shape reads "The server answered unexpectedly.") or `forbidden` (a 403: Access
  refused the account; the server's JSON `error` text is shown when it sent one). The `/me`
  check waits at most 10 s. It is pushed to the window as `team-server:status` and answered on
  demand; it is built from the `/me` user fields, the team name and the client's fixed error
  texts only, never the token. The Settings screen shows "Signed in as <name> (<team>)", the
  sidebar footer a dot and "Team server: <state>".
- **Silent startup**: with a server set, main asks `access token` for the cached token (no
  browser) and calls `GET /me`; the status follows the answer. No dialog ever blocks startup.
- **Recovery**: `signedIn`, `unreachable` and `forbidden` are checked again with `GET /me`
  when the Team server screen opens (`team-server:check`) and when the window gets focus (at
  most once per 60 s); `unreachable` and `forbidden` are also checked again as soon as any
  renderer request to the server answers 2xx. A 401 or login redirect on any request turns
  `signedIn` into `needsSignIn`. Answers from a client that was replaced (another address)
  change nothing.
- **Sign in** runs `access login` (one at a time; Cancel, `team-server:sign-in-cancel`,
  kills it), then `GET /me`. The same
  path serves the **Sign in to** buttons of Make shared, the move and the mirror. Sign in is
  disabled with "cloudflared is not available" until SRV-16c resolves a cloudflared.
- **Sign out** forgets the token in main and records the host as signed out in
  `team-server.json` (`signedOut`), so the next launch does not pick the cached cloudflared
  token up silently; a later Sign in clears it. When the cloudflared in use lists an
  `access logout` command it is run for the host (best effort). The pinned 2026.10.0 has none
  (its `access` commands are login, curl, token, tcp, ssh-config and ssh-gen), so the token file
  stays in `.cloudflared` until it expires or is removed.
- **Remove cached token** (`team-server:forget-token`, shown when signed in or refused) signs
  out as above and deletes cloudflared's cached application token for the configured host:
  only the files `~/.cloudflared/<host>-<aud>-token` (and their `.lock`), where `<aud>` is the
  hex AUD tag, so no other host's file and not the team's org token
  (`<team>-org-token`) is touched. The org token keeps the team's Access session, so the next
  `access login` may sign the same account in again without asking: to switch to a different
  GitHub account, also sign out of the team's Access page (`https://<team>/cdn-cgi/access/logout`)
  or of GitHub in the system browser.
- **Access team pinning** (phishing of the token). A typed-in address can be hostile:
  `https://evil.example` can redirect `access login` to the real team's Access page, the user
  signs in there as usual, and cloudflared stores the real team's token under the hostile host,
  which then receives it in `cf-access-token` and can replay it against the real server. The
  token such a host gets names the real team, so neither a per-host pin nor
  `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN` can tell it apart; the mitigation is that no token is sent
  to a host before its team is pinned, and a first sign-in is pinned without asking only when it
  is unambiguous. After every sign-in (and for a cached token) main reads the token's `iss`
  claim without verifying it (the edge and the server verify) and takes its host as the Access
  team. The token is held (not sent anywhere; status `needsSignIn` with a warning and
  **Confirm**, `team-server:accept-team`; Sign out discards it) when:
  - the host has no pinned team yet and `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN` is unset ("This
    server uses the <team> Access team. Continue only if that is your team.");
  - the host has no pinned team yet and another origin already pinned the same team, or the
    token's Access application audience (`aud`) is already pinned for another origin (the
    phishing case, also with the env variable set): "<other origin> signs in through this same
    Access team. A different address presenting it is very likely relaying your login. Continue
    only if you are sure.";
  - the team differs from the host's pinned team, or from `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN`
    when set.

  Confirm pins the team and the audience for the host (`teams` and `auds`, `{ [origin]: value }`,
  in `team-server.json`); the status line shows the team from then on. Only a host's first team
  that equals `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN` and is not pinned elsewhere is pinned without
  asking.

- **Renewal**: an expired token makes `/me` and every call answer "sign in required"; the
  status turns `needsSignIn` and a Sign in renews it. No exchange endpoint is needed, so the
  server-minted token design in [handover-shared-server-poc.md](handover-shared-server-poc.md)
  stays shelved.
- **Remote mode** (until SRV-16d removes it): with `AGENT_DECK_CLOUDFLARED` set, remote-mode
  `bootstrap()` reads the cached token once per launch and adds `cf-access-token` to every
  `https://` and `wss://` request to the remote host; without one the window opens on
  `apps/desktop/sign-in.html` and only its button runs `access login`. Mid-run expiry is not
  handled there: restart the app.
- **cloudflared** (SRV-16c, `apps/desktop/cloudflared-resolver.js`): main uses the first that
  exists of `AGENT_DECK_CLOUDFLARED` (dev override; it wins like `AGENT_DECK_SHARED_SERVER_URL`,
  and when it points at a missing file the next source is used and the screen says
  "AGENT_DECK_CLOUDFLARED points at a missing file"), the stored `cloudflaredPath` in
  `team-server.json`, `cloudflared` / `cloudflared.exe` on PATH (quoted Windows entries are
  unquoted), then the install folders (Windows: `%ProgramFiles(x86)%\cloudflared`,
  `%ProgramFiles%\cloudflared`, `%LOCALAPPDATA%\Microsoft\WinGet\Links`; macOS:
  `/opt/homebrew/bin`, `/usr/local/bin`; Linux: `/usr/local/bin`, `/usr/bin`). The shared-server client
  resolves it again on every call, so a cloudflared installed or downloaded while the app runs
  is used without a restart. Remote-attach mode uses only `AGENT_DECK_CLOUDFLARED` (unset keeps
  the in-window login). **Settings > Team server** shows the one in use (path, source,
  `cloudflared --version`); with none it offers **Download cloudflared**, which fetches the
  pinned release **2026.10.0** over https from
  `github.com/cloudflare/cloudflared/releases/download/<version>/<asset>` (Windows x64, macOS
  x64/arm64, Linux x64/arm64; other systems must install it). Redirects are followed by hand, at
  most 5, each hop https on `github.com`, `objects.githubusercontent.com` or
  `release-assets.githubusercontent.com`; the transfer is capped at 200 MB, the unpacked macOS
  archive at 300 MB, and the whole download at 10 minutes. The file goes to
  `<userData>/cloudflared/<version>/<asset>.part`; main checks the sha256 of the file on disk
  against the table in the module, and only then renames it to `cloudflared(.exe)`, makes it executable and records it as
  `cloudflaredPath`. The table holds the "SHA256 Checksums" from Cloudflare's release notes; for
  the macOS `.tgz` assets those are the checksums of the binary inside the archive, so the binary
  is extracted and verified. A mismatch or any error deletes the partial files and records
  nothing; nothing downloaded is run before it passes. Without any cloudflared, sign-in answers
  "cloudflared is not available. Download it in Settings > Team server." **Bumping the version**:
  change `CLOUDFLARED_VERSION` and every entry of `CLOUDFLARED_SHA256` together in one PR, copied
  from the new release's notes (for Windows and Linux they also match the GitHub asset digest);
  a missing or malformed checksum makes the download refuse to start. A bump does not replace a
  download already made: the stored `cloudflaredPath` still points at the old version's folder
  and wins over PATH. To fetch the new one, remove `cloudflaredPath` from `team-server.json` (or
  delete the old folder) and click Download again. Old `<userData>/cloudflared/<version>`
  folders are not cleaned up. Follow-up: treat a stored path outside the current version's
  folder as stale.

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
`AGENT_DECK_DESKTOP_RECOVERY_TOKEN`; once the GitHub OAuth App exists,
`AGENT_DECK_GITHUB_CLIENT_ID`). The tunnel runs as `cloudflared-agent-deck.service`.

## Origins

- WebSocket (`apps/server/src/wsHandler.ts`): the guard used to accept only loopback origins
  whose host equals the request's `Host`; it now also accepts `AGENT_DECK_PUBLIC_ORIGIN`
  verbatim, so `Origin: https://deck.moretti.cc` is admitted (and tested) regardless of the
  Host cloudflared forwards. Non-browser clients without an Origin are still admitted and then
  authenticated by the assertion.
- REST: every mutating route (POST, PUT, PATCH, DELETE) and the server folder listing
  `/fs/dirs` apply the WebSocket upgrade's origin rule in an `onRequest` hook
  (`apps/server/src/server.ts`): a browser Origin must be loopback or the public origin, and a
  request without an Origin (cloudflared, curl, the desktop main process) passes and is then
  authenticated by the Access assertion. Untrusted origins get 403 `untrusted_origin`.

## Credentials

Each signed-in user has their own Pi provider sign-ins (OAuth subscriptions and API keys),
stored in their own Pi agent dir (`apps/server/src/userAgentDirs.ts`, ticket ade-n41e):

- **Layout.** `<dataDir>/users/<first 16 hex of sha256(lowercased email)>/agent`, mode 0700,
  with a private `auth.json` (0600, created as `{}`). The path carries no identity; find a
  user's with `printf '%s' user@example.com | sha256sum | cut -c1-16`. Every other
  Pi file the user needs is a symlink to the shared `~/.pi/agent`, from a fixed list (revisit it
  on every Pi upgrade, PI-01): `settings.json`, `models.json`, `models-store.json`,
  `trust.json`, `mcp.json`, `keybindings.json`, `claude-bridge.json`, and the directories `bin`,
  `npm`, `git`, `sessions`, `extensions`, `skills`, `prompts`, `themes`, `agents`,
  `agent-library`, `loops`. Missing shared directories are created; a missing shared file stays
  a dangling link that Pi's own write creates. `oauth.json` is never linked, and `auth.json` is
  written before any link, because Pi copies `oauth.json` and `settings.json` API keys into a
  missing `auth.json`. Not linked: `.env` (Agent Deck layers the shared one at spawn anyway),
  `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`.
- **Sessions.** A session whose owner (`createdBy`) is set spawns Pi with
  `PI_CODING_AGENT_DIR=<owner dir>`; resumes, branches, Loop parents (owned by whoever
  started the Loop), subagents and helpers keep it. Prompting someone else's session spends the
  session OWNER's subscription.
- **Forks (SRV-15a).** A fork, plain (`POST /sessions/:id/fork`) or from a message
  (`/history/fork`), belongs to whoever asked for it: `createdBy` is the forker, so it runs on
  the forker's agent dir, git identity and GitHub connection. Inherited messages keep their
  original author label (`session-authors.json` is copied). The inherited model (from the plan,
  else the one in force at the forked message) must be in the forker's catalog, otherwise 409
  asking to pick a model; like a new session, a `--model` pattern or an extension provider
  (claude-bridge included) is left to Pi. Both fork paths get the PRV-01 claude-bridge swap. Loop sessions (a Loop parent or a
  Loop review session) cannot be forked (409). A fork of a session with a worktree shares that
  checkout and blocks its merge while the fork exists; the fork button says whose checkout it
  shares. MCP sign-ins do not carry over: they live in each user's own `mcp-auth.json`, so the
  forker signs in to the session's MCP servers themselves. Without an identity (desktop,
  loopback) a fork keeps the source owner, as before.
  Uncommitted edits a deleted fork leaves in the shared checkout are swept into the owner's
  merge auto-commit. The per-message Fork and Re-run buttons show on your own sessions only
  (they resume and replace the source runtime on its owner's credentials); another member's
  session offers the plain fork. This is the UI only: `/history/fork` and `/history/rerun`
  still accept any member (ADR 0003: attribution, not isolation). A plain fork records
  `forkedFrom` (source id, title and owner at fork time) and the persistence normaliser checks
  its shape like `createdBy`: the source owner and the fork-time title are not derivable on the
  client (the source may be renamed or deleted, and its `session.created` is usually outside
  the client's event window), so the session record keeps them. The session shows "Forked from
  Alice's session …" and the Activity row of its `session.created` says who forked whose
  session (SRV-15b).
- **Using shared sessions (SRV-15b).** Every session row has a status dot computed by the
  server: running (a live Pi run), needs input (an open human node: ask_user, a supervisor
  decision, an extension dialog, a loop approval), attention, failed, parked, idle. It comes
  from the live runtime and the meta, never from the event log alone (a turn left open by a
  restart reads idle). `GET /sessions` carries it as `activity`, and every `session_meta`
  push re-computes it; the turn-idle edge and each human node opening or closing re-push the
  row; REST replies that return a session (rename, pin, attention, draft) carry it too, and the
  client keeps the last pushed value when a reply has none. With sessions from two or more
  members, a row of avatar chips above the search box filters the list (projects stay the
  groups) and the Activity history: a row belongs to the member who acted, else to the owner of
  the session it happened in, so Bob's prompt in Alice's session is under Bob and the agent's
  replies under Alice. The "Waiting on a person" list is never filtered (a loop approval
  belongs to no member, and anyone may answer). Opening another member's session clears its
  "needs attention" for everyone: the marker is per session, not per person. Copy link (shared
  server only; a loopback origin is useless to a co-worker) copies `<origin>/?session=<id>`.
  Opening the link takes the parameter off the URL and opens that session instead of the boot
  resume of the newest session; an unknown or deleted id shows a notice and boots as usual.
- **Agents reading shared sessions (SRV-15c).** Every agent on the server has
  `list_sessions({project?, member?, since?, limit?})` and `read_session({sessionId, since?})`,
  whoever owns the session: visibility is the point, nothing is hidden. `member` is an owner's
  email (compared case-insensitively) or a display name only one owner has. `read_session` gives status, open questions, the
  latest plan, checkpoints and per turn who prompted it, its outcome, tool counts and the head of
  its final answer, plus the owner's Pi session file path and entry ids; the agent reads more of
  that file with its own read and grep tools, which works because every member's sessions run as
  the same Unix user. Reading a session changes nothing in it or in the log. Another session's
  text may carry web content: it reaches the model with token-like secrets redacted, quoted and
  labelled as data. Residual risk: quoting stops that text from breaking the result's structure,
  but its meaning still reaches an agent that has bash and spawn tools, so a planted instruction
  in a co-worker's session can still persuade it; ADR 0003 is attribution, not isolation, and the
  agent's actions stay attributed to whoever runs it. A session older than the event log, or a
  server with the log off, shows turns read from the Pi file, split at every user message (a steer
  or follow-up there reads as its own turn). Details in
  [orchestration-reference.md](orchestration-reference.md).
- **Providers screen.** `GET /runtime/providers`, sign-in and sign-out act on the requesting
  user's dir. A sign-in in progress belongs to whoever started it: polling, answering or
  cancelling it as anyone else answers 404. Responses carry status only, never a credential
  value. One-shot helpers (commit message, release notes, skill summary) run on the
  requester's own dir.
- **Draft model discovery is scoped to the draft OWNER**, not to whoever is looking: a draft
  lists, and accepts, the models its owner's credentials unlock, because those are the
  credentials the session will spawn with.
- **No provider yet.** `GET /me` adds `providersConnected` (any provider signed in or configured
  in the user's dir); when it is false the composer and the empty session view show a banner
  linking to Providers, and starting a session whose owner unlocks no model answers 409 (RPC
  `ok: false`) with "No model provider connected. Connect one under Settings > Providers."
- **Claude (PRV-01).** Claude on a subscription goes through `claude-bridge` (pi-claude-bridge:
  the real Claude Code, through the Agent SDK, under the host's Claude Code login), the route
  Anthropic allows. Pi's own Anthropic OAuth sign-in is not used: with it Pi presents itself as
  Claude Code, which Anthropic's consumer terms forbid and enforce with account bans. So the
  Providers screen offers Anthropic with an API key only, `GET /runtime/providers` reports each
  provider's `credentialType` (`api_key` or `oauth`, the stored entry winning over env as in Pi),
  and `anthropic/*` models are listed and accepted only when the owner's Anthropic credential is
  an API key (otherwise a 409 / RPC `ok: false` saying to add one). A launch (start, draft
  start, fork, Loop parent) or a live `set_model` whose model would be a refused `anthropic/<m>`,
  including one coming from Pi's default settings or the forked history, runs on
  `claude-bridge/<m>` instead when the owner has it, and is refused with the same message when not.
  The bridge counts as available, for every owner alike, only while the host's Claude Code is
  installed and logged in (`claude auth status`, cached for a minute); its models are discovered
  on the first launch that needs them. A subscription token is an OAuth credential however it
  arrives: a key containing `sk-ant-oat` (stored, or in `ANTHROPIC_API_KEY`) or
  `ANTHROPIC_OAUTH_TOKEN`, because Pi sends Claude Code identity headers for it. `/me`
  `providersConnected` means a usable transport: the bridge, or any credential other than such an
  Anthropic sign-in. The picker shows one
  "Claude" group: bridge models by plain name, API-key models as "<model> · API". An existing
  Anthropic sign-in stays in `auth.json`, with a note on the Providers screen that it is unused;
  sessions already on an `anthropic/*` OAuth model keep running. This applies on every server,
  shared or not.
- **Operator.** `AGENT_DECK_OPERATOR_EMAIL` maps the operator to the shared `~/.pi/agent`, so the
  existing sign-ins stay where they are with no file move. Sessions without an owner (created
  before identities existed, or on a loopback server), Doctor (its auth probe reads the agent
  dir it is given, and the route still gives it the shared one) and the Pi CLI over ssh also use
  the shared dir, so they run on the
  operator's credentials: accepted. Keep provider keys out of the shared `~/.pi/agent/.env` and
  the systemd unit, because Pi falls back to environment keys for a user with no stored
  credential (`PUT /runtime/env` already refuses them on a shared server).
- **Not isolation.** All Pi processes run as one Unix user, so any user's agent can read another
  user's `auth.json` (OAuth refresh tokens included) or `/proc/<pid>/environ`. This separates
  storage and billing between co-workers who trust each other (ADR 0003), nothing more. The
  file RPC (`file_read`/`file_write`, on a session or draft with any cwd) and the in-app terminal
  run as the same Unix user too, so either can read or replace any user's `auth.json`. The real
  fix is a Unix account or container per person (a future ticket), not more checks here.
  Agent Deck does refuse a user dir whose `users`, `<hash>` or `agent` component, or whose
  `auth.json`, is a symlink or not a regular entry, so a planted alias cannot redirect a
  sign-in or a spawn.
- **MCP sign-ins.** Pi keeps MCP OAuth tokens
  in `<user agent dir>/mcp-auth.json`, which is not on the link list, so each user has their own
  file (Pi writes it 0600 and puts its refresh locks beside it). Sign in from the MCP screen:
  "Sign in" on an HTTP server sends `/mcp login <name>` to one of your own live sessions in that
  project (none running: the screen says so). That session shows the sign-in link; open it,
  sign in, and the browser lands on a `http://127.0.0.1:.../callback?...` page that does not
  load on the shared server: copy that address into the session's input card. Tokens from the
  proxy path under `<dataDir>/mcp-oauth` are not migrated: everyone signs in again.
  Only a session's owner may run `/mcp` in it (the composer and the Sign in route refuse
  anyone else, and sessions without an owner), since `/mcp login` and `/mcp logout` act on the
  owner's tokens. The paste box of an owner's sign-in can still be answered by any viewer of
  that session: accepted, the same trust boundary as prompting someone else's session.
- **Limits.** The linked files are shared: one user's settings, model or MCP change applies to
  everyone. Pi locks `settings.json` and `trust.json` beside the link (`realpath: false`), so two
  users writing them at the same time are not locked against each other.

### GitHub connection

Each user connects their own GitHub account (ticket ade-gfs4,
`apps/server/src/githubConnections.ts`). Identity follows the owner; with one Unix user every
agent can read every token, so this is attribution, not an authorization boundary (ADR SRV-01,
[ADR 0003](adr/0003-shared-server-trust-model.md)).

- **Who acts as whom.** Sessions and their agents (Pi, subagents, helpers) follow the session
  OWNER. Everything a person clicks or types follows that person (the clicker): the in-app
  terminal, Push and Commit & Push on the Git screen (the commit is authored with the clicker's
  git identity too, so author and pusher match), and the Issues screen's comment, close and
  reopen. `GET /issues/connection` reports the requester's connected account. The release
  action (tag and push) and fetches outside a session stay on the VM default.
- **Operator setup, once.** Register a GitHub **OAuth App**, not a GitHub App (a GitHub App's
  user tokens expire after 8 hours and this server does not refresh them): github.com,
  Settings > Developer settings > OAuth Apps > New OAuth App (an organization's OAuth App works
  too), any homepage and callback URL (the device flow does not use the callback), then tick
  **Enable Device Flow**. No client secret is needed. Put the client id in `.env` as
  `AGENT_DECK_GITHUB_CLIENT_ID=<client id>` and run `docker compose up -d` (see
  [Install on a server](#install-on-a-server)). For an
  organization that restricts OAuth Apps, an org owner must also approve the app.

- **Device flow.** Settings > Providers > GitHub > Connect calls `POST /runtime/github/connect`,
  which asks GitHub for a device code and returns only the user code, the verification URL and
  the poll interval; the device code stays on the server. Scopes are `repo` and `workflow`
  (GitHub refuses pushes that touch `.github/workflows` without `workflow`; reading the account
  needs no scope). The token keeps these scopes until it is revoked, and any agent on the server
  can read it (ADR 0003). The card shows the code and a link, and polls
  `GET /runtime/github/connect/:id`, which asks GitHub at most once per interval (`slow_down`
  lengthens it) and answers `pending`, `done`, `expired`, `denied` or `error`; the card keeps
  polling through a network blip and ignores a late answer after Cancel. Only the user who
  started a flow can poll it (anyone else gets 404). If GitHub issues the token but the account
  lookup fails, the token is kept and the card says so. `GET /runtime/github` returns the login,
  avatar URL, scopes and connection time, never the token.
- **Disconnect.** `DELETE /runtime/github` forgets the token on the server and cancels the
  user's device flows still in progress, so none writes a token again. Running sessions and
  open terminals keep the token in their environment until they restart. Revoke it on
  github.com (Settings > Applications > Authorized OAuth Apps); the server cannot, since that
  needs the app secret.
- **Where the token lives.** `<dataDir>/users/<hash>/github.json` (next to the user's `agent`
  dir, same hash, same alias refusal), written 0600 through a fresh file renamed into place. The
  operator's (`AGENT_DECK_OPERATOR_EMAIL`) is `<dataDir>/github.json`. A symlinked user dir or
  `github.json`, or a `github.json` that is not a regular file, is refused with an error (the
  launch, terminal or push fails) rather than read as "no connection". Never in a log, a
  preview, an API answer or the UI.
- **Injection.** `GH_TOKEN` (used by `gh`) plus git configuration in the environment
  (`GIT_CONFIG_COUNT`, git 2.31 or later, appended after any `GIT_CONFIG_*` entries already in
  the environment): every inherited credential helper for `https://github.com` is cleared and
  replaced by one that answers `get` with `$GH_TOKEN` and ignores `store` and `erase`, so the
  VM's own credential store never sees the token. github.com SSH URLs (`git@github.com:` and
  `ssh://git@github.com/`) are rewritten to HTTPS with `insteadOf`, which also applies to an
  explicit `remote.<name>.pushurl` (`pushInsteadOf` would not), so the token, not the VM's key,
  is used; fetches from those remotes go over HTTPS with the same token. SSH host aliases (for
  example `github-work:org/repo`) and other hosts are not rewritten and push with the server's
  own key or credentials. Sessions get it at spawn and keep it on resume, fork and in subagents.
- **Git screen label.** "GitHub HTTPS pushes use @login" when connected; "This remote pushes
  with the server key, not your GitHub connection." when the project's push URL is an SSH alias
  or not on github.com (`GET /projects/:id/git/push-remote` answers `{ github }`, never the
  URL); "Pushing as the server default" otherwise.
- **No connection.** A session whose owner has not connected (and a session without an owner)
  gets nothing extra: git and `gh` fall back to the VM default.
- **Limits.** Any agent can print `GH_TOKEN` (for example by running `env`) into its own
  transcript, and can read every `github.json`; the event log redacts GitHub token prefixes
  (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), the Pi transcript does not.

### Shared projects from a repository

Projects → Add Projects… (and the project picker's Add project) opens on **Repository**: type
`owner/name` or `https://github.com/owner/name`, optionally a branch or tag; **Server folder** is
the folder browser above. The web sends `POST /projects { repo, ref? }`, accepted only on a
shared server. The server asks `GET https://api.github.com/repos/{owner}/{name}` with the
requester's GitHub connection (anonymously without one), then makes a full clone (history for
session worktrees, no `--depth` or `--filter`) of the repository's `clone_url` into
`<AGENT_DECK_PROJECT_ROOT>/<repository name>`, checking out `ref` or the default branch. The
project records `origin` (the clone URL), `repoId` (GitHub's repository id, its identity across
machines), `defaultBranch` and `createdBy`.

- **Project root.** The repository flow needs `AGENT_DECK_PROJECT_ROOT`; without it the answer is
  `409` (it never clones into the server user's home). Repository names that are not a safe
  folder on every platform (a leading dot, Windows device names such as `con` or `lpt1`, a
  trailing dot) are refused.
- **Private repositories need the requester's [GitHub connection](#github-connection)**; without
  one the answer is `409 connect GitHub first` (anonymously GitHub cannot tell private from
  missing). Public repositories clone anonymously, with every inherited git credential helper
  cleared, so the server's own credentials are never used. An expired connection answers `409`
  (reconnect in Settings); GitHub's anonymous rate limit answers `409` too.
- **No token on disk outside `github.json`.** The clone runs with the same `GH_TOKEN` env and
  credential helper as sessions; the clone's `.git/config` holds the plain HTTPS URL. A failed
  clone's folder is removed and git's error is returned with the token redacted.
- **Where a clone runs.** In a hidden `<root>/.agent-deck-clone-<uuid>` folder (invisible to the
  folder browser and discovery), renamed to its name only when complete. A second request for
  the same folder while it clones is `409`. Leftover temporary folders from a crash are removed
  when the server starts.
- **Conflicts.** The same repository again un-hides its project if it was hidden (`200`), else is
  `409` with its `projectId` and `repoId`. When the folder is held by another repository's
  project (a fork, a same-named repository), the clone goes to `<owner>-<name>` instead; if that
  is held too, `409` names the holder as `holderProjectId` (never `projectId`, which always means
  this repository). An unregistered folder of that name is `409`.
- **Delete.** On a shared server, new projects (repository or Server folder) record their creator;
  removing one is allowed only for that person or the operator (`AGENT_DECK_OPERATOR_EMAIL`);
  others get `403`. Projects added before this (without a creator) stay removable by anyone.
- **Long clones.** The request waits for the clone (up to 10 minutes). Cloudflare closes a
  response after about 100 s; the web then says the server is still cloning, and a reload a
  minute later shows the project.

### Make shared from the desktop

A local desktop app (its own backend, a team server set in Settings) turns a local project
into a shared one. **Make shared** on a project row reads the project's `origin` remote through
the local backend on every click (`GET /projects/:id/origin` answers `hasOrigin`, the GitHub
`owner/name` of an https, `git@github.com:` or `ssh://` remote, and `topLevel`; never the remote
URL, which may carry a credential). No remote shows "This project has no git remote", a
non-GitHub remote "Only GitHub repositories can be shared", and a folder that is not the
repository's root (`git rev-parse --show-toplevel`) is refused too: share the root. Otherwise the app sends `POST /projects { repo: "owner/name" }` to the shared
server, which clones it as in [Shared projects from a repository](#shared-projects-from-a-repository).

- **The token stays in Electron main.** The page asks main over IPC (`shared-server:request`),
  which allows only `GET /projects`, `POST /projects { repo, ref? }`, `GET /me`, a session
  move (`POST /projects/<uuid>/sessions/import`, below) and the live mirror of a moved session
  (`GET /sessions/<uuid>`, `GET /sessions/<uuid>/transcript?afterEntryId=`,
  `GET /events?sessionId=<uuid>&afterSeq=&limit=`, `POST /sessions/<uuid>/prompt { text }`) to the
  configured origin, adds `cf-access-token` from `cloudflared access token`, never follows a
  redirect, and hands back only the status and the JSON body (with the token redacted should the
  server echo it). Without a valid token (none cached, expired, or Access answers 401 or a login
  redirect) the answer is "sign in required" until a sign-in succeeds (cloudflared is not asked
  again on every call), and the row offers **Sign in to** the server: `cloudflared access login`
  in the system browser, with Cancel while it waits, then one retry. An Access 403 page reads
  "Your account is not allowed". Without `AGENT_DECK_CLOUDFLARED` the sign-in explains that it is
  missing.
- **The link.** A created project (201), a restored one (200) or the same repository already on
  the server (409 with its `projectId` and `repoId`) is stored on the local project as
  `sharedTo { serverOrigin, projectId, repoId, sharedAt }` (`PATCH /projects/:id`, `null`
  unlinks; refused with 409 on a shared server) in the local `projects.json`. A 409 naming a
  `holderProjectId` (another repository holds the folder) never links. The row shows
  `shared on <host>`, **Open on server** and **Unlink**; when the server's list no longer has the
  project it says `not on <host> any more` and offers Make shared again. Open on server opens
  `<server>/?project=<id>` in the system browser, which opens a new draft session in the project
  (never resuming an existing one, which may be another member's). Any other 409 shows the
  server's text, followed by a hint to connect GitHub on the server unless the text is already
  about GitHub.
- **Side by side.** On the Projects screen the app reads the server's `GET /projects` once; a
  local project whose GitHub `owner/name` matches a server project's `origin` shows the same
  badge with **Link** (stores `sharedTo` without creating anything). Matching is by repository
  name, case-insensitive: a renamed or transferred repository does not match until shared again.

### Moving a session to the server

In the desktop app, a session of a shared project (above) has **Share to server** in the chat
toolbar. The move is a copy on the system (the server session has its own id) but one session for
the user: the local row stays, with the same title, and becomes a read-only pointer.

- **Preflight** (`POST /sessions/:id/share/preflight` on the local backend) refuses while the
  session is responding or a subagent runs (detached ones too), for Loop sessions, for a draft
  and when the project is not shared. Otherwise it answers the branch, the number of changed
  tracked files, the **untracked files by name** (they travel too: the dialog lists every one,
  check them for secrets), the local commits not on the upstream yet (they travel too; a branch
  without upstream says every commit not on the remote travels) and the
  submodules with changes of their own. Ignored files (for example `.env`) never travel.
- **Move with my changes** (`POST /sessions/:id/share { mode: "snapshot", untracked }`): the
  request names the untracked files the user saw; a different set answers
  `409 share_plan_changed` with the new list and the dialog asks again. The snapshot stages
  the tracked changes and exactly those untracked files (a file that appeared later never
  travels; a missing one is a changed plan, and nothing is pushed). It is
  committed through a throwaway index (a copy of the real index under `GIT_INDEX_FILE`, never
  split; the real index, HEAD and files are not touched) on top of HEAD and pushed with **this
  device's own git login** to `refs/agent-deck/transfer/<session id>`. Only when the remote
  refuses that namespace does it push the branch `agent-deck/transfer/<session id>` instead
  (never after a login, permission or network error). A staged and unstaged mix of one file
  travels as its working-tree content. A dirty submodule, or a failed push, offers **Move the
  conversation only**: the edits stay on the device, and the server copy gets a note the model
  reads before its next turn ("Earlier edits from <device> are not in this workspace.").
- **The hand-off**: from the export until the link is recorded (or the move is cancelled, or 15
  minutes pass) the local session is frozen: prompts, delegation, history actions and merges are
  refused (`session_moving`). Anything that fails after the push removes the pushed ref first.
- **The export** carries the Pi transcript, title, plan, agent and model choice, the composer
  draft (without file and folder references) and paste records; images are inside the
  transcript. Checkpoints, subagent runs, Loop cells, plan history and event history stay behind
  and are named in the result. It is at most 16 MB. The renderer sends it through Electron main
  (`POST /projects/<id>/sessions/import`, the only patterned path the client allows) so the
  Access token never reaches the page.
- **The import** on the shared server validates the export strictly (closed shapes, UUIDs, a
  transcript whose entries have unique ids and parents written before them, no device paths),
  fetches the transfer ref first with the requester's GitHub connection (a private repository
  without one: "connect GitHub first"), creates a session worktree from it, undoes the snapshot
  commit with `git reset --mixed` (the edits are uncommitted changes again, untracked files
  untracked) and rewrites only the transcript header's cwd (Pi resumes there). The thinking level the
  session last ran at becomes part of its launch configuration, above the server default and
  any agent level. The model the session ran on must be one the
  requester's providers offer (as for a fork), else `409 model_unavailable`. Every message
  author becomes the requester. The new session belongs to the requester, records
  `sharedFrom { device, localSessionId }`, and resumes Pi from the imported transcript when
  opened. The same session from the same member again (also two posts at once) answers
  `409 session_already_imported` with the existing `sessionId` (the dialog then links that copy),
  or with `pending: true` while the first attempt still runs (retry later). An earlier copy whose
  transcript differs (`sharedFrom.exportSha256`) answers `409 export_changed` and is never
  linked; cancel the move. The answer says `transferRefDeleted`; the device deletes the ref again after
  recording the link, since the server may lack push rights (a public repository without a
  GitHub connection). If neither side can, the dialog shows the `git push origin --delete`
  command.
- **When the server does not answer** (no connection, 502, 504, 524) nothing is undone: the
  server may still be importing. Try again; a retry links the copy if it arrived.
- **The pointer** (`sharedTo { serverOrigin, serverSessionId, sharedAt, mode }` in the local
  `sessions.json`): its Pi is stopped and its failure or attention state cleared; it opens without
  Pi, showing its last local transcript read-only, "on <host>" in the list and, instead of the
  composer, "This session continues on <host>." with **Open on server**
  (`<server>/?session=<id>`) and **Continue locally**, a plain fork that has no link. Prompts,
  rollback, re-run, message fork, rename, merge, plan retry and composer drafts answer
  `409 session_shared`; delete removes only the local copy.
- **Live mirror** (SRV-12c2): while a pointer is the open session, the page reads its server
  session through Electron main (the same allow-listed client, never the local backend):
  `GET /sessions/<id>` (meta with its activity and owner), `GET /events?sessionId=<id>` from a
  cursor kept in memory (the A1c read; facts and references only, reduced into the Run tree as
  they arrive and not kept) and, when there are new events, the server session is running or a
  cell is still open, `GET /sessions/<id>/transcript`. The transcript route answers the running
  session's in-memory transcript (mid-stream cells included) or its Pi file (unreadable: 503) as
  a window of the newest 200 cells and 2 MB, each cell measured first (over 512 KB it becomes a
  notice, never walked) and redacted: secret-like keys (tokens, secrets, passwords,
  authorization, cookies, API and private keys, credentials) lose their whole value, free text
  loses secret-looking strings and key/value pairs; ids are never rewritten. An answer carries
  `firstId` (the client drops older cells), `truncated` ("Earlier messages are on <host>") and
  `prefixHash` (sha1 of the window's settled cells). The next read names its last cell, that
  hash and up to 20 `openId` cells still changing; the server sends those again plus the new
  ones, or the whole window when a settled cell changed (a later verdict, a cell hidden from
  the model). The page reads the whole window again whenever the server session stops running.
  Any member may read it, as any member may open the session; the route is behind the
  browser-origin check. The poll runs every 3 seconds while the server session is active and
  the window is focused, every 15 seconds otherwise, and stops while the window is hidden or
  the pointer is not open. Nothing is stored: the cursor, the tree and the mirrored window live
  in renderer memory only. **Read-only**: mirrored cells offer no answers, history actions or
  editors; open questions say "Answer on <host>" with Open on server, and images and child
  transcripts show "(on <host>)". **The composer comes back** as "Runs on <host> as <owner>":
  a text prompt (at most 32,000 characters, no attachments, no steering) goes to
  `POST /sessions/<id>/prompt { text }`, which opens a session that is not running as the
  resume route does and dispatches the prompt through the same RPC path as a socket prompt
  (author is the Access identity of the device user, as for any member; Loop review sessions
  refuse on both paths). Send waits while the server session is answering or waiting for a
  person. Everything else on the pointer still answers `409 session_shared`. **States**: no
  answer, 5xx or a 404 without the server's own code: the last local copy with "Last local
  copy; <host> is unreachable." and Retry; 401: "Sign in to <host>" (the Make shared sign-in);
  403: the server's text, no retry; `404 unknown_session`: "This session no longer exists on
  <host>." with **Unlink** (`PATCH /sessions/:id/shared-to { sharedTo: null }` on the local
  backend: the pointer becomes an ordinary local session again, resumed from its own Pi file;
  the one local write of the mirror, accepted because it ends the mirror) and Continue locally.
  Both return to this device's copy from the move: turns run on the server are not brought
  back. Unlink leaves the server copy as it is, including a turn still running there.
- **Events**: `session.shared` on both logs (`direction` out or in, mode, ids, host or device;
  no paths, no content).
- **Owner check on the live server**: verify that GitHub accepts `refs/agent-deck/*` for push,
  fetch and delete; the branch fallback covers a refusal.
- **Not covered**: if the app closes between the push and the
  import, the ref stays on the remote until the hand-off expires on the device (15 minutes, if the
  app is still running) or is deleted by hand (`git push origin --delete
refs/agent-deck/transfer/<id>`).

### Bringing a session back

A pointer has **Bring back** next to Continue locally (SRV-12c3). The session's work comes back
to the device it left and continues there as the same local session; the server copy becomes the
pointer. Only the session's **owner** can do it (the envelope and its completion are theirs; the
operator can only cancel a return), and only for a server session that came from a device
(`sharedFrom`). The renderer drives it through Electron main, which allows exactly
`POST /sessions/<id>/return` (`{}` or `{ confirmedUntracked: [file names] }`),
`POST /sessions/<id>/return/abort` (`{ handoff? }`) and `PATCH /sessions/<id>/returned`
(`{ deviceSessionId, handoff }`).

- **Preflight** (`POST /sessions/:id/return {}` on the shared server) refuses a session that is
  already a pointer, did not come from a device, is a draft or a Loop session, or is responding
  or running subagents; `403` for anyone but the owner; `409 github_not_connected` ("Connect
  GitHub first") when the owner has no GitHub connection (never the server's own credentials).
  Otherwise it answers the plan as Share to server does (branch, changed tracked files, every
  untracked file by name, dirty submodules, the device).
- **The snapshot** (`{ confirmedUntracked }`) is the share code run on the server: the same
  throwaway index, exactly the consented untracked files (`409 share_plan_changed` with the new
  list otherwise), pushed with the owner's connection to `refs/agent-deck/transfer/<server
session id>` (the branch form only when the namespace is refused). Every server push (transfer
  refs, the PR branch) runs with `core.hooksPath` set to an empty directory, so no hook in the
  shared `.git/hooks` sees a member's `GH_TOKEN`. The envelope is the same v1 shape with
  `direction: "return"`, `sharedFrom { device, localSessionId }` and the open PR
  (`meta.mergePr`). From here the server copy is frozen for 15 minutes at most (prompts,
  including the live mirror's forwarded ones, answer `session_moving` or
  `session_mutation_busy`); expiry or `POST /sessions/:id/return/abort` deletes the ref and
  unfreezes it. **One return at a time**: a second `return` answers `409 return_in_progress`
  until the first is finished or cancelled.
- **On the device** the renderer posts `{ envelope, handoff }` to
  `POST /sessions/:id/import-return` on the local backend. Everything that can refuse runs before
  git: the envelope as strictly as the server checks a share (closed shapes, the transcript checks,
  `direction: "return"`, a snapshot, the server session this pointer links to, this device
  session in `sharedFrom`), every paste, and the launch configuration: the agent, provider and
  model the server copy ran with and the thinking level its transcript last set, resolved as a
  server import does and checked against **this device's** providers (`409 model_unavailable`,
  nothing touched). Then it fetches the ref with the device's own git login into a private ref and
  checks the commit and its one parent. **Where it lands**: the original checkout only when that
  loses nothing: no change and no untracked file, no merge or rebase in progress, HEAD exactly at
  the snapshot's base (an older HEAD would move the checked-out branch), and no ignored entry
  (`git ls-files -o -i --directory`) at, inside or around a path the snapshot writes. Then
  `git merge --ff-only <snapshot>` and `git reset --mixed <base>` with `core.hooksPath` pointed
  at an empty directory (no post-merge or husky hook runs the server's code). Any refusal, of the
  checks or of the merge, goes to a fresh worktree of the project instead, and the answer says so.
  A reset that fails twice after the merge answers an error saying HEAD is at the transfer commit
  and the `git reset --mixed <base>` that fixes it; the pointer stays. After a snapshot share the
  device checkout still holds the edits it sent, so the fresh worktree is the usual case. The
  transcript (header cwd rewritten, the device's own `parentSession` kept) replaces the pointer's
  Pi file under the same local session id; the old file stays as `<file>.pre-return` (one
  generation). Pastes and the composer draft come with it, the server's message authors stay as
  attribution labels, `sharedTo` is removed, `returnedFrom { serverOrigin, serverSessionId,
returnedAt, mergePr? }` and `returnPending { token, serverOrigin, serverSessionId, ref, until }`
  are recorded, and the device deletes the ref. Any failure before the transcript write leaves the
  pointer as it was; the renderer then aborts the return on the server, whose copy stays live.
- **The server copy** then becomes the pointer (`PATCH /sessions/:id/returned`, owner only, the
  hand-off token and the device session it came from; a stale token answers `409 return_stale`, a
  running turn is refused): its Pi ends and it records
  `sharedTo { serverOrigin: null, device, deviceSessionId, sharedAt, mode }`. Repeating the call
  for the same device session answers the pointer again (a lost answer is retried); any other
  device session is refused. The device then clears `returnPending`. While it is set the session
  shows "Finish the return on <host>" (Retry, valid for the 15-minute hand-off); after that, or
  without a connection to the server, it explains that the server copy stays open, with **Close
  server copy** (open it on the server and delete it) and Dismiss. On the shared server a pointer
  renders read-only, "This session continues on <device>.", with Continue here (a plain fork);
  prompts, merge and the rest answer `409 session_shared`. There is no live mirror of the device:
  the server cannot reach it.
- **Transfer refs**: abort and finalisation delete the ref and report `transferRefDeleted`; a
  deletion that fails is kept and retried by the next return call on that session. When neither
  side could delete it, the device shows the `git push origin --delete <ref>` command.
- **Events**: `session.shared { direction: "return" }` on both logs.
- **Moving it out again** makes a new server copy: a pointer copy is never the earlier import.

### Merge on the shared server: push and pull request

On the shared server, for a session **with an owner** in a project whose origin is a **GitHub**
repository, `POST /sessions/:id/merge` does not merge into the server's checkout. It commits the
session worktree as the local merge does (owner identity, co-author trailers), pushes the session
branch to `origin` under the same name with the **session owner's** GitHub connection (hooks off,
as above), and opens a pull request as the owner with `gh pr create --repo=<owner/name>
--head=<branch> --base=<project default branch> --title=<session title> --body=<commit subjects +
"Opened from Agent Deck session <id>">` (argv, never a shell string). The PR is recorded as
`mergePr { url, number, openedAt }` and returned as `{ pr: { url, number } }`; the worktree stays.
A **re-click** commits and pushes again (the open PR gets the new commits) and answers
`merge_pr_updated` with the same URL; when `gh pr view <number> --json state` says MERGED or
CLOSED, it opens a new PR instead. Refusals: `403` for anyone but the owner or the operator,
`409 merge_github_missing` without the owner's connection. An open PR for the branch that gh
reports is returned as the PR. A gh failure after the push answers `502 merge_pr_failed` naming
the pushed branch. The web Merge control reads "Push and open PR" there, then "Push to PR" with
the PR link. Folder projects, other hosts and sessions without an owner keep the local merge
exactly as before, as does the desktop. A session brought back to a device carries the PR in
`returnedFrom.mergePr`: its local merge shows the link and warns that merging there lands the
work twice.

## Container image

The shared server ships as a Linux x64 image, `ghcr.io/<owner>/agent-deck-server`
(`Dockerfile` at the repository root, SRV-17a).

What is inside (`/app`, owned by root, not writable by the server user):

- `dist/server/index.mjs`, the esbuild backend bundle (`pnpm build:backend`, no source map). The
  PostHog key is not baked: the image builds without `AGENT_DECK_POSTHOG_KEY`, so analytics is off.
- `web/`, the built UI (`pnpm build:web`), served by the backend.
- `resources/loop-catalog-native/` and `resources/skill-engine-native/`, the two `.linux-x64.node`
  addons (`pnpm build:native`, Rust pinned by `rust-toolchain.toml`); `resources/builtin-agents/` and
  `resources/builtin-prompts/`.
- `pi-runtime/node_modules`, the pinned Pi from `pnpm build:pi-runtime`, the same deploy the desktop
  packages. Pi runs as `node <cli.js>`; native MCP finds `pi-mcp` beside that `cli.js`.
- `node_modules/node-pty`, built for Linux Node 22, for the terminal panel.
- `git` and `openssh-client` (Debian), `gh` (release tarball, version and SHA-256 pinned in the
  Dockerfile), `ripgrep` and `fd-find` (Pi uses these instead of downloading its own on first use),
  `tini`, `ca-certificates`. No sources, pnpm or toolchains: those stay in the build stage.

The server runs as `agentdeck` (uid 1000, home `/data/home`) under `tini`, on port 4200, with a
`HEALTHCHECK` on `/health`. `PI_SKIP_VERSION_CHECK=1` stops Pi's update check, and
`AGENT_DECK_APP_VERSION` is the release version (build argument `APP_VERSION`, default `dev`). The image sets the same resource variables the packaged desktop passes
to its backend (`AGENT_DECK_WEB_DIST`, `AGENT_DECK_PI_PATH`, `AGENT_DECK_PI_CLI`,
`AGENT_DECK_BUILTIN_AGENTS_DIR`, `AGENT_DECK_BUILTIN_PROMPTS_DIR`,
`AGENT_DECK_LOOP_CATALOG_NATIVE_PATH`, `AGENT_DECK_SKILL_ENGINE_NATIVE_PATH`), so the bundle uses the
desktop's resolution unchanged. Also:

| Variable              | Image value         | Meaning                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_DECK_DATA_DIR` | `/data`             | Server state (see the volume table below). `/data` is a declared volume owned by `agentdeck`.                                                                                                                                                                                                            |
| `AGENT_DECK_HOST`     | _(unset: loopback)_ | Address the server binds. The image keeps `127.0.0.1`: the `cloudflared` sidecar shares the network namespace, and the `HEALTHCHECK` runs inside. Set `0.0.0.0` only for a local smoke test with the port published on `127.0.0.1`; it exposes the server to every container on the same Docker network. |

Everything else is the operator's: the variables in [Environment variables](#environment-variables)
(`AGENT_DECK_TRUSTED_PROXY` and the Access settings, `AGENT_DECK_PUBLIC_ORIGIN`,
`AGENT_DECK_PROJECT_ROOT`, `AGENT_DECK_OPERATOR_EMAIL`, `AGENT_DECK_GITHUB_CLIENT_ID`,
`AGENT_DECK_DESKTOP_RECOVERY_TOKEN`). With `AGENT_DECK_TRUSTED_PROXY` unset the container is a
single-user local server with no authentication.

Data: everything that must survive a container replace is in `/data`. Mount a named volume there
(Docker copies the image's `/data`, `agentdeck`-owned, into a new empty volume). A bind mount or
tmpfs must be writable by uid 1000, or the server exits at start; the server creates `/data/home`
when it is missing.

| Path under `/data`           | What                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(top level)_                | Sessions index and server state: `sessions.json`, `projects.json`, session authors, event logs, Loop runs, MCP settings.                                                                                |
| session worktrees            | Created under the data dir by the server.                                                                                                                                                               |
| `users/<hash>/agent`         | Per-user Pi agent dirs (credentials, settings) for trusted-proxy users; their shared entries link into the home below.                                                                                  |
| `home/`                      | `agentdeck`'s home: `~/.pi/agent` (Pi transcripts in `sessions/`, `auth.json`, `settings.json`, `models.json`, `mcp.json`, skills, extensions, agents, prompts), `~/.agents`, `gh` login, `.gitconfig`. |
| project clones (your choice) | Set `AGENT_DECK_PROJECT_ROOT` inside `/data` (for example `/data/projects`) so clones from a repository persist too.                                                                                    |

Built by `.github/workflows/server-image.yml` on every pull request to `main` (no push), on a `v*`
tag and on manual dispatch. The first job builds the image on the runner and smokes it before
anything is published: `/health` 200, JSON from `GET /projects`, `/resources/agents` and
`/resources/skills`, `node $AGENT_DECK_PI_CLI --version`, `require('node-pty')`, an import of the
`pi-mcp` module the bridge resolves, a marker in `~/.pi/agent` that must survive a container
replace on the same volume, and a size gate: it fails if the compressed image is over 400 MB
(unpacked it is about 550 MB, of which the Node slim base and git are about 330 MB). Only then
does the publish job (the only one with `packages: write`) push from the same build cache: tags
`X.Y.Z`, `X.Y`, `latest` (not for a prerelease tag such as `v1.2.0-rc.1`) and `sha-<short>`;
manual dispatch pushes `sha-<short>` only.

Bumping the build pins (all `ARG`s at the top of the `Dockerfile`):

- Rust: set `RUST_VERSION` to the `channel` of both `rust-toolchain.toml` files.
- rustup: set `RUSTUP_VERSION` to `version` in `https://static.rust-lang.org/rustup/release-stable.toml`
  and `RUSTUP_SHA256` to the hash in
  `https://static.rust-lang.org/rustup/archive/<version>/x86_64-unknown-linux-gnu/rustup-init.sha256`.
- gh: set `GH_VERSION` to a `cli/cli` release and `GH_SHA256` to the `linux_amd64.tar.gz` line of
  that release's `gh_<version>_checksums.txt`.
- Node: the two `FROM node:<version>-bookworm[-slim]` tags (Node 22.22 or later).

Local smoke test (Linux x64 host with Docker; never on the Windows checkout). The
`AGENT_DECK_HOST=0.0.0.0` override and its `AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST=1` opt-out are for
this test only, so the port published on loopback reaches the server:

```sh
docker build -t agent-deck-server:dev .
docker run -d --rm --name ad-test -p 127.0.0.1:4299:4200 \
  -e AGENT_DECK_HOST=0.0.0.0 -e AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST=1 \
  --tmpfs /data:uid=1000,gid=1000 agent-deck-server:dev
sleep 8
curl -s http://127.0.0.1:4299/health      # {"ok":true}
curl -s http://127.0.0.1:4299/projects    # {"projects":[]}
docker stop ad-test
```

What any other way of running the image must keep (`deploy/compose.yaml`, see
[Install on a server](#install-on-a-server), does all of it):

- Compose must run `cloudflared` in the server's network namespace (`network_mode: service:<server>`)
  or use host networking: the server binds loopback and trusts only loopback peers, so it cannot be
  reached over a Docker network.
- Compose must mount a tmpfs on `/tmp` (the generated Pi bridge extensions, which can hold resolved
  MCP credentials, are written there).
- Compose must set `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]`; a read-only root
  filesystem (`read_only: true`, with `/data` and `/tmp` writable) is optional.
- Compose must give sessions without an owner a git identity and, for `git@` remotes, an SSH key and
  `known_hosts` (in `/data/home/.gitconfig` and `/data/home/.ssh`), or document `gh auth login`.

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
- **Remote-mode local shell actions are refused** (ade-q0pz): with
  `AGENT_DECK_REMOTE_SERVER_URL` set, "Open file" and "Reveal in folder" for agents, prompts and
  MCP configs, revealing subagent or Loop artifacts and a retained Loop worktree, and classifying
  dropped files all fail before any path reaches the OS, because the path would come from the
  server (a UNC path would open an SMB connection on Windows).
- **`POST /sessions/:id/share/abort` is refused on the shared server** (409 `share_refused`, as
  preflight and share): it is a device route; a return has its own owner-checked abort.
- **Hooks are off for shared-server pushes and transfers** (ade-q0pz): Push and Commit and
  push on the Git screen of the shared server (with the requester's GitHub token or, without
  one, the service's credentials), the release on the shared server (its fetch, tag and
  atomic push), every push made with a requester's token, and every git command of a session
  transfer (snapshot capture, worktree add, reset, fetch, ref and branch cleanup) run with an
  empty `core.hooksPath`. Local pushes and releases without a token keep the repository's
  hooks. Git-screen and release errors reach the page with secrets redacted.

### Known gaps (POC)

- Git LFS repositories cannot be pushed from the shared server or moved with their files
  (ade-q0pz): a hook-free push skips git-lfs's pre-push upload. The Git screen answers 409 "LFS
  repositories cannot be pushed from the shared server yet" when the checkout tracks LFS files,
  or HEAD or any outgoing commit that changed an attributes file has a `.gitattributes` naming
  `filter=lfs` (outgoing: not on the upstream, or on no remote without one); the session merge
  push fails the same way. A snapshot is checked the same way plus its consented untracked
  files (`git check-attr`). Moving an LFS checkout moves the conversation only (the dialog
  disables "Move with my changes"; a snapshot share answers 409), and a return, which always
  carries the snapshot, answers "LFS repositories cannot be moved yet." When detection itself
  fails, the push, snapshot or return is refused (fail closed). A release is not refused: its
  lease pushes only a commit the remote already has.
- `session-authors.json` is one file rewritten per message; rows go with `DELETE
/sessions/:id` and orphans are dropped at startup, but there is no size bound. Fine for two
  people, not for a fleet.
- No per-user authorization, quotas or private sessions; no identity in Loops or subagent
  runs beyond the parent session's `createdBy`.
- Session git identity is attribution, not authorization: Pi and its tools run as the service
  user and can still commit as anyone (`git -c user.name=...`, editing the env), and
  `Co-authored-by:` lines reflect who prompted, not who wrote which change.
- Host launchers are refused on a shared server, because they would open on the headless VM
  rather than on the user's machine (ade-rpkm): `terminal_open_external` and `editor_open`
  reply `ok:false`, and `POST /runtime/doctor/fix` and `POST /runtime/doctor/update-pi`
  answer 409. The web UI hides "Continue in external terminal" and shows the "Open in editor"
  controls disabled. Use the in-app terminal instead.
- Provider sign-ins are per user (ade-n41e, see [Credentials](#credentials)), but the global
  `.env` is still one file for everyone (ade-4lga): `PUT` and `DELETE /runtime/env` (both scopes)
  answer 409 for a provider credential env name (the pi-ai 1.2 list, e.g. `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY` for `azure`, `GOOGLE_CLOUD_API_KEY` for
  `google-vertex`); add keys under Providers instead. `EXA_API_KEY` stays writable because web
  search is shared by design. Ambient credential names outside the pi-ai list also stay
  writable by design: `AWS_*` for `amazon-bedrock`, `GOOGLE_APPLICATION_CREDENTIALS` for
  `google-vertex`, and the Anthropic workload-identity names (`ANTHROPIC_IDENTITY_TOKEN_FILE`,
  `ANTHROPIC_FEDERATION_RULE_ID`, ...).
- Every Pi `notify` shows as a notice in the session transcript, for every viewer of that
  session. That includes Pi's MCP notices, such as "MCP servers need attention" on resume and
  the stderr tail of a stdio MCP server that fails to start, which can carry whatever the
  server printed (a secret, if it prints one).
- MCP tokens are per user: Pi keeps them in `<user agent dir>/mcp-auth.json` (see
  [Credentials](#credentials)). Tokens the removed proxy stored under `<dataDir>/mcp-oauth` are
  no longer read, so everyone signs in again; Agent Deck does not delete that directory, remove
  it by hand once nobody needs it.
- MCP sign-in needs the paste step: the redirect page is Pi's loopback listener on the VM,
  which the user's browser cannot reach, so it fails to load; paste its address into the
  session's input card. Pi only accepts the full address from the address bar of that same
  sign-in (same origin, path and state).
- The MCP screen's status comes from a probe that holds no user token, so a server behind OAuth
  shows "needs sign-in" even after you signed in; the sessions use your token regardless.
- Pi 1.0.3 renamed the Azure provider `azure-openai-responses` to `azure` (PI-04). Agent Deck
  maps the old id in its own state on load (app settings, session metadata) and renames the key
  in the shared and every per-user `auth.json` at startup. Pi's own `settings.json`
  (`defaultProvider`, `enabledModels`) and `models.json` are not rewritten: rename them by hand.
- OAuth sign-ins from the browser finish by pasting a code: Pi's callback listens on the VM's
  loopback, which the user's browser cannot reach. On a shared server the sign-in sheet shows
  the paste field at once; for Anthropic choose "Copy code login (headless)" and paste the code
  Anthropic shows (the browser login also works by pasting the final redirect URL).
- GitHub tokens are per user (ade-gfs4, see [GitHub connection](#github-connection)) and, like
  provider credentials, readable by every agent: attribution, not an authorization boundary.
- Per-user credentials are storage, not isolation: every user's agent can read every
  `auth.json`. Sessions without an owner, Doctor and the Pi CLI use the operator's.
