---
id: ade-u5bg
status: closed
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

**2026-10-15T22:29:52Z**

2026-10-15 GPT review (review55): five should-fix (short writes not checked, no download/decompression size bounds, automatic redirects allow an http hop, no overall deadline, quoted Windows PATH entries). Fix round sent; contrarian running.

**2026-10-15T22:31:40Z**

2026-10-15 contrarian: no security blocker (tar reader fails safe on 11 crafted inputs; hash compare full-length); should-fix = runner resolved once at client creation (installing cloudflared mid-run needs a restart), env override loses to the stored path, remote-attach silently switches to the cloudflared flow, docs on version bumps; the sign-in gating criterion handed to 16b. Additions sent to the developer.

**2026-10-15T22:40:41Z**

2026-10-15 fix round (1cbf823: full writes + hash of the file on disk, size caps, manual https redirects with host allow-list, 10-minute deadline, quoted PATH, lazy per-call runner, env override wins, remote mode env-only, checksums cross-checked against release digests, tar refusal tests, docs) verified by the architect; squashed f34b2ff, merged f52cb44; typecheck + design-system + 42 desktop node tests + TeamServerScreen green. CLOSED. Follow-ups: a stored cloudflaredPath from an older pinned version is used until removed (treat paths outside the current version folder as stale); no download for Windows arm64/ia32; old version folders not cleaned.
