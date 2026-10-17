---
id: ade-yp0q
status: closed
deps: [ade-vyov]
links: []
created: 2026-10-17T01:19:54Z
type: task
priority: 3
assignee: almoretti
parent: ade-1c88
tags: [shared-server, sandbox, testing]
---
# SBX-06: the stack matrix as a recurring gate

scripts/stack-matrix.mjs run on the VM against the sandboxed server: ten public repos (pnpm monorepo, python/uv, rust, go, java/gradle, rails, compose-backed app, playwright suite, static site, agent-deck-electron itself); for each, one scripted session: clone, install, run tests, start the dev server, commit a trivial change; output a pass/fail table with the failing command and the sandbox violation if any. Document the known hard limits (iOS/macOS builds, Windows targets, Android emulators, GPU, Docker inside) in the runbook as the line, not as failures.

## Acceptance Criteria

Table committed under docs/ with the first run's results; the script runs from one ssh command; failures have a one-line cause each.


## Notes

**2026-10-17T05:37:28Z**

2026-10-17 from SBX-04: srt's log monitor is off by default (AGENT_DECK_SANDBOX_MONITOR=1 turns it on): on the VM it doubled the cost of 10k small writes (144 -> 275 ms; off is the same as unsandboxed). With it off, refused writes produce no transcript line, refused hosts still do. The stack matrix should time one build per stack with the monitor on and off before anyone turns it on in production.

**2026-10-17T06:22:42Z**

