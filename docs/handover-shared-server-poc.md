# Handover — shared-server POC (branch `poc/shared-server`)

Written 2026-10-14 by the server-management session for the Agent Deck Electron session. Everything below is verified on the live setup, not planned.

## What was built and proven

Goal: Agent Deck as a **shared, multi-user cockpit**: the server runs on Ale's Linux VM, two people reach it from their own machines with their own identity, agents execute on the server. Chosen over T3 Code (no user model), Paperclip (no desktop app) and OpenClaw (persona agent, not a cockpit); see `E:\AI Playground\server-rebuild\agents\cockpit-evaluation.md` and `t3code-evaluation.md` for the comparisons.

Proven end to end on 2026-10-14, from both a browser and the Electron desktop app in remote mode:
browser/desktop → Cloudflare Tunnel + Cloudflare Access (GitHub login) → Agent Deck server on the VM (`/me` = `alemoretti@hotmail.com`) → Pi runs inside server-owned clones (`/srv/streetcoding/CrunchyMurmur`, host `dev`, user `ale`) → streamed back with author label and initials on the session row. Sessions created in one client show up in the other (shared state).

## Branch contents (10 commits on top of main `b4e185e`, nothing pushed)

| commit | what |
|---|---|
| d07f38e | `win\Agent Deck Remote (dev VM).cmd` — SSH-tunnel launcher (obsolete while the server is in trusted-proxy mode; keeps 401ing) |
| fab6a3b | contracts: optional `UserIdentity`, `SessionMeta.createdBy`, `UserCell.author` |
| cb5c02a | server: opt-in trusted-proxy identity (`apps/server/src/trustedProxy.ts`, RS256/JWKS with `node:crypto`, loopback-only trust), `GET /me`, author sidecar `session-authors.json`, WS/REST origin guard accepts `AGENT_DECK_PUBLIC_ORIGIN` |
| 7d916ec | web: "Signed in as", owner initials on session rows, author above user messages, `/me` plumbing |
| b8f1ce6 | desktop: `AGENT_DECK_REMOTE_SERVER_URL` remote mode, `controlPlaneFetch` via `session.defaultSession.fetch`, Access/GitHub navigation allowances, env recovery token, `win\Agent Deck Remote (cloudflare).cmd` |
| 88241e9 | remote project picking: `GET /fs/dirs` (rooted at `AGENT_DECK_PROJECT_ROOT`), pickers return [] when local paths can't be chosen |
| d0dc7fa | `docs/remote-server-poc.md` (env vars, VM services, security model) |
| e36534a | desktop: open the window before the health check so Access login can happen (first-run bug) |
| 218a414 | web: `ServerFolderBrowser` reachable from toolbar picker, Projects dialog and new-session card |
| 9ee2423, 0e89eae | roadmap notes (t3 orchestration-v2 ideas; session move between backends) |

Tests at 218a414: server 1236 pass (2 env-only symlink EPERM failures, see WINDOWS.md), web 592, desktop 20; `pnpm lint`, typecheck, format green.

## Live environment (do not break it casually)

