---
id: ade-81m8
status: closed
deps: []
links: [ade-k1nc]
created: 2026-10-17T18:49:59Z
type: bug
priority: 0
assignee: almoretti
parent: ade-1c88
---
# PRV-02: Claude on the shared server — the image has no Claude Code, so the bridge is never available and launches fall through to the Anthropic sign-in

Found 2026-10-17 in the browser: a session on deck.moretti.cc with the default model (claude-bridge/claude-fable-5) ran on Pi's own Anthropic provider with the stored sign-in and answered 400 'You're out of extra usage'. Two causes. (1) The container has no claude executable anywhere (find / -name claude: nothing; ~/.local/bin absent), so bridgeAvailable() is false on the server and PRV-01's bridge route cannot work there at all. (2) claudeLaunchModel only pins/refuses providers in the refused set; a default of provider claude-bridge with the bridge unavailable is let through, Pi cannot register the provider (no --extension) and falls back to its own default, which is the refused sign-in. The owner reported the symptom as 'we are not using the bridge'.

## Acceptance Criteria

(a) Guard: when the launch's provider is claude-bridge and the bridge is unavailable, treat it like a refused model (pin the first offered model, else the stable 409), with a test; same for set_model. (b) Image: install Claude Code in the server image (pinned version) and document the sign-in on the VM (owner runs it; the login must live in the data volume so it survives image upgrades); /me and the Providers screen must show the bridge as unavailable until then. (c) Re-run the browser check: a new session on the default model runs through claude-bridge (the transcript model shows provider claude-bridge) and spends the subscription.


## 2026-10-18
Superseded by ADR 0009: per-user Claude Code sign-in through the broker (SUB-05). The guard fix (47ba86b) stays. Closing in favour of SUB-05.
