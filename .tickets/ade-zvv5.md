---
id: ade-zvv5
status: in_progress
deps: []
links: []
created: 2026-10-14T07:24:20Z
type: feature
priority: 1
assignee: almoretti
tags: [desktop, shared-server]
---
# SRV-08: desktop sign-in page starts the cloudflared browser login on click

Today (ade-1vjx) a remote launch with AGENT_DECK_CLOUDFLARED and no cached token runs cloudflared access login before any window exists: the system browser opens with no explanation, and the app window appears only after approval. The owner was not sure what was going on. Change: when access token fails, open the window first on a small local sign-in page ('Sign in with your browser' button, team domain shown). Clicking it runs access login, the page switches to 'Waiting for your browser: approve the request there' with a cancel/retry, and on success main.js attaches the cf-access-token header and loads the remote origin as today. A failed or cancelled login stays on the page with the cloudflared error text. Mid-run expiry stays out of scope.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md Desktop login first. Keep it in apps/desktop: a static HTML file (no renderer build), loaded with loadFile, one preload-exposed IPC 'remote-sign-in' handled in main.js; reuse cloudflaredAccessToken by splitting it into token() and login() so the window can call login on click. Never log or expose the token to the page. Unit tests in apps/desktop for the split and the state transitions; manual proof as in the Desktop login section (delete the cached token files first).

## Acceptance Criteria

Launching the cloudflare launcher with no cached token shows the Agent Deck window on the sign-in page within 3 s, no browser opens until the button is clicked; after approval in the browser the same window loads the app signed in; cancelling or a cloudflared error leaves a readable message and a retry; existing cached-token launches are unchanged; apps/desktop tests pass; docs/remote-server-poc.md Desktop login updated.