- VM `dev` (10.0.0.12, Debian 13, ssh alias `dev` from Ale's PC), user `ale`.
- Checkout on the VM: `~/ai-playground/a-streetcoding/agent-deck-electron` — this is the **Syncthing replica of this very folder** (two-way sync with `E:\AI Playground`). Its `.git` lags a bit; the working tree is current. Node 24, pnpm, cargo installed; `pnpm install` done with `GITHUB_TOKEN` from `gh auth token` (read:packages for `@a-streetcoder/skill-engine-native`). `packages/loop-catalog-native/native/` is excluded from sync (each OS builds its own; the PC prebuild wipes it).
- Service: `~/.config/systemd/user/agent-deck-server.service` runs `pnpm --filter @agent-deck/server dev`, `PORT=4200`, loopback only; drop-in `agent-deck-server.service.d/remote.conf` sets `AGENT_DECK_TRUSTED_PROXY=cloudflare`, `AGENT_DECK_CF_ACCESS_TEAM_DOMAIN=streetcoding-collective.cloudflareaccess.com`, `AGENT_DECK_CF_ACCESS_AUD=a05d0c8c…5efb`, `AGENT_DECK_PUBLIC_ORIGIN=https://deck.moretti.cc`, `AGENT_DECK_PROJECT_ROOT=/srv/streetcoding`.
- Tunnel: `~/.config/systemd/user/cloudflared-agent-deck.service` (token in `~/.config/cloudflared-agent-deck.env`). Cloudflare: tunnel `agent-deck`, CNAME `deck.moretti.cc`, Access app "Agent Deck · Streetcoding Collective" (GitHub IdP only; policy = `alemoretti@hotmail.com`; add Andrea's GitHub email there for his round).
- Projects: server-owned clones in `/srv/streetcoding` (CrunchyMurmur, agent-deck-electron), registered via the Projects dialog's monitored folder. VM `gh` is not logged in (needed for private repos / pushing).
- Redeploy after web changes: `ssh dev` → `cd ~/ai-playground/a-streetcoding/agent-deck-electron && pnpm build:web && systemctl --user restart agent-deck-server`; check `curl 127.0.0.1:4200/health` (200) and `/me` (401 locally is correct).
- Desktop remote shell: `win\Agent Deck Remote (cloudflare).cmd` (accepts extra electron args, e.g. `--remote-debugging-port=9222`; Playwright `connectOverCDP` from `e2e/` works for driving it).

## Known gaps / decisions still open

1. **ADR needed**: VISION_EDGE says agents run on the owner's machine; this is a shared headless host. Not written.
2. **Attribution ≠ isolation**: all sessions run as one Linux user with full filesystem and one set of provider logins. Per-user Linux users or containers would be the real boundary.
3. REST origin/CSRF guard (roadmap Track 1 #3) not implemented; `/fs/dirs` is listable by any authenticated user.
4. GitHub **passkey (WebAuthn) 2FA 404s inside the Electron window**; workaround: authenticator/SMS. Real fix: system-browser login handed to the app (T3-style pairing), or WebAuthn support in the window.
5. Desktop recovery token: env override exists; the VM service does not set one yet (recovery endpoints 401 from the shell).
6. `session-authors.json` is one file rewritten per message, not pruned on session delete.
7. Health check in remote mode is a single 10 s request after the app page loads (no retry loop).

## Suggested next steps (Ale's stated wishes)

1. **Git author per session** from `createdBy` (GIT_AUTHOR/COMMITTER env for the session's git + Pi runs). ~½ day.
2. **Push/PR as the session owner**: per-user GitHub connection (device flow), token stored per profile, injected into that session's credential helper and `gh`. 1–2 days.
3. **Andrea's round**: add his GitHub email to the Access policy, make him sign in from his Mac, co-work in one session.
4. **Session move between backends** (roadmap entry 0e89eae).
5. Push `poc/shared-server` for review when Ale says so (he explicitly asked for nothing to be pushed so far).

## Working-tree warning

This checkout (`E:\AI Playground\a-streetcoding\agent-deck-electron`) currently has `poc/shared-server` checked out, and it is mirrored live to the VM by Syncthing. Switching branches here changes the VM's working tree too (the running server only re-reads on restart; `pnpm build:web` rebuilds from whatever is checked out). If you need main, prefer a separate clone or coordinate before switching.

## Decision 2026-10-14: login via the system browser, not the Electron window

Ale's call for gap 4. Replace the in-window Cloudflare/GitHub login with a **system-browser login handed back to the app**:

1. The app opens `https://deck.moretti.cc/desktop/login?state=<nonce>` in the user's default browser (where the Cloudflare session and passkeys already work).
2. Cloudflare Access authenticates as today; the page then hands the result back to the app, either via a custom URL scheme (`agentdeck://login?code=…`, registered by the Electron shell) or a one-time code shown in the browser that the user pastes into the app.
3. The server exchanges the code for an app session: simplest is to mint a short-lived server-issued token bound to the verified email (the Access JWT is still the proof of identity; the server already verifies it in `trustedProxy.ts`), and have the desktop shell attach it to every request/WS as a bearer header. Alternatively copy the `CF_Authorization` cookie into Electron's session for the app origin.
4. The Electron window then loads the app origin already authenticated; no GitHub pages are ever rendered inside Electron, so WebAuthn/passkeys are no longer an issue.

Why not a Cloudflare Access service token: it authenticates the app, not the person, and would erase per-user identity.
