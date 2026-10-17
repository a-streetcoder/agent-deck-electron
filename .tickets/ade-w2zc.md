---
id: ade-w2zc
status: closed
deps: []
links: []
created: 2026-10-17T22:05:04Z
type: task
priority: 1
assignee: almoretti
parent: ade-u3ld
---
# CRB-01: credential broker spike on the VM (placeholder swap, streaming, sandbox allow, Claude Code base URL, one real Codex turn)

Spike on the VM (scratch image agent-deck-server:sbx10, plain docker run with the production security options, scratch volumes, everything deleted at the end): a broker on the container address with one placeholder per secret; inside a sandboxed command (srt driven directly as in SBX-05, network allowing only the broker address) curl and node fetch reach an HTTPS echo upstream through the broker with the real secret injected (bearer, header, query); SSE streams; a 20 MB body passes; Claude Code (installed in the spike image) runs a prompt with ANTHROPIC_BASE_URL at the broker and a placeholder CLAUDE_CODE_OAUTH_TOKEN and the echo shows the swapped token; overhead vs direct. Then, with the owner's go, one real Codex turn: Pi models.json baseUrl override for openai-codex at the broker, the broker injecting the real bearer and account id. Evidence on this ticket; go/no-go for CRB-02. Rules: never a real token in a transcript, log or ticket; the production stack is untouched.


## Evidence (2026-10-18, VM, scratch image agent-deck-server:sbx10 = sbx10-base + Claude Code, plain docker run with the production security options, read-only root, /tmp tmpfs)

Set-up inside the container: an echo upstream on 127.0.0.1:8443 that reports whether a header or query value arrived as a placeholder or as the real sentinel (never the value), a broker on 0.0.0.0:8787 whose only knowledge of the four sentinels is its own environment (`SECRET_*`), and a wrapper that drives srt 0.0.80 directly (`SandboxManager.initialize` with `allowedDomains: [<hostname>:8787, <container ip>:8787]`, `wrapWithSandbox`) around each check. The shell that runs the checks has zero `SECRET_` variables.

| # | check (sandboxed unless stated) | result |
|---|---|---|
| 1 | curl, `Authorization: Bearer ph_anthropic_key` | upstream saw the real bearer |
| 2 | curl, `x-api-key`, `chatgpt-account-id` and `?key=` placeholders | all three arrived real |
| 3 | 2 MB POST body streamed through | bodyBytes 2097152, stable sha |
| 4 | SSE, five events 300 ms apart | timestamps 301, 301, 301, 300 ms apart (not batched) |
| 5 | 20 MB download through the broker | 20971520 bytes in 0.07 s |
| 6 | node fetch (`NODE_USE_ENV_PROXY=1`) with a placeholder | upstream saw the real bearer |
| 7 | direct `https://api.anthropic.com/` | refused by srt (`deny network-outbound api.anthropic.com:443`) |
| 8 | 200 sequential requests: direct echo (unsandboxed) / broker (unsandboxed) / broker (sandboxed) | 763 ms / 807 ms / 1370 ms, i.e. +0.2 ms per request for the broker, +3 ms for srt's proxy hop |
| 9 | Claude Code (`claude -p`, `ANTHROPIC_BASE_URL=http://<broker>`, `CLAUDE_CODE_OAUTH_TOKEN=ph_claude_oauth`, own `CLAUDE_CONFIG_DIR`) | reached the broker, `POST /v1/messages` with the placeholder swapped (broker swap counter advanced); the echo is not an Anthropic API so Claude Code reported a malformed 200 — the transport and the swap are what the check proves |

Three findings that bind CRB-02 and CRB-03:

1. **srt refuses a hostname that resolves to one of the container's own addresses** (`resolved-address-guard`, "one of this host's addresses") unless the IP literal with its port is itself in `allowedDomains`. The policy must therefore list both `<container ip>:<port>` (the carve-out) and, if a name is used, the name. `deniedResolvedAddresses` is not involved; that list only adds denials.
2. **Inside srt everything goes through its proxy**; private ranges sit on `NO_PROXY`, and a direct dial to the container address fails with `ENETUNREACH`. Clients in the sandbox must proxy every host: curl `--noproxy ''`, Node `NO_PROXY=` plus `NODE_USE_ENV_PROXY=1` (Node 22.23 honours it; undici prints an "experimental" warning), Claude Code honours `HTTPS_PROXY` already. Pi itself runs outside srt and dials the broker directly.
3. **srt loses single quotes in a wrapped shell string** (`-H 'Authorization: Bearer x'` became three URLs). Anything we wrap must be a script file or a plain argv, never a quoted one-liner. Already true of the product's spawn path (SBX-02 wraps a command string from Pi; worth a regression test in CRB-03).

Not run: the real Codex turn with the owner's token. Needs the owner's explicit go; the natural venue is the first brokered turn through the deployed CRB-02 server with the owner's own sign-in, not the scratch container. **Go for CRB-02.**

Spike files (echo.mjs, broker.mjs, wrap.mjs, run.sh, sbx10.sh, Dockerfile.sbx10) lived in the session scratchpad and `~/sbx-10/spike` on the VM; the broker's shape (placeholder map, header + query expansion, request/response piping) seeds CRB-02. Clean-up: `~/sbx-10`, images `agent-deck-server:sbx10` and `:sbx10-base`, volume `sbx10-work` removed on the VM; production stack untouched. Commands used: `ssh dev 'bash ~/sbx-10/spike/sbx10.sh'` (docker build of the spike image, `docker run --rm --name sbx10 --hostname sbx10-broker --memory 3g --cpus 3 --pids-limit 4096 --read-only --cap-drop ALL --security-opt no-new-privileges:true --security-opt seccomp=~/sbx-10/deploy/seccomp.json --security-opt apparmor=agent-deck-sandbox --security-opt systempaths=unconfined --tmpfs /tmp:exec,size=1g -v ~/sbx-10/spike:/spike:ro --entrypoint bash agent-deck-server:sbx10 /spike/run.sh`), `docker run --rm --entrypoint sh agent-deck-server:sbx10 -c '<grep/sed in the srt dist>'`.
