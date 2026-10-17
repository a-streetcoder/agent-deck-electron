---
id: ade-0mj8
status: open
deps: [ade-w2zc, ade-nobk]
links: []
created: 2026-10-17T22:05:04Z
type: task
priority: 2
assignee: almoretti
parent: ade-u3ld
---
# CRB-03: sandbox policy for the broker (allow only the broker; provider hosts removed for brokered sessions)

ADR 0007 amendment: a session's policy allows exactly its broker address and port (deniedResolvedAddresses carve-out, allowedDomains entry); provider hosts leave the default allow-list for brokered sessions; the stack matrix gains a brokered turn; Doctor's sandbox check reports the broker.


## From CRB-01 (ade-w2zc)

- srt's resolved-address guard denies a name that resolves to the container's own address unless `<ip>:<port>` is in `allowedDomains`; that literal is the carve-out, not `deniedResolvedAddresses`. The product policy therefore adds the broker as `<container ip>:<port>` (and the hostname if the session is given one). srt treats an IP literal on the allow list as an explicit choice and never re-judges it.
- Inside srt the sandboxed process must proxy every host (`NO_PROXY=`, curl `--noproxy ''`, `NODE_USE_ENV_PROXY=1` for Node clients); a direct dial to the container address is `ENETUNREACH`. The env the sandbox sets for Pi's tool commands must clear `NO_PROXY`.
- Regression test: srt drops single quotes in a wrapped one-liner; the spawn path must hand srt a script or argv, never a quoted command string.

## From CRB-02 (2026-10-18)

- One-shot helpers (`runHelper`: commit messages, skill summaries) have no session record and still launch with the requester's own agent dir and real `auth.json`; they rely on the provider hosts staying in the allow-list. Before removing those hosts, give helpers a broker route (a registered helper id whose sponsor is the requester) and switch `runHelper` to the broker's launch env.
- Pi extension-registered providers inside a session are not brokered (they define their own base URL); decide whether brokered sessions may load such extensions.
