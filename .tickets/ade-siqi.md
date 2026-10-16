---
id: ade-siqi
status: in_progress
deps: [ade-229e, ade-tb53]
links: []
created: 2026-10-15T21:53:37Z
type: task
priority: 2
assignee: almoretti
parent: ade-a105
tags: [shared-server, operations]
---
# SRV-17c: cut the VM over to the container and retire the mirrored-checkout deploy

Owner-paced. On the VM: install docker, create deploy/.env from the current systemd environment, stop the agent-deck-server and cloudflared user units, migrate the data directory into the volume (sessions, session-authors.json, credentials, shared-project clones with their worktrees; paths inside session metadata must match the container's data path: provide a one-off migration note or script), docker compose up -d, two-user smoke with Andrea, then disable the old units and stop Syncthing from mirroring the checkout to the VM. Update docs: remove 'Legacy: source checkout', update the operating notes (deploy = pull + up), and the memory/operating rules of the architect sessions.

## Acceptance Criteria

deck.moretti.cc served by the container; old units disabled; Syncthing share to the VM removed; runbook has no checkout-based deploy left.


## Notes

**2026-10-15T23:09:32Z**

2026-10-16 ready to start when you are: 17a image (merged 8d74f98) and 17b compose/runbook (merged e6c8524) are in; prerequisites on your side: push the branch and tag a v* release so the image publishes to GHCR (or run the workflow manually for a sha tag), make the package public or create a read:packages token, create the token tunnel + public hostname, and fill deploy/.env. Runbook: docs/remote-server-poc.md 'Install on a server'.

**2026-10-16T07:09:40Z**

2026-10-16 cut over by the architect session on the owner's instruction. Branch pushed (origin/poc/shared-server). On the VM: image built from a shallow clone (~/agent-deck-build, tag ghcr.io/a-streetcoder/agent-deck-server:local, 566 MB, APP_VERSION poc-402e96f) because no v* tag has published to GHCR yet; deploy folder ~/agent-deck with compose.yaml and .env (values copied from the old unit's Environment lines and the old tunnel's TUNNEL_TOKEN, AGENT_DECK_IMAGE_TAG=local); fresh data volume (old data dir left untouched at ~/.local/share/agent-deck-electron, test data only); operator ~/.pi/agent seeded into the volume minus sessions/bin/npm; old user units cloudflared-agent-deck and agent-deck-server stopped and disabled; host :4200 free; tunnel registered with 4 connections; deck.moretti.cc answers 302 to Access; a server restart re-registers the tunnel. Left: two-user smoke with Andrea, v* tag so the image publishes and .env can pin a real tag, Syncthing share to the VM removed (owner's desktop Syncthing), runbook legacy section.
