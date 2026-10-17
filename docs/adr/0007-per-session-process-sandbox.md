# ADR 0007 — A process sandbox around every session

- Status: **Accepted** 2026-10-17 (owner `approved`; lane SBX, epic ade-1c88)
- Deciders: Ale (owner), architect session
- Related: [ADR 0003](0003-shared-server-trust-model.md) (trust model: named people behind Cloudflare Access), [ADR 0006](0006-session-record-and-provenance.md) (the session record, `workspace`), SRV-17 (the server as a container, ade-a105)

## Context

SRV-17 packaged the shared server as a hardened container: read-only root, no capabilities, non-root,
no published port, one `/data` volume. That is right for the control plane, and wrong as the place
where agents work: every session shares one process space and one fixed toolchain, an agent cannot
install what a project needs, a dev server it starts is unreachable, and a misbehaving session can
read every other session's files and the operator's credentials.

The owner's requirement is that a session can build **any stack**, with the **lightest** isolation
that still gives each session its own fence. Three tiers exist in October 2026:

| Tier                                                                                       | Start cost           | Per-session overhead     | Root inside | Any stack                           |
| ------------------------------------------------------------------------------------------ | -------------------- | ------------------------ | ----------- | ----------------------------------- |
| Process sandbox (bubblewrap + Landlock + seccomp; Anthropic `srt`, Zerobox, Fence, nsjail) | none                 | none                     | no          | host toolchains + per-user installs |
| Container per session (Sandcastle model, gVisor optional)                                  | seconds, image build | one image, one container | tamed root  | Dockerfile per project              |
| MicroVM per session (libkrun: Microsandbox, SmolVM; Docker Sandboxes)                      | 100–300 ms boot      | a kernel per session     | real root   | anything, Docker inside             |

The coding agents themselves (Claude Code, Codex CLI) moved to tier 1 in 2026. Measured on the VM
(Debian 13, kernel 6.12, Docker 26): unprivileged user namespaces work on the host for the plain
user, and inside a container they are blocked by Docker's default seccomp **and** AppArmor profiles;
they work only when both are replaced (`unshare -Ur` succeeds with both `seccomp=unconfined` and
`apparmor=unconfined`, fails with either alone). `cap_drop ALL`, `read_only` and the non-root user
do not interfere.

## Decision

1. **Every Pi process runs inside a process sandbox.** The wrap happens at the one spawn site,
   `PiProcess.start()` in `packages/pi-host`, behind a `SandboxProvider` with two
   implementations: `none` (today's behaviour; the default on a desktop and the only one on
   Windows) and `srt` (Anthropic's `@anthropic-ai/sandbox-runtime`, Apache-2.0, bubblewrap on
   Linux, Seatbelt on macOS, Node API `SandboxManager.wrapWithSandbox`). The shared server
   defaults to `srt`; a desktop may opt in. Sessions never see the provider; only the spawn does.

2. **The policy is derived from the session record, not configured per session.** From ADR 0006's
   `workspace` and the session's identity: write access to the worktree (or the project path when
   there is no worktree), the session's Pi session folder and its own scratch folder; everything
   else read-only; other users' folders under `/data/users` and the operator's `auth.json` denied
   for reading unless the session is the operator's. Network is allow-only: a server default list
   (the model providers the install uses, `github.com`, the package registries of the common
   stacks) extended by the project's `.agent-deck/sandbox.json` (`allowedDomains`,
   `allowLocalBinding`). The policy is a pure function in `packages/domain`
   (`sandboxPolicy(record, side, project)`), tested like `allowedOperations`.

