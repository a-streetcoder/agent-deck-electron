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

