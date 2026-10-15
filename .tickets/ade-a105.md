---
id: ade-a105
status: open
deps: []
links: []
created: 2026-10-15T21:53:36Z
type: epic
priority: 1
assignee: claude
tags: [shared-server, distribution]
---
# SRV-17 (epic): the shared server as an installable container package

Owner decision 2026-10-15: the shared server becomes a product you install on a server, container first. Production bundle (scripts/build-backend.mjs) + built web UI + Linux x64 addons + pinned Pi binary + git/gh in a non-root node:22-slim image published to GitHub Container Registry on tags; Docker Compose with an agent-deck service and a cloudflared sidecar; data (sessions, shared-project clones, worktrees, credentials) in one named volume; env from a .env file with the variables the runbook lists. ADR 0003 trust model unchanged (one identity inside the container, members share the filesystem, identity from Access headers). Answers the DST stub's open question: the Linux target is this server package, not a Linux desktop app (DST-05/06 become the server image pipeline and its upgrade path). Tarball + systemd units is an optional follow-up from the same bundle. Sub-tickets: 14a image, 14b compose + docs, 14c VM cutover (owner-paced).

## Acceptance Criteria

All sub-tickets closed; a fresh host runs the shared server from the published image with docker compose up -d and passes the two-user smoke; the runbook describes install, upgrade, rollback; the DST stub is updated.