3. **Any stack without images.** No per-project Dockerfile, no rebuilds. Toolchains that install
   into the home folder (rustup, uv, nvm, sdkman, pipx, go tarballs) work as the user and persist
   in `/data/home` across sessions. The server image gains a builder layer (compilers, headers,
   Python 3, the libraries Playwright's browsers need) so the common stacks need nothing more.
   `apt` is not available to sessions; a stack that needs a system package is a change to the
   image, reviewed like code. The agent can change what it needs for the next session by editing
   `.agent-deck/sandbox.json`; the change applies when the session's Pi process restarts.

4. **Violations are visible, not silent.** A denied write or a refused host becomes a
   `sandbox.violation` session event rendered as a system line in the transcript, with the path
   or host. The owner or operator can add a host to the project's allow-list from that line.

5. **Credentials.** First release: as today, model and GitHub credentials are environment
   variables of the Pi process; the sandbox does not change that. Second release: `srt`'s
   credential masking (`credentials.envVars` mode `mask`, injected by the proxy on egress to the
   listed hosts) so secrets never sit in the sandbox. It depends on `network.tlsTerminate`, which
   the runtime marks experimental; it ships when the spike shows it stable.

6. **Deployment.** The server container keeps `cap_drop ALL`, `read_only`, the non-root user and
   no published port, and gains two files in `deploy/`: a seccomp profile (the Docker default
   plus the syscalls user namespaces need) and an AppArmor profile that grants `userns`. The image
   gains `bubblewrap`, `socat` and `ripgrep`. If the spike (SBX-01) cannot make `srt` run fully
   inside the container with those profiles, the fallback is the server as a user unit on the host
   from the same release, with the container kept as the packaging; `enableWeakerNestedSandbox`
   is not an accepted fallback (it drops the namespaces the fence is made of).

## Alternatives considered

- **A container per session (Sandcastle's model).** Sound and simple, but heavier than needed
  for a trusted team: an image per project, a daemon the server must reach (the Docker socket in
  the server container, or a launcher sidecar), and no on-the-fly installs without root inside.
  Kept as the second provider if a project needs Docker inside or the team stops being trusted.
- **MicroVMs (libkrun, Docker Sandboxes).** The strongest fence and real root, at the cost of a
  kernel per session and a KVM dependency. Not lighter, which was the requirement. Same provider
  interface; added when needed.
- **Zerobox or Fence instead of `srt`.** Same primitives (Zerobox repackages Codex's sandbox
  crates with Rust, TypeScript and Python SDKs and its own credential proxy; Fence is Go, inspired
  by `srt`). `srt` is chosen for its Node API inside our Node spawn path, its violation store,
  and its credential masking design. If its beta config format moves under us, Zerobox is the
  drop-in.
- **Leave the server as the only boundary.** Rejected: it protects the VM from the server, not
  one session from another, and it caps what a session can build.

## Consequences

- Lane SBX (epic SBX-00): SBX-01 spike on the VM (profiles, `srt` inside the image, stack smoke,
  overhead) (done), SBX-02 `SandboxProvider` and `sandboxPolicy` with tests (done), SBX-03 server
  and web wiring (defaults per side, `.agent-deck/sandbox.json`, violation events and the
  allow-host action) (done), SBX-04 image, profiles, Compose and runbook (done; the production
  deploy is separate), SBX-05 credential masking, SBX-06 the stack matrix as a recurring gate.
- The Windows desktop keeps `none` (the runtime's Windows support is alpha and needs an elevated
  install). macOS and Linux desktops may opt in through a setting later.
- `docs/remote-server-poc.md` "Security model" gains the per-session boundary; the Known gaps
  list loses "sessions share the server's filesystem" (done, SBX-04).

## Amendments (2026-10-17, from the SBX-01 spike and its contrarian pass)

1. **Not one spawn site.** On the shared server, Pi is not the only process that runs code from a
   worktree: the Loop engine's validation commands, the script runner and the terminal do too.
   All of them go through the same `SandboxProvider`, with a permissive policy where the session's
   needs it. The profiles that enable user namespaces are not deployed before that is true,
   because they hand namespace capabilities to every unwrapped process in the container.
2. **The tool bridge leaves the network.** Pi's bridge extension called the server on
   `127.0.0.1:<port>/bridge`; a sandbox has its own network namespace and must never be allowed
   to reach the server's port. A Unix socket is not an option either: on Linux the runtime's
   seccomp helper blocks `AF_UNIX`, and the switch that allows it drops the helper, and with it
   the nested-namespace block. The bridge therefore rides on Pi's own stdio: the extension issues
   an `extension_ui_request` (method `input`, a fixed title marker, the request as JSON) and the
   server answers with the matching `extension_ui_response`. No token, no port, no socket, the
   same on a desktop and on the server, inside or outside a sandbox.
3. **Per-session state leaves `/tmp`.** Bridge extensions, prompt files and the session's
   temporary files live under `<dataDir>/sandbox/<sessionId>/`, with a per-session `TMPDIR`;
   `/tmp/claude`, which the runtime hard-codes, stays shared and is kept out of any code path.
4. **Per-project network lists are registered per wrap** (`registerCommandNetworkLists`); the
   runtime's per-call config alone does not enforce them. The project's `sandbox.json` is read
   from the base branch, not from the worktree the agent edits.
5. **Deployment detail.** The container also needs `systempaths=unconfined` (bubblewrap mounts a
   fresh `/proc`); the AppArmor profile carries deny rules for the paths Docker masked, is
   installed under `/etc/apparmor.d` so it survives a reboot, and seccomp refuses
   `NETLINK_NETFILTER` sockets. Measured: user namespaces cannot be scoped to bubblewrap alone
   under `no-new-privileges`, so wrapping every spawn (item 1) is the control.

## Amendments (2026-10-17, from the SBX-03 implementation and its reviews)

6. **The project's allow-list is server state; `sandbox.json` proposes.** Decision 2 and amendment 4
   had the policy read `.agent-deck/sandbox.json` from git. A worktree session can write the
   common `refs` and `objects` (it commits), so `git replace`, a planted pack or a moved branch
   change what git returns for the recorded base commit; sessions without a worktree can move
   `HEAD`. The hosts a project may reach are therefore kept by the server
   (`<dataDir>/sandbox-hosts.json`, keyed by project id, changed only through the owner or
   operator routes `POST`/`DELETE /sessions/:id/sandbox/allowed-hosts`). The repository file is
   still read at the base commit, with replacement objects disabled, but only to propose: a listed
   host that is not granted appears in the transcript with the same Allow action. The server never
   writes the repository file (an uncommitted file blocked merges as a dirty parent).
7. **Server git hardening is scoped to sandboxed servers.** With `none` there is no fence to
   protect and the hardened environment would drop a desktop user's global identity and
   credential helper. Under `srt` every server git call runs with no global or system config,
   `core.fsmonitor=false`, `core.pager=cat`, `core.sshCommand=ssh` (`GIT_SSH_COMMAND` in the
   environment still wins) and `GIT_NO_REPLACE_OBJECTS=1`; hooks stay disabled per call.
8. **Bridge interception and its limit.** Bridge calls are taken out of the Pi event stream in
   the one place every spawn goes through (`spawnPiProcess`), bound to the session and the launch
   generation that spawned the process; a call from a process of an earlier launch is refused.
   Any process inside the same sandbox can write to Pi's stdout and forge a call for that same
   session; this is accepted (it is no wider than the token file was) and it never crosses
   sessions. Files the server writes for a launch (prompts, extensions) live under
   `<dataDir>/sandbox/<id>/launch/`, read-only to the session.
9. **Write roots are contained.** The policy refuses a write root that equals or contains the
   data directory or the Pi agent directory, and a sandboxed server refuses a session whose
   working folder is outside a registered project or one of its worktrees. One-shot helpers run
   under a per-run policy with their own scratch folder and emit no violation events.

## Amendments (2026-10-17, from the SBX-04 deployment and its reviews)

10. **The provider is chosen by a probe, not by presence.** On a shared server the default is `srt`
    only when a real sandboxed `/bin/true` succeeds at startup; otherwise `none` with a loud warning.
    An explicit `AGENT_DECK_SANDBOX=srt` fails closed when the probe fails, and an explicit `none`
    under the user-namespace profiles is warned about: those profiles make an unsandboxed container
    weaker than Docker's defaults, so the Compose security options go with the provider.
11. **Reads are carved around writes.** The runtime re-binds read-only any readable folder that
    contains a writable one, so a worktree session could not commit. The provider lists such a
    folder once per wrap and binds its entries separately, never an entry at or under a write root
    (the write bind covers it), never an entry the policy denies for reading inside that folder
    (an allowRead entry would cancel the deny), and at most 200 entries. The carved parent is a
    tmpfs the runtime does not mount read-only: a new name there accepts a write that never
    reaches the host. A denied write is therefore demonstrated on an existing file.
12. **Write violations are visible only with the monitor.** The runtime's log monitor costs about
    88% on small writes, so it is off by default (`AGENT_DECK_SANDBOX_MONITOR=1` turns it on).
    Refused hosts always produce a transcript line; refused writes produce one only with the
    monitor, and the tool error the agent sees is the signal otherwise. Decision 4 is read with
    this limit.
13. **Code-bearing entries of a user's agent folder are quarantined, not trusted.** The runtime
    protects what a link points at, not the link, so a session can replace a protected link in
    its own user's agent folder. Before each reporting launch on a sandboxed server a real file or
    folder found in place of a protected link is moved aside (`<name>.quarantined-<timestamp>`)
    and the link recreated, with a violation line. Accepted residual: a user's sessions can still
    plant code for that same user's other running sessions; cross-user planting is prevented.
14. **Server git under `srt` has a default identity and no automatic maintenance.** Ownerless
    commits are made as `Agent Deck <agent-deck@localhost>`; `gc.auto=0` and
    `maintenance.auto=false` keep the server from rewriting `packed-refs` under a session's frozen
    per-file view.
15. **The seccomp profile drops the 32-bit ABIs.** libseccomp rewrites a socket rule into an
    unrestricted `socketcall` for the i386 ABI, which reopened `NETLINK_NETFILTER`; the profile
    keeps x86_64 only, with non-overlapping `socket` allow rules (all families except
    `AF_NETLINK` protocol 12 and `AF_VSOCK`) and the default `EPERM` for the rest. The AppArmor
    profile denies every write under `/proc/sys/kernel/` except `shm*`.

## Amendments (2026-10-17, from the SBX-06 stack matrix, SBX-07)

16. **A sandbox's `/tmp` is its own.** Tools that ignore `TMPDIR` (the JVM, turbo's strict env)
    failed on the read-only `/tmp`. On the server the policy asks for a private `/tmp`
    (`privateTmp`); srt on Linux gets a read-deny of `/tmp`, which it mounts as an empty writable
    tmpfs per wrap, and the provider binds this srt's proxy sockets and its write monitor's
    socket folder back into it by their exact paths (srt restores `/tmp/claude` itself, still
    shared as amendment 3 says). srt has no option to bind the session's folder there instead;
    `TMPDIR` stays that folder. The private `/tmp` belongs to one wrap: Pi (and what it runs),
    each terminal, each validation command and each script get their own, and Pi's is lost when
    it relaunches; what is written under `TMPDIR` persists on disk. The tmpfs is in memory, has
    no size (srt passes none) and counts against the container's limit, so every wrapped command
    raises its OOM score to 1000 and dies before the server; macOS keeps the host's `/tmp`.
17. **The default list covers the common stacks' toolchains.** Decision 2's default list also
    holds the toolchain downloads and registries the matrix needed (Node headers, yarn, RubyGems,
    uv's Python, rustup, Go and its checksum database, Gradle, Temurin, Playwright's current
    browser CDNs). It limits accidental reach; it is not an exfiltration control.
18. **The server's own env stays with the server.** On every host (the shared server and a
    desktop alike), a session's launch env leaves out the server process's `NODE_ENV` and `PORT`
    unless the project's `.env` or the launch env sets them: a user's exported `NODE_ENV` no
    longer reaches Pi, nor the desktop launcher's `PORT=0`. The terminal and the script runner
    drop both always (their blocklist).

