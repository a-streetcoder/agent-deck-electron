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

