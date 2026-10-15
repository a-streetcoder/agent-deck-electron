---
id: ade-u5bg
status: open
deps: [ade-wvbh]
links: []
created: 2026-10-15T21:55:07Z
type: feature
priority: 2
assignee: claude
parent: ade-fah9
tags: [desktop]
---
# SRV-16c: cloudflared discovery and verified download

Owner decision 2026-10-15: download when missing. Resolution order: the stored cloudflaredPath, AGENT_DECK_CLOUDFLARED (dev override), PATH, the known install folders per OS (Windows: %ProgramFiles(x86)%\cloudflared, winget links; macOS: /opt/homebrew/bin, /usr/local/bin; Linux: /usr/local/bin, /usr/bin). If none: the Team server section offers 'Download cloudflared' which fetches the official asset for the platform from the cloudflare/cloudflared GitHub release (pin a version constant with its published sha256 per platform in the repo; update by PR), verifies the checksum before making it executable, stores it under userData/cloudflared/<version>/, records cloudflaredPath. No auto-run of a downloaded file before verification; download over https only; progress and failure shown in the section. Version pinned, not 'latest'.

## Acceptance Criteria

node --test for the resolution order and for the verifier (wrong checksum -> file deleted, nothing recorded); a mocked download test; docs list the pinned version and how to bump it; the sign-in button is disabled with an explanation until a cloudflared is resolved.

