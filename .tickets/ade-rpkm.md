---
id: ade-rpkm
status: in_progress
deps: []
links: []
created: 2026-10-14T13:42:14Z
type: task
priority: 2
assignee: almoretti
---
# SRV-09: host-only launchers are refused and hidden on a shared server

Owner report 2026-10-14: the terminal on the shared server 'does not work'. Reproduced: the in-app terminal drawer works end to end through the tunnel (bash on the VM, input, output, exit), but 'Continue in external terminal' (rpc terminal_open_external -> apps/server/src/terminalLauncher.ts) spawns x-terminal-emulator (zutty) on the headless VM, which exits with 'DISPLAY not set' while the reply is ok:true, so the click silently does nothing. The same applies to the other host launchers: editor_open (apps/server/src/editorLauncher.ts) and the two terminal-launching POSTs in apps/server/src/routes/settings.ts (fix in terminal, pi update). Fix: (1) server: when AGENT_DECK_TRUSTED_PROXY is set (ServerContext knows it; see how sessionAuthors/gitIdentities are gated in server.ts), terminal_open_external and editor_open reply with ok:false error 'Not available on a shared server: use the in-app terminal' / '...: open the file from your own machine', and the two settings POSTs return 409 with the same style of message; no spawn is attempted. (2) web: when the store's me (GET /me, null on loopback) is set, the drawer's 'Continue in external terminal' button (data-testid terminal-open-external, apps/web/src/components/TerminalDrawer.tsx ~379) is not rendered, and the 'Open in editor' controls (ChangedFilesTree/OpenInPicker) are rendered disabled with the title 'Not available on a shared server'. Pattern precedent: ade-wz4d hid Move to Trash in remote mode.

## Design

GUARDRAILS: checkout mirrored live to the VM by Syncthing; never git checkout/switch/stash/reset; no builds, no full suites (low memory): run only the test files you touch, one at a time, plus eslint and prettier on changed files; do not commit. Keep the diff small: one server-side guard helper reused by the four entry points, and two small web conditionals.

## Acceptance Criteria

rpcHandler test: with trusted proxy on, terminal_open_external and editor_open reply ok:false with the message and the launcher spawn is never called; route test for one settings POST returning 409; web test: TerminalDrawer with me set renders no external button, OpenInPicker disabled; with me null everything renders as before; docs/remote-server-poc.md lists the refused actions in the Known gaps or desktop section

