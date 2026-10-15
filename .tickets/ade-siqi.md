---
id: ade-siqi
status: open
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

