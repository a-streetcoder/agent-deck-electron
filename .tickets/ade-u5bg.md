---
id: ade-u5bg
status: in_progress
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


## Notes

**2026-10-15T22:17:25Z**

2026-10-15 started; worktree E:\agent-deck-wt\ade-u5bg (wt/ade-u5bg). Parallel with 16b: keep changes in a new module (cloudflared resolution + verified download), its IPC and its UI block; the sign-in flow belongs to 16b.

**2026-10-15T22:27:17Z**

2026-10-15 implemented as a28357b: cloudflared-resolver.js (order: stored path if exists, AGENT_DECK_CLOUDFLARED as given, PATH, known folders), pinned download 2026.10.0 with live-verified sha256 table (macOS: checksum of the binary inside the .tgz, extracted by a small tar reader), IPC with sender guard + remote refusal, client rebuilt after a download, UI section; sign-in button gating left to 16b. Contrarian + GPT (review55) running.