## Amendments (2026-10-18, from the SBX-05 spike)

19. **Credential masking (decision 5, second release) is deferred.** The runtime's masking is
    sound for one user: the sandboxed environment shows placeholders, the proxy injects the real
    value on egress to the listed hosts, TLS termination costs about 12% on remote requests and
    streams SSE. It is unusable on a shared server as built: the placeholder registry is one per
    server process, keyed by variable name, and takes its values from the server's own
    environment, so two sessions with different `GH_TOKEN`s receive one placeholder and the last
    value wins, and a token present only in a session's spawn environment (how each owner gets
    theirs) is not masked at all. Termination also refuses WebSocket upgrades, downgrades HTTP/2,
    breaks clients that ignore the exported CA, and does not substitute basic auth, which git's
    credential helper uses. Credentials stay environment variables of the Pi process (first
    release of decision 5). Masking returns when the runtime keys placeholders per command and
    reads values from that command's environment, or with one proxy per user outside the server
    process; the evidence is on ade-jx7e and in the runbook's Known gaps.

20. **Assigned MCP servers are reachable.** The hosts of a project's assigned HTTP MCP servers
    (All Projects and per-project assignments, as the server resolves them at launch) join the
    project's allowed hosts without an Allow click. Found 2026-10-17 in the browser: a session
    with an assigned HTTP server showed "Sandbox refused: network to <mcp host>" and "MCP servers
    need attention" at launch, and the agent had no tool. An assignment is the owner's or
    operator's own intent to reach that host, the same trust as the allow-list, which stays
    server state. Stdio servers contribute nothing; a server's URL change takes effect at the
    next launch. `mcpServerHosts` in `apps/server/src/sandbox.ts`.
