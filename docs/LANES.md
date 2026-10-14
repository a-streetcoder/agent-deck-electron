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
- Developer worktrees (architect-owned, outside the synced folder, deleted when merged): `E:gent-deck-wtde-3wuu` (S20, apps/server diff service, contracts, apps/web diff UI), `E:gent-deck-wtde-mk3s` (S19, e2e/tests only), `E:gent-deck-wtde-qr3v` (OPS-02, docs/roadmap.md only). SRV-08 (ade-zvv5, apps/desktop, docs/remote-server-poc.md) runs in the main checkout.