2026-10-17 from SBX-04 review 1: (a) pids_limit 4096 on the agent-deck service is shared by the server and every session: one fork bomb in a session starves the server; there is no per-session cap yet. (b) Inside a sandbox the folders around the carved read-only entries (a worktree session's project root and .git, the owner dir) and /data itself are srt's writable tmpfs: a new file created there seems to succeed and vanishes at exit; srt does not mount them read-only. Keep the end-to-end denied-write check out of the project root (use an existing file such as <project>/.git/config).

**2026-10-17T07:31:47Z**

matrix run 1 (2026-10-17, VM, fresh volume): pnpm-monorepo (jkomyno/pnpm-monorepo-template): toolchain corepack enable --install-directory ~/.local/bin pass 1.3s; install pass 6.5s; test FAIL: tsdown mkdtemp /tmp EROFS (turbo strict env drops TMPDIR; /tmp read-only in the sandbox: policy gap); dev server pass; commit pass (visible outside); warm install monitor off/on 1.2s/1.4s. Monitor-on refusal: .git/hooks/pre-commit (lefthook postinstall), as designed.

**2026-10-17T07:32:13Z**

matrix run 1: python-uv (astral-sh/uv-fastapi-example): toolchain python3 -m venv ~/.local/uv-venv + pip install uv (PyPI only) pass 3.6s; install uv sync --frozen --python 3.12 pass 1.9s (grant releases.astral.sh for uv's managed CPython; repo quirk: without a pin uv picks 3.15 and httptools 0.6.1 fails to compile); test (import) pass; fastapi run on 8000 pass; commit pass; warm install off/on 0.4s/0.5s.

**2026-10-17T07:33:30Z**

matrix run 1: rust-cargo (tokio-rs/axum, examples workspace): toolchain rustup-init from static.rust-lang.org (default list; sh.rustup.rs is NOT on it, the runbook said it was) -y --no-modify-path --profile minimal pass 9s; cargo build -p example-hello-world pass 12.4s; cargo test -p example-testing pass 9s; cargo run on 3000 pass; commit pass; warm build off/on 7.8s/8.0s.

**2026-10-17T07:33:30Z**

matrix run 1: go (golang/example): toolchain go.dev/dl tarball into ~/.local/go pass 2.6s (grants go.dev, dl.google.com); go build pass 7.4s; go test pass 2.1s; helloserver on 8080 pass; commit pass; warm build (after go clean -cache) off/on 7.2s/7.6s.

**2026-10-17T07:37:06Z**

matrix run 1: java-gradle (spring-guides/gs-rest-service/complete): toolchain Temurin 17 tarball via api.adoptium.net into ~/.local/jdk pass 6.8s (grants api.adoptium.net, services.gradle.org, plugins.gradle.org, plugins-artifacts.gradle.org; srt injects its own JAVA_TOOL_OPTIONS proxy agent, so Gradle reaches the proxy); assemble pass 20.8s; test pass 31.3s; bootRun FAIL: Tomcat's createTempDirectory under /tmp, read-only in the sandbox (Java ignores TMPDIR: policy gap /tmp; monitor also shows /tmp/hsperfdata_agentdeck); commit pass; warm assemble off/on 4.3s/4.4s.

**2026-10-17T07:37:06Z**

matrix run 1: rails (wtnabe/example-rails7-sqlite3-solid-queue, Ruby 3.2.2): toolchain FAIL: rv-ruby's relocatable Ruby needs GLIBC 2.38, the image (bookworm) has 2.36; ruby/ruby-builder's Ubuntu 22.04 build runs but is not relocatable (RubyGems not found outside /opt/hostedtoolcache); ruby-build would need libyaml-dev and zlib1g-dev, not in the builder layer. Image gap; install/test/serve fail from it; commit pass.

**2026-10-17T07:37:06Z**

matrix run 1: compose-app (dockersamples/todo-list-app): compose.yaml (app + MySQL) is out (no Docker in a sandbox, hard limit); corepack enable yarn pass; yarn install --frozen-lockfile pass 5s (grants registry.yarnpkg.com, repo.yarnpkg.com: not in the default list); jest pass with SQLITE_DB_LOCATION in TMPDIR (repo quirk: default /etc/todos); node src/index.js on 3000 pass; commit pass; warm install off/on 1.4s/1.6s.

**2026-10-17T07:37:06Z**

matrix run 1: playwright (microsoft/playwright-examples): npm ci + playwright install chromium pass 7.7s (grants cdn.playwright.dev, playwright.download.prss.microsoft.com, playwright{,-akamai,-verizon}.azureedge.net, demo.playwright.dev, playwright.dev); 7 tests (api-mocking, clock) pass in Chromium only after pointing the browser at srt's proxy (Chromium ignores HTTP(S)_PROXY; without it every page.goto times out); boxed-steps skipped (repo quirk: its site is gone); show-report on 9323 pass; commit pass; warm 1.1s/1.1s.

**2026-10-17T07:37:06Z**

matrix run 1: static-site (11ty/eleventy-base-blog): npm ci pass 1.9s; build pass 2.1s; eleventy --serve 8080 pass; commit pass; warm 1.3s/1.3s. agent-deck-electron (HEAD): corepack pnpm 10.32.1; pnpm install --frozen-lockfile pass 11.4s (grant nodejs.org: node-gyp headers for node-pty, not in the default list); vitest packages/domain sandboxPolicy.test.ts pass; web vite on 5199 pass; commit pass; warm 3.7s/5.5s. All node stacks need NODE_ENV unset: the image's NODE_ENV=production reaches sessions and npm/pnpm/yarn skip devDependencies (server/image gap).

**2026-10-17T07:50:01Z**

ARCHITECT DECISION (review round 1): the matrix runs the sandbox-run CLI, not the server or Pi; that is accepted as the scope. docs/stack-matrix.md lists the differences from a session launch in 'What the matrix does not cover'.

**2026-10-17T08:08:42Z**

review round 1 pinned run (2026-10-17, image + AppArmor from a3656e8, HEAD's profile loaded as agent-deck-sandbox-matrix, fresh volume): exit 0, failures only the baselined ones (pnpm-monorepo test and java-gradle dev -> SBX-07 ade-c3aa; rails toolchain/install/test/dev -> SBX-08 ade-si3i); all other steps pass on all ten stacks; warm install off/on within 0.2 s except agent-deck-electron 4.9/6.1 s. VM cleanup confirmed (no sbx06 container/volume/image/profile, ~/sbx-06 gone).

**2026-10-17T08:23:51Z**

2026-10-17 CLOSED: merged 394a0f9 (squash e1d9c43). Reviews: GPT review71 full (exit code, pins, timeouts, signals, clean-step, fail-closed tests), contrarian (CLI-not-Pi scope accepted and documented, AppArmor from HEAD, guard rails, hygiene), review72 + review73 narrow (signature baseline, transport-over-marker, teardown retries, fallback only on sudo refusal, docs). Pinned run 1: 7/10 stacks pass every step; baselined: pnpm-monorepo/test + java-gradle/dev (SBX-07 ade-c3aa, read-only /tmp), rails x4 (SBX-08 ade-si3i, no Ruby). Gates: typecheck, format, lint, sandboxRun 17, matcher 6; the architect ran the gate for static-site from the merged checkout.
