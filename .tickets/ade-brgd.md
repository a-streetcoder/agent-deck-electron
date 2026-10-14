---
id: ade-brgd
status: closed
deps: []
links: []
created: 2026-10-14T00:08:57Z
type: task
priority: 0
assignee: almoretti
---
# SRV-01: ADR shared headless host vs VISION_EDGE

Short ADR in docs/adr/0003-shared-server-trust-model.md deciding: (a) the shared VM is a legitimate deployment despite VISION_EDGE saying agents run on the owner machine; (b) trust model = mutually trusted co-workers, one Unix user accepted, attribution is a label not isolation; (c) the POC lands on main as opt-in behind the AGENT_DECK_TRUSTED_PROXY env vars; (d) shared provider logins on the VM (one Claude subscription in ~/.pi/agent serves both people) acknowledged with the quota and terms implication; (e) consequences for distribution (a Linux target may be a headless deploy, not a desktop package). One page. Consulted: nah-contrarian 2026-10-14 (objections 3,5,6 accepted).

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first.

## Acceptance Criteria

ADR file exists following the 0001/0002 format with Status Accepted, Context, Decision, Consequences; VISION_EDGE.md gains a one-line pointer to it; format check passes.

