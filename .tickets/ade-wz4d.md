---
id: ade-wz4d
status: closed
deps: []
links: []
created: 2026-10-14T08:22:43Z
type: bug
priority: 1
assignee: almoretti
tags: [desktop, shared-server]
---
# REV-01: desktop review fixes - quit from sign-in page, cancel covers token read, no local trash in remote mode

GPT checkpoint review findings on poc/shared-server (apps/desktop). (1) main.js close/before-quit wait for the renderer's draft-flush acknowledgement (flushDraftsBeforeQuit); the sign-in page (sign-in.html, ade-zvv5) never registers one, so Close and Quit from that page hang and end in 'Your draft could not be saved'. Fix: when the window is still on the local sign-in page (remoteSignIn set / main frame url is file:), skip the draft flush and quit directly, and abort any pending cloudflared login on shutdown. (2) remote-server.js createRemoteSignIn: after access login completes, cloudflaredToken runs without the abort signal, so a Cancel in that window still attaches the token and navigates away. Fix: pass the signal to the token read and check signal.aborted before attach; test cancel between login completion and token resolution. (3) main.js ipc skills:trashRecovery fetches the recovery path from the control plane and calls shell.trashItem on it locally; in remote mode (remoteServer set) that path is on the VM and can hit an unrelated local directory. Fix: refuse the action in remote mode with a clear error (the renderer shows it); do not add a server-side delete.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset/commit here; never run git on the VM; no pnpm build or pack:win. Work in the main checkout, apps/desktop only. Keep each fix to a few lines; unit tests in apps/desktop/*.test.js for (2) and, where feasible, (1).

## Acceptance Criteria

From the sign-in page, Close and Quit exit at once with no draft dialog and no lingering cloudflared process; cancelling after browser approval but before the token read never attaches the token (unit test); skills:trashRecovery in remote mode rejects with an error and trashes nothing (unit test or code path proof); desktop tests, eslint and prettier green on changed files.


## Notes

**2026-10-14T08:27:57Z**

2026-10-14 validated in the real app (isolated profile, no cached token): start login -> window.close(): app exited, cloudflared gone; start login -> quit: same. Unit test covers the late-cancel race. Ponytail: accepted. Known: killing cloudflared leaves the browser tab open; the bootstrap token read before the window has no signal (out of scope).
