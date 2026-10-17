---
id: ade-3up0
status: open
deps: [ade-210c]
links: []
created: 2026-10-17T01:19:53Z
type: task
priority: 2
assignee: almoretti
parent: ade-1c88
tags: [shared-server, sandbox]
---
# SBX-03: server and web wiring — provider per side, project sandbox.json, violation events, allow-host action

Server: AGENT_DECK_SANDBOX=srt|none (default srt on the shared server when srt and bwrap are present, none otherwise with a startup warning; none on desktops; Windows always none). Read .agent-deck/sandbox.json from the project root at spawn (schema in contracts: allowedDomains, allowLocalBinding; invalid file -> session warning, defaults used). srt violations -> sandbox.violation session event (path or host, operation) in the event log and the live stream; web renders it as a system line in the transcript; an 'Allow <host> for this project' action (owner or operator; allowedOperations row) appends to sandbox.json and commits nothing (the file is the user's to commit). Settings/capabilities expose sandbox: { provider }.

## Acceptance Criteria

A denied host shows in the transcript with the allow action; allowing it makes the next command succeed; tests for the route, the event producer and the component.


## Notes

**2026-10-17T02:02:00Z**

2026-10-17 BINDING from the SBX-01 contrarian pass: (1) the Pi tool bridge moves off TCP loopback on the server: a bridge-only http server listening on the Unix socket <dataDir>/sandbox/bridge.sock, passed to Pi as AGENT_DECK_BRIDGE_SOCKET (client side done in SBX-02); never allow-list 127.0.0.1:4200 in the sandbox; (2) every spawn that runs worktree code is wrapped with the same provider: loopEngine validation commands (loopEngine.ts ~172 spawn shell:true), services/scriptRunner.ts, services/terminal.ts, with a permissive policy (worktree writable, project domains) — the profiles must not ship (SBX-04) before this; (3) git.ts adopts checkerShell's hardened env for every server-side git call (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1, -c core.fsmonitor=false, hooks already disabled) so a config written by a session cannot run code outside the sandbox; (4) bridge extension dirs and prompt files move under <dataDir>/sandbox/<sessionId>/ (per-session TMPDIR from the policy), not shared /tmp; (5) .agent-deck/sandbox.json is read from the project's base branch (git show <base>:.agent-deck/sandbox.json) or requires the owner/operator allow action, never from the worktree the agent edits; (6) registerCommandNetworkLists per session (SBX-02) is what makes per-project lists real; test on the VM that project B gets 403 for a host only project A allows.

**2026-10-17T02:12:35Z**

2026-10-17 DECISION (architect, from the srt 0.0.80 source): the bridge does NOT use a Unix socket. On Linux srt blocks AF_UNIX via its seccomp helper and allowAllUnixSockets drops the helper entirely (and with it the nested-namespace block); the helper is non-negotiable. The bridge transport becomes Pi's own stdio: the extension issues an extension_ui_request (method input, title 'agent-deck-bridge/1', the request JSON in the prompt/placeholder field) and the server answers with extension_ui_response {id, value: <response JSON>}; concurrent calls are keyed by id; no token, no port, no socket, identical on desktop and server, inside or outside a sandbox. Remove the AGENT_DECK_BRIDGE_SOCKET client branch added in SBX-02 and the TCP /bridge endpoint once every bridge call is on stdio (keep the route only if a non-Pi client uses it; check). Genuine extension dialogs must still be distinguished by the title marker.

**2026-10-17T02:26:48Z**

2026-10-17 additions from the SBX-02 reviews: the server supplies agentDir (PI_CODING_AGENT_DIR of the session) and sessionDir (the folder Pi writes the session file into) to sandboxPolicy, and ownerDir; with G/refs writable to a worktree session, read .agent-deck/sandbox.json at the server-recorded base commit (git show <baseCommit>:.agent-deck/sandbox.json), never at a ref; srt's initialize registers SIGINT/SIGTERM/exit handlers in the host process: order the server shutdown so SandboxManager.reset() runs after sessions are stopped; handle handle.pid being undefined until the async wrap resolves (spawnPiProcess reads it right after start()); the stdio bridge interception happens at sessionManager.ts ~1353 before extension_ui_request becomes a human node (A8).
