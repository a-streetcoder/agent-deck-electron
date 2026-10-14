# Lanes

One line per agent session working on or around this repository. A session touches nothing in
another lane. The architect updates this file at dispatch.

- `agent-deck-electron-52`: Claude Code architect (NAH), branch `poc/shared-server`. Owns repo
  source and docs on the PC checkout; no VM units.
- `LAN connection after power cut`: server-management session. Owns the VM services
  (`agent-deck-server`, `cloudflared-agent-deck`), the Cloudflare tunnel and Access application,
  and deploys.
- `code-meter-win-c5`: Code Meter. Owns the Azure signing account configuration
  (`codemeter-signing`, see [release-windows.md](release-windows.md)).
- `claude-d6`: claude.ai session linked to the PC (2026-10-15). Owned the direction/documentation
  revamp only — `VISION*.md`, `docs/adr/0004-*`, `docs/roadmap.md`, `docs/archive/` moves,
  `docs/handover-direction-2026-10-15.md`. Touched no source, no tickets; committed nothing.
