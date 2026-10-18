# The stack matrix (SBX-06)

What a session can build inside its process sandbox (ADR 0007), proved on ten public stacks.
It is the gate after any change to the sandbox, its policy, the `deploy/` profiles or the image:
run `node scripts/stack-matrix.mjs --host dev` from a clean checkout
([runbook](remote-server-poc.md#the-stack-matrix-gate)). It exits non-zero when a step fails
that `scripts/stack-matrix.baseline.json` does not list, or when a step is skipped for budget;
each listed failure names its follow-up ticket and the error text it must show (a timeout or a transport error on a listed step still fails), and one that starts passing is reported as
"fixed, remove from baseline". It also fails when `HEAD`'s AppArmor profile cannot be loaded for
any reason other than `sudo -n` refusing (only then does it fall back to the installed profile,
and say so), and when its teardown leaves anything behind on the host (it lists what, and keeps
the local logs).

How it runs: the script ships `HEAD` to the host, builds `agent-deck-server:sbx06`, loads `HEAD`'s
AppArmor profile as `agent-deck-sandbox-matrix`, and starts one container with the production
security options (`--read-only`, `--cap-drop ALL`, `no-new-privileges`, `deploy/seccomp.json`,
that profile, `systempaths=unconfined`, 3 GB, 3 CPUs, 4096 pids) on a scratch `/data` volume. It
lays each stack out as the server would: a project fetched at a pinned commit under
`/data/projects` and a session worktree under `/data/session-worktrees`, made unsandboxed as the
server makes them. Every step then runs inside that session's sandbox through the image's
`sandbox-run` CLI (`dist/server/sandbox-run.mjs`), which derives the policy with the server's own
`sessionSandbox()` for a session owned by a user who is not the operator, and chooses the
provider with the server's startup probe. No model and no credentials are involved. The dev
server is started and probed with `curl` from the same sandbox (another sandbox is another
network namespace); any HTTP status below 500 passes. The commit is checked from outside, on the
branch in the project's repository. "Warm install" is the install step run again after removing
what it built (`node_modules`, `target`, `.venv`, the Go build cache, `./gradlew clean`), first
with `AGENT_DECK_SANDBOX_MONITOR=1`, then without; the column shows off / on.

## Pinned run (2026-10-17)

VM `dev` (Debian 13, kernel 6.12, Docker 26), image and AppArmor profile from `c74b8c2` (SBX-08:
`libyaml-dev` and `zlib1g-dev` in the builder layer, `cache.ruby-lang.org` on the default host
list), fresh volume (every toolchain and package cache cold). The matrix grants only the two
sites the Playwright suites visit and Playwright's older CDN names. Exit status 0 with an empty
baseline: every step of every stack passes. About eight minutes with the image's layers cached,
of which a minute and a half is Ruby's compile (a cold image build adds about fifteen).

| Stack               | Repo @ commit                                         | Toolchain versions                                              | Toolchain  | Install    | Test       | Dev server | Commit | Warm install off / on |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------- | ---------- | ---------- | ---------- | ---------- | ------ | --------------------- |
| pnpm-monorepo       | jkomyno/pnpm-monorepo-template @ 44f0f92              | pnpm 11.3.0 (packageManager)                                    | pass 1.3s  | pass 6.2s  | pass 4.0s  | pass 2.3s  | pass   | 1.1s / 1.3s           |
| python-uv           | astral-sh/uv-fastapi-example @ a1e3131                | uv 0.13.1, CPython 3.12 (uv's)                                  | pass 3.6s  | pass 1.9s  | pass 1.1s  | pass 2.4s  | pass   | 0.4s / 0.5s           |
| rust-cargo          | tokio-rs/axum @ fc78d5b (`examples/`)                 | rustup 1.29.1, Rust 1.99.1                                      | pass 8.3s  | pass 11.4s | pass 9.1s  | pass 2.4s  | pass   | 7.9s / 8.1s           |
| go                  | golang/example @ 7f05d21                              | Go 1.27.2                                                       | pass 2.4s  | pass 7.6s  | pass 1.9s  | pass 2.3s  | pass   | 7.5s / 7.9s           |
| java-gradle         | spring-guides/gs-rest-service @ 3f4cef0 (`complete/`) | Temurin 17.0.20.1+1, Gradle 9.3.1 (wrapper)                     | pass 6.9s  | pass 22.0s | pass 31.6s | pass 6.5s  | pass   | 4.3s / 4.3s           |
| rails               | wtnabe/example-rails7-sqlite3-solid-queue @ 5c1f2a4   | Ruby 3.2.2 (ruby-build 20261013), Bundler 2.4.10 (Gemfile.lock) | pass 88.3s | pass 15.7s | pass 2.1s  | pass 2.4s  | pass   | 14.5s / 15.1s         |
| compose-app         | dockersamples/todo-list-app @ 5a6fbf5                 | yarn 1.22.22                                                    | pass 0.7s  | pass 5.0s  | pass 1.7s  | pass 2.4s  | pass   | 1.4s / 1.5s           |
| playwright          | microsoft/playwright-examples @ 4eb82ae               | @playwright/test 1.45.0 (package-lock) and its Chromium         | image      | pass 7.5s  | pass 2.9s  | pass 2.4s  | pass   | 1.1s / 1.2s           |
| static-site         | 11ty/eleventy-base-blog @ cf0cc1f                     | Eleventy (package-lock)                                         | image      | pass 1.9s  | pass 2.1s  | pass 2.4s  | pass   | 1.4s / 1.5s           |
| agent-deck-electron | this checkout (`HEAD`)                                | pnpm 10.32.1 (packageManager)                                   | pass 1.2s  | pass 12.1s | pass 1.5s  | pass 2.4s  | pass   | 4.9s / 6.0s           |

The run before SBX-08 (`b2681f5`) failed every rails step but the commit (no Ruby ran, see
Findings), baselined. The run before SBX-07 (`a3656e8`) also failed pnpm-monorepo's test and
java-gradle's dev server on a read-only `/tmp`, and needed the toolchain hosts as grants and
`NODE_ENV` unset.

What still does not run as the project has it:

- compose-app's `compose.yaml` itself is out (no Docker inside, a hard limit); the app runs on
  its SQLite fallback.

Steps: install `pnpm install --frozen-lockfile` / `uv sync --frozen --python 3.12` /
`cargo build -p example-hello-world` / `go build ./...` / `./gradlew assemble` /
`bundle install` / `yarn install --frozen-lockfile` / `npm ci && npx playwright install chromium`
/ `npm ci`; test `pnpm build && pnpm test` / an import of the app / `cargo test -p example-testing`
/ `go test ./...` / `./gradlew test` / `bin/rails test` / `yarn test` (jest) / two Playwright suites
in Chromium / `npm run build` / one vitest file (`packages/domain/test/sandboxPolicy.test.ts`); dev
server Vite, `fastapi run`, `cargo run`, `go run`, `bootRun`, `rails server`, `node src/index.js`,
`playwright show-report`, `eleventy --serve`, the web app's Vite. The exact commands, commits and
versions are the `STACKS` table in `scripts/stack-matrix.mjs`.

The monitor (`AGENT_DECK_SANDBOX_MONITOR=1`) cost little on these installs: at most 0.2 s on
the installs under two seconds (python-uv's 0.4 to 0.5 s is at the timer's 0.1 s resolution),
at most 5% on the Rust, Go and Gradle builds, and 22% on agent-deck-electron (4.9 s to 6.0 s,
about 1,000 packages linked; 24% in the run before, 49% in the first, unpinned run). It is still
off by default; turn it on only if refused-write lines are worth that on the team's own stacks.

## The brokered turn (CRB-03)

The last row, `brokered-turn`, is not a stack: it checks a brokered session's network (ADR 0007
amendment 21). `sandbox-run --broker <ip>:<port>` derives the policy a shared-server session
gets with the credential broker: that literal allowed, no provider host, and a loopback-only
`NO_PROXY` set in front of the command (srt's own, with the private ranges, would win otherwise).
No server runs in the matrix container, so the setup starts a stand-in on the broker's port
4211 that answers 404, as the broker does for an unknown session or token; the address is the
container's (`docker inspect`). Steps, in one session's sandbox: `providers-refused` (`curl` to
`https://api.openai.com/` and `https://api.anthropic.com/` fails, `registry.npmjs.org` answers)
and `broker-404` (plain `curl` to `http://<ip>:4211/<session>/<bad token>/openai/...`
answers 404 through srt's proxy). It prints one line under the table. The owner's real brokered
turn (a Codex reply, `[broker] openai-codex POST 200` in the server log, the spend line) stays
the browser check on the deployed server; the row does not run the broker itself.

## What the matrix does not cover

The matrix runs the `sandbox-run` CLI, not the server or Pi (accepted as its scope). Against a
real session launch it differs in:

- The owner's environment: no `gitIdentityEnv`, `githubEnv` or `envFileLayer`. The commit's
  identity comes from `git -c user.name`, and nothing is pushed with credentials.
- No quarantine of the user's agent-dir entries and no real session id behind the policy.
- No `report` launch: the project's `sandbox.json` is not read and no proposals are shown.
- No launch `tempPaths` or Pi `sessionDir`: the policy has no bridge-extension or prompt folders,
  and Pi's session folder is derived from the worktree as for a new session.
- Commands run as `/bin/sh -c`, not through Pi's bash tool.
- The container is on Docker's default bridge network, not `network_mode: service:net` beside
  `cloudflared`.
- No `AGENT_DECK_SANDBOX_DENY_ADDRESSES` (only the private ranges are refused).
- 3 GB and 3 CPUs, where production Compose gives 4 GB and 2 CPUs.

## Toolchains that installed as the user

Into `/data/home` (shared by every user's sessions, kept across container replaces), from inside
a sandbox. The commands are the pinned ones the matrix runs:

| Toolchain           | Command                                                                                                                                                                                                                                                                                                                                                                    | Hosts it needs (default list since SBX-07, unless noted)                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm, yarn          | `corepack enable --install-directory ~/.local/bin` (then `pnpm`/`yarn` on `PATH`; `corepack pnpm` alone leaves turbo unable to find pnpm); yarn classic pinned with `corepack install -g yarn@1.22.22`                                                                                                                                                                     | yarn: `registry.yarnpkg.com`, `repo.yarnpkg.com`                                                                                                                                                                                        |
| uv                  | `python3 -m venv ~/.local/uv-venv && ~/.local/uv-venv/bin/pip install uv==0.13.1 && ln -s ~/.local/uv-venv/bin/uv ~/.local/bin/uv` (PyPI only; the astral.sh installer is not needed)                                                                                                                                                                                      | `releases.astral.sh` (uv's managed CPython)                                                                                                                                                                                             |
| Rust                | `curl -fsSLo $TMPDIR/rustup-init https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-unknown-linux-gnu/rustup-init`, check its SHA-256 (the Dockerfile's `RUSTUP_SHA256`), then `rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.99.1`                                                                                                       | `static.rust-lang.org`, `static.crates.io`, `index.crates.io` (`sh.rustup.rs` serves the installer script)                                                                                                                              |
| Go                  | `curl -fsSL https://go.dev/dl/go1.27.2.linux-amd64.tar.gz \| tar -xz -C ~/.local` (`GOROOT` `~/.local/go`, `GOPATH` `~/go`)                                                                                                                                                                                                                                                | `go.dev`, `dl.google.com`                                                                                                                                                                                                               |
| Java 17 (Temurin)   | `curl -fsSLo $TMPDIR/jdk.tgz https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz && tar -xzf $TMPDIR/jdk.tgz -C ~/.local/jdk --strip-components=1` (`api.adoptium.net`'s "latest" also works)                                                                                           | the JDK from GitHub's release assets (`*.githubusercontent.com`); the Gradle wrapper needs `services.gradle.org`, plugins need `plugins.gradle.org`, `plugins-artifacts.gradle.org`                                                     |
| Playwright Chromium | `npx playwright install chromium` (into `~/.cache/ms-playwright`; the version follows the lockfile's `@playwright/test`)                                                                                                                                                                                                                                                   | `cdn.playwright.dev`, `playwright.download.prss.microsoft.com`; older releases also `playwright.azureedge.net`, `playwright-akamai.azureedge.net`, `playwright-verizon.azureedge.net` (not on the default list: the matrix grants them) |
| Ruby                | `curl -fsSLo $TMPDIR/ruby-build.tgz https://github.com/rbenv/ruby-build/archive/refs/tags/v20261013.tar.gz`, check its SHA-256 (the matrix's rails stack), unpack it into `$TMPDIR`, then `RUBY_CONFIGURE_OPTS=--disable-install-doc MAKE_OPTS=-j3 $TMPDIR/ruby-build-20261013/bin/ruby-build 3.2.2 ~/.local/ruby` (about 85 s on 3 CPUs; Ruby 3.2.2 ships Bundler 2.4.10) | the ruby-build tarball from `github.com` (`codeload.github.com`); `cache.ruby-lang.org` for Ruby's sources (default list since SBX-08); `rubygems.org`, `index.rubygems.org` for gems                                                   |

Put the folders on `PATH` in the session: `~/.local/bin`, `~/.cargo/bin`, `~/.local/go/bin`,
`~/go/bin`, `~/.local/jdk/bin`, `~/.local/ruby/bin`. Native npm modules built from source
(node-pty here) also need `nodejs.org` for node-gyp's headers (on the default list too). A project grants only what is
specific to it: the matrix grants only the two sites the Playwright suites visit and Playwright's
older CDN names.

## Findings for follow-up

- **`/tmp` was read-only inside a sandbox** (policy gap, fixed in SBX-07). The provider points
  `TMPDIR` at the session's own folder, but tools that ignore it or lose it failed: every JVM
  (`java.io.tmpdir` is `/tmp`; Spring Boot's embedded Tomcat could not start), and any Node tool
  run under turbo's strict environment (tsdown's `mkdtemp`). A server session's `/tmp` is now its
  own: the policy's `privateTmp` makes the provider read-deny `/tmp` on Linux, which srt turns
  into an empty writable tmpfs, with srt's `/tmp/claude` (still shared) and its proxy sockets
  bound back (srt has no bind option for another source; without the sockets the sandbox has no
  network). It lasts as long as the wrap: Pi and its commands share it, a terminal or a
  validation command gets its own. `TMPDIR` still points at the session's folder on disk; the
  tmpfs has no size of its own and counts against the container's memory. Not on macOS, where
  Seatbelt has no tmpfs.
- **`NODE_ENV=production` reached every session** (server/image gap, fixed in SBX-07). The image
  sets it for the server; sessions inherited it, so `npm ci`, `pnpm install` and `yarn install`
  skipped devDependencies and nothing built. A session's launch env (and `sandbox-run`'s) now
  leaves out the image's `NODE_ENV` and `PORT` (the server's 4200, which a dev server reading
  `PORT` would take) unless the project's `.env` or the launch env sets them; the rest of the
  image's env only names the server's and Pi's files. The matrix no longer unsets it.
- **Hosts the common stacks need that the default list lacked** (policy gap, fixed in SBX-07):
  `nodejs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com`, `rubygems.org`, `index.rubygems.org`,
  `releases.astral.sh`, `sh.rustup.rs`, `go.dev`, `dl.google.com`, `services.gradle.org`,
  `plugins.gradle.org`, `plugins-artifacts.gradle.org`, `api.adoptium.net` (for its "latest"
  links), Playwright's current download hosts (`cdn.playwright.dev`,
  `playwright.download.prss.microsoft.com`) and `sum.golang.org` are now on
  `DEFAULT_SANDBOX_DOMAINS`, and the matrix no longer grants them; Playwright's older
  `*.azureedge.net` CDN names stay a project grant. GitHub's release downloads were already
  covered by `*.githubusercontent.com`.
- **No Ruby** (image gap, fixed in SBX-08): rv's relocatable rubies need glibc 2.38 (the image
  is Debian 12 with 2.36); ruby/ruby-builder's Ubuntu 22.04 build starts but is not relocatable
  (RubyGems is looked for under `/opt/hostedtoolcache`); `ruby-build` compiles, but psych and
  zlib need `libyaml-dev` and `zlib1g-dev`. Both are now in the builder layer (about 0.6 MB
  unpacked, 0.3 MB compressed; the image stays at 345 MB compressed against the 400 MB gate),
  and `cache.ruby-lang.org` is on the default list, so a Ruby compiles per user with
  `ruby-build`. The base stays Debian 12: rv's rubies still do not run.
- **Bundler's cache in the home** (fixed in SBX-08's review): `~/.bundle` joined the home's writable
  toolchain folders (`SANDBOX_HOME_TOOLCHAIN_DIRS`), so `bundle install` keeps its compact-index
  cache across installs; the run-1 table above predates that change (its rails install showed
  about 190 refused writes with the monitor on, all under `~/.bundle`).
- **Firefox and WebKit** (image choice): the builder layer ships the libraries Playwright's
  Chromium needs only; Firefox and WebKit need more system libraries, which is a change to the
  `Dockerfile`, not a limit of the sandbox. Not run here.
- **Browsers ignore the proxy variables** (sandbox limit with a workaround): the only way out of a
  sandbox is srt's authenticated proxy, and Chromium does not read `HTTP(S)_PROXY`, so every
  `page.goto` to the network times out. Tests that leave the machine need
  `use.proxy = { server, username, password }` from `HTTPS_PROXY`; tests against a local server
  are unaffected. The one line for a project's config is in the
  [runbook](remote-server-poc.md#toolchains-per-user) (SBX-07).
- **Monitor lines that are noise**: with the monitor on, harmless refused writes show up as
  transcript lines: pnpm's link probe at `/_tmp_*`, yarn's global folders `~/.yarn` and
  `/usr/local/bin`, cargo's jobserver `/dev/fd/5`, the JVM's `/proc/self/coredump_filter`,
  Ruby's thread names `/proc/self/task/*/comm`, and lefthook's hook install into the project's
  `.git/hooks` (refused as designed).

Worked around in the matrix, not sandbox matters: uv picks CPython 3.15 when unpinned and
`httptools` 0.6.1 does not compile there (pinned to 3.12); axum's examples are their own workspace
(`dir: examples`); the todo app stores SQLite in `/etc/todos` by default (`SQLITE_DB_LOCATION`
set); Playwright's `boxed-steps` suites target a site that no longer answers (only `api-mocking`
and `clock` run).

## Known hard limits

These are the line, not failures to fix: a session runs as an unprivileged user in a namespace
on a Linux x64 host, without nested namespaces, devices or a container runtime.

- iOS and macOS builds (Xcode, `xcodebuild`, code signing): Apple toolchains run only on macOS.
- Windows targets that need Windows (MSVC, MSBuild, signing with Windows tools, running `.exe`
  tests); cross-compiling with a Linux toolchain (Go, Rust with a Windows target, mingw) is fine.
- Android emulators: no `/dev/kvm` and no nested virtualisation. Gradle builds of an Android app
  without an emulator should work with the SDK installed per user (untested).
- GPU work: no GPU device is passed into the container or the sandbox.
- Docker inside: no daemon, no socket, no namespaces for a nested runtime. `docker compose up` is
  out; run the app's own processes directly and replace its services with in-process or embedded
  ones (SQLite for MySQL here), or point it at a service outside with a granted host.
- System packages: no `apt` (no root, read-only root filesystem); a stack that needs one is a
  change to the `Dockerfile`, reviewed like code.
