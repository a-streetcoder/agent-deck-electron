---
id: ade-jx7e
status: in_progress
deps: [ade-vyov]
links: []
created: 2026-10-17T01:19:54Z
type: task
priority: 3
assignee: almoretti
parent: ade-1c88
tags: [shared-server, sandbox, security]
---
# SBX-05: credential masking through the sandbox proxy

srt credentials.envVars mode mask for the model keys and GH_TOKEN with injectHosts limited to the provider hosts; network.tlsTerminate on with the runtime's CA exported to the sandbox (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, GIT_SSL_CAINFO are set by srt); excludeDomains for pinned clients. Only after SBX-01 shows tlsTerminate stable on the VM; otherwise close as deferred with the evidence.

## Acceptance Criteria

A sandboxed shell cannot print a real key (env shows the sentinel) while model calls and gh still work; real-Pi suites green.


## Notes

**2026-10-17T10:17:39Z**

SPIKE setup (VM, 2026-10-17): image agent-deck-server:sbx05 built from 32a3b43, one container with the production security options (read-only, cap-drop ALL, no-new-privileges, deploy/seccomp.json, apparmor=agent-deck-sandbox, systempaths=unconfined, tmpfs /tmp), scratch volume. A node script drove the image's srt 0.0.80 directly (SandboxManager.initialize + wrapWithSandbox): network.tlsTerminate {excludeDomains:[example.com]} with an ephemeral CA, credentials.envVars mode mask for FAKE_MODEL_KEY (injectHosts: the echo server) and GH_TOKEN (injectHosts: echo, httpbin.org, api.github.com, github.com). Sentinel values only (sk-test-SENTINEL-1234, ghp_test_SENTINEL_5678); echo server = node HTTPS with a self-signed cert on the container IP (srt refuses loopback upstreams itself, and its NO_PROXY covers private ranges, so curl needed --noproxy '' and node NO_PROXY=). The proxy trusted the echo cert through the server process's NODE_EXTRA_CA_CERTS (srt appends it to its upstream trust).

**2026-10-17T10:17:39Z**

SPIKE (a)-(d) PASS. (a) env inside: FAKE_MODEL_KEY and GH_TOKEN = fake_value_<uuid>; NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, GIT_SSL_CAINFO, REQUESTS_CA_BUNDLE (and CURL_CA_BUNDLE, PIP_CERT, ...) = /tmp/srt-ca-*/trust-bundle.crt (MITM CA + system roots). (b) curl to the echo server: Authorization carries the REAL sk-test-SENTINEL-1234 and X-Gh the real GH value; to httpbin.org (not an inject host for the model key) the model key arrives as the fake_value sentinel while GH_TOKEN (inject host) arrives real: per-credential host gating works. (c) git ls-remote octocat/Hello-World and git clone --depth 1 sindresorhus/is (0.59 s) through the terminating proxy; gh api /rate_limit -> HTTP 401 Bad credentials from GitHub over HTTP/1.1 with Authorization: token <masked>. (d) node fetch (NODE_USE_ENV_PROXY=1), python3 urllib and requests (python3 -m venv + pip install requests through the proxy via PIP_CERT; uv is not in the image) all trust the CA and receive the injected value at httpbin.org.

**2026-10-17T10:17:49Z**

SPIKE (e) stability, node fetch inside the sandbox, 200 sequential + 20 concurrent per run. Local echo (container IP, sub-ms baseline): off 173/168 ms (0.85 ms/req), on 332/375 ms (1.77 ms/req): +0.9 ms per request, about +105% relative; concurrent 55/58 vs 75/65 ms; 0 failures. Remote speed.cloudflare.com/__down?bytes=1000, 5 interleaved runs each: off 8500/7528/6898/6761/7023 ms (median 7023), on 6595/6979/19708/7861/7961 ms (median 7861, +12%; the 19.7 s run is remote variance, an off run also took 22.1 s earlier); 0 failures in 2,000+ requests; concurrent 117-191 ms both ways. httpbin.org/get 4 runs: 0 failures off, 1 non-2xx on (status not captured, httpbin returns sporadic 5xx; not reproduced on Cloudflare). 50 MB: Cloudflare download 1.33 s off vs 1.26 s on; local download 0.11 s off vs 0.18 s on; local 50 MB POST 0.11 s off vs 0.20 s on, body intact (52428800 bytes) and the header injected. SSE (local, 5 events at 300 ms): streamed incrementally through the terminating proxy, 1-3 ms per event, not buffered.

**2026-10-17T10:17:50Z**

SPIKE (f) what breaks under tlsTerminate: WebSocket upgrades are refused (curl: Empty reply; 101 with termination off; srt: 'upgrade request refused, out of scope'); HTTP/2 is downgraded to HTTP/1.1 (ALPN forced: curl --http2 gets 1.1, 2 with termination off), so h2-only clients (gRPC) break; a client that ignores the exported CA vars (curl --cacert system bundle = a pinned client) fails on a terminated host (self-signed certificate in chain) and works on an excludeDomains host (example.com 200), where no injection happens; Basic auth is NOT substituted: curl -u x-access-token:$GH_TOKEN reaches the inject host as base64(x-access-token:fake_value_...), so git over HTTPS with Agent Deck's GH_TOKEN credential helper would send the sentinel (push and private fetch from inside the sandbox fail; gh, which sends 'Authorization: token', works).

**2026-10-17T10:18:00Z**

SPIKE blocker, srt 0.0.80 credential model vs a multi-user server (source: sandbox-manager.js sentinelRegistry, credential-mask-env.js buildMaskedEnvVars, credential-sentinel.js). The sentinel registry is ONE per server process, keyed by variable NAME, and the real value is read from the SERVER's process.env at wrap time, never from the command's env. Measured: (1) wrap A with GH_TOKEN=userA, then a wrap with GH_TOKEN=userB: A's sandbox still shows the same sentinel and the proxy injects userB's value at httpbin.org (every session shares one sentinel per name; the last wrap's value wins, so a session pushes and opens PRs with another user's token). (2) A token only in the spawn env (how githubEnv delivers each owner's GH_TOKEN) is not masked at all: env and egress show the real value. (3) With GH_TOKEN in the server env and the owner's in the spawn env, the sandbox gets the sentinel of the SERVER's token and the proxy injects the server's token instead of the owner's. Also: on the shared server the model credentials are per-user auth.json files (SRV-11), not env vars, and the global .env refuses provider key names, so env masking would cover almost nothing there.

**2026-10-17T10:18:00Z**

DECISION: deferred. tlsTerminate itself held up ((a)-(d) pass, no proxy failures, remote overhead +12% median, local +0.9 ms per request, i.e. above 25% only relative to a sub-ms baseline), but credential masking cannot ship as designed: srt 0.0.80's process-wide, name-keyed registry fed from the server's own env injects one user's (or the operator's) token into another session's requests and does not mask per-session values, and it breaks git's Basic-auth credential helper, WebSockets and HTTP/2. Options for a later ticket: one srt proxy per user (out-of-process srt, its own registry), an upstream srt change keying sentinels per command id with values from the wrap's env, or masking only server-wide values that are the same for every session (none today). Evidence written to docs/remote-server-poc.md Known gaps.
