---
id: ade-tb53
status: open
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
