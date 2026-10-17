---
id: ade-c3aa
status: closed
deps: []
links: []
created: 2026-10-17T07:43:05Z
type: sandbox
priority: 2
assignee: almoretti
parent: ade-1c88
---
# SBX-07: policy gaps from the stack matrix — writable /tmp per session, default hosts, NODE_ENV

From SBX-06 run 1 (docs/stack-matrix.md). (1) /tmp is read-only inside a sandbox and Java (Tomcat) and turbo's strict env ignore TMPDIR: bind the session's own tmp folder (<dataDir>/sandbox/<id>/tmp) over /tmp inside the sandbox (srt bind/tmpfs option; keep /tmp/claude working) so TMPDIR-ignoring tools work and nothing is shared; test on the VM with the java-gradle and pnpm-monorepo stacks. (2) DEFAULT_SANDBOX_DOMAINS gains the toolchain and registry hosts the matrix had to grant: nodejs.org, registry.yarnpkg.com, repo.yarnpkg.com, rubygems.org, index.rubygems.org, releases.astral.sh, static.rust-lang.org, sh.rustup.rs, go.dev, dl.google.com, services.gradle.org, plugins.gradle.org, plugins-artifacts.gradle.org, api.adoptium.net, the Playwright download hosts; corpus test updated. (3) The server's session launch env must not carry the image's NODE_ENV=production (npm/pnpm/yarn skip devDependencies): strip it (and any other image-only variable) when building a session's env; test. (4) Runbook: Chromium ignores the proxy env, point Playwright at srt's authenticated proxy (one documented line). Re-run the matrix after.


## Notes

**2026-10-17T07:50:02Z**

2026-10-17 from the SBX-06 reviews: when the server stops passing NODE_ENV into session envs, also remove the NODE_ENV unset in scripts/stack-matrix.mjs and drop the pnpm-monorepo/test and java-gradle/dev entries from scripts/stack-matrix.baseline.json once the /tmp bind makes them pass.

**2026-10-17T09:30:01Z**

2026-10-18 CLOSED: merged b23bf99 (squash 3f5ff5c). Reviews: GPT review74 full (tmpfs cap -> oom_score_adj mitigation, terminal/script NODE_ENV, socket contract test), contrarian (exact socket binds, monitor socket hidden under private /tmp, OOM, docs), review75 narrow (monitor folder race -> fail closed when the monitor is requested). Deviation accepted: /tmp is a per-wrap tmpfs (srt has no bind-onto-/tmp), TMPDIR stays on disk; ADR 0007 am. 16-18. Matrix: only rails baselined (SBX-08). Gates: typecheck, format, lint, 8 single files green. Redeploy of production follows this close.
