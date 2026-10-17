---
id: ade-k1nc
status: open
deps: []
links: [ade-81m8]
created: 2026-10-17T22:05:06Z
type: task
priority: 2
assignee: almoretti
parent: ade-u3ld
---
# SUB-05: Claude Code in the image, per-user config folder, sign-in from the session terminal

Package: Claude Code pinned in the server image (version and integrity pinned like gh), per-member config folder in the data volume set through CLAUDE_CONFIG_DIR for their launches and their terminal, sign-in from the member's own session terminal (claude auth login), Doctor and Providers report the caller's sign-in, runbook first-run step. Absorbs ade-81m8 (PRV-02); the guard that refuses a bridge model without Claude Code stays.

