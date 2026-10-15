---
id: ade-tb53
status: closed
deps: [ade-229e]
links: []
created: 2026-10-15T21:53:37Z
type: feature
priority: 1
assignee: claude
parent: ade-a105
tags: [shared-server, distribution]
---
# SRV-17b: Docker Compose, env template and install/upgrade runbook

deploy/compose.yaml with two services: agent-deck (image from 14a, named volume agent-deck-data mounted at the data directory, env_file .env, restart unless-stopped, mem/cpu limits, no host port) and cloudflared (official image, tunnel run with TUNNEL_TOKEN, depends_on agent-deck, pointing at agent-deck:4200). deploy/.env.example listing every variable the runbook documents (PORT, AGENT_DECK_TRUSTED_PROXY, AGENT_DECK_CF_ACCESS_TEAM_DOMAIN, AGENT_DECK_CF_ACCESS_AUD, AGENT_DECK_PUBLIC_ORIGIN, AGENT_DECK_DESKTOP_RECOVERY_TOKEN, AGENT_DECK_GITHUB_CLIENT_ID, AGENT_DECK_GH_BIN if still needed, TUNNEL_TOKEN) with one comment each and no values. Runbook: new top-level section in docs/remote-server-poc.md 'Install on a server' (prerequisites: a Cloudflare tunnel + Access application and a GitHub OAuth App created once; docker compose up -d; first sign-in; upgrade = pull + up; rollback = previous tag; backup = the volume; where the data lives), replacing the hand-written systemd section (kept under 'Legacy: source checkout' until 14c closes). Update the DST stub ticket note and docs/roadmap.md: DST-05/06 = server image pipeline + upgrade path.

## Acceptance Criteria

docker compose config validates in CI (workflow step); .env.example complete; runbook reviewed; roadmap and DST stub updated.


## Notes

**2026-10-15T22:21:25Z**

2026-10-15 constraints from 17a (binding): the server trusts the Cloudflare proxy only from loopback, so the cloudflared sidecar must run with network_mode: service:agent-deck (shared network namespace) and point at 127.0.0.1:4200; the image listens on AGENT_DECK_HOST=0.0.0.0 by default: Compose must NOT publish the port, or publish on 127.0.0.1 only; Pi credentials (~/.pi/agent), the gh login and git config live in /home/agentdeck: mount a second named volume for the home (or set the relevant *_HOME variables into /data) so they survive container replacement; a fresh --tmpfs /data must be uid=1000,gid=1000 (named volumes inherit the owner automatically); image is linux/amd64 only.

**2026-10-15T22:32:21Z**

2026-10-15 more constraints from the 17a contrarian: Compose needs a tmpfs /tmp (mkdtemp is used for bridge extensions, prompt files, the no-hooks dir and skill merges) if the rootfs is read-only; cap_drop ALL + no-new-privileges; choose network namespace sharing (network_mode: service:agent-deck) or host networking for the cloudflared sidecar (a proxy over a Docker network gets 401); ownerless/local-mode sessions need a git identity (user.name/email env or gitconfig in /data/home) and openssh-client for git@ remotes; a typo in AGENT_DECK_TRUSTED_PROXY silently disables authentication: the .env.example must spell it out.

**2026-10-15T22:47:57Z**

2026-10-15 started; worktree E:\agent-deck-wt\ade-tb53 (wt/ade-tb53).

**2026-10-15T22:54:18Z**

2026-10-15 implemented as f2be30c (compose hardened, cloudflared 2026.10.1 in the server's namespace, TUNNEL_TOKEN blanked for agent-deck, .env.example with safe pre-fills, CI compose-config step, runbook 'Install on a server', legacy retitle, roadmap DST line). docker compose config validated on the VM; the stack has never run (first run is 17c). Image owner a-streetcoder matches the GitHub remote. Contrarian + GPT (review58) running.

**2026-10-15T23:02:08Z**

2026-10-16 reviews: GPT (review58) = backup umask, restore into an empty volume, port 7844 docs, DST stub (done by the architect); contrarian = no first-up blocker, but a restarted agent-deck strands cloudflared in a dead namespace (fix: pause container owning the namespace), image not yet published (runbook prerequisites), upgrade command does nothing on a pinned tag, auth switchable from .env (hard-code proxy + PORT in compose, fatal typo in bindHost), hardening never exercised (CI smoke with the flags), missing project root 500s (server creates it), Cloudflare GitHub login method prerequisite, recovery token useless on the shared server, cloudflared metrics on 0.0.0.0. Consolidated fix round sent.

**2026-10-15T23:09:31Z**

2026-10-16 fix round (dd8529a: pause-container namespace owner, proxy + PORT fixed in compose, fatal proxy typo, startupDirs creates home and project root, 404 on a missing root, hardened CI smoke, runbook prerequisites/upgrade/backup/restore/ssh, loopback metrics, roadmap DST wording) verified by the architect; squashed 991212b, merged e6c8524; server typecheck, bindHost + startupDirs tests, format gate green; VM restarted (health 200). CLOSED. Owner/17c: the stack has never run with up; first run validates read_only with real sessions, the net container recovery, GHCR access after the first release. Follow-ups: the recovery token's Desktop login paragraph is rewritten by 16d; ensureStartupDirs only warns on failure; if the net container dies both services need up -d --force-recreate.
