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
