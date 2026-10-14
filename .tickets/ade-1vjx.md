---
id: ade-1vjx
status: closed
deps: [ade-brgd, ade-63d3]
links: []
created: 2026-10-14T00:08:58Z
type: task
priority: 1
assignee: almoretti
---
# SRV-05: spike - desktop login through the system browser via a per-user Access token

Cloudflare Access sits at the edge, so a server-minted bearer alone never reaches the server (redirected before trustedProxy.ts). Spike first: can Electron obtain a per-user Access credential through the SYSTEM browser and present it on every request and WS upgrade? Candidates: (1) Cloudflare non-browser flow (cloudflared access login style: browser login then a cf-access-token header) and (2) copy the CF_Authorization cookie into the Electron session for the app origin after a system-browser login that lands on an agentdeck:// callback (app.setAsDefaultProtocolClient). Outcome is a decision note with a working proof on this machine for one path, or a documented failure of both, in which case the server-minted token design from docs/handover-shared-server-poc.md (GET /desktop/login, POST /desktop/exchange, one-use code 60 s, bearer as second credential in the same onRequest hook) becomes the next ticket. No GitHub page may render inside Electron.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first. Time-box: one day.

## Acceptance Criteria

Decision note in docs/remote-server-poc.md with the chosen mechanism, the proof (steps reproduced on Windows), token lifetime and renewal on 401, and the follow-up ticket if an exchange endpoint is needed; passkey login works end to end in the proof.


## Notes

**2026-10-14T01:06:06Z**

2026-10-14 spike status: candidate 1 code built (AGENT_DECK_CLOUDFLARED opt-in, cf-access-token header injected via onBeforeSendHeaders; 22/22 desktop tests) but NOT proven end to end: cloudflared access login needs the owner to complete the system-browser login; two attempts timed out unattended. Remaining proof steps are in docs/remote-server-poc.md Desktop login.

**2026-10-14T07:17:02Z**

2026-10-14 decision: candidate 1 (cloudflared non-browser flow) proven on this PC. access login completed in the already signed-in system browser (passkey session from the earlier attempt); /me 200, /health 200, /rpc upgrade 101 with cf-access-token, 302 without; recovery routes accept x-agent-deck-desktop-recovery-token through the edge; token lifetime 168 h, aud matches the server. Electron with AGENT_DECK_CLOUDFLARED and a fresh --user-data-dir opened straight on the app, 'Signed in as alemoretti', no Access/GitHub page or frame. trustedProxy.ts unchanged; no exchange endpoint needed, server-minted design shelved. Candidate 2 not tried. Decision note in docs/remote-server-poc.md Desktop login; launcher line left opt-in.
