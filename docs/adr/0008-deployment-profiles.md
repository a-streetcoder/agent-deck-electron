# ADR 0008 — Deployment profiles: one fact for "desktop or shared server"

- Status: **Accepted** 2026-10-17 (owner: "let's implement one for real and then in the future we can reassess")
- Deciders: Ale (owner), architect session
- Related: [ADR 0003](0003-shared-server-trust-model.md) (the shared host as a supported deployment),
  [ADR 0006](0006-session-record-and-provenance.md) (record side),
  [ADR 0007](0007-per-session-process-sandbox.md) (the sandbox runs on the server),
  `docs/remote-server-poc.md` (the live setup)

## Context

The desktop app and the shared server are one codebase: the same Node backend and React UI run
under different conditions. The differences are decided at runtime by flags checked wherever a
behaviour needs to differ. On 2026-10-17 there were 43 reads of `ctx.sharedServer` across
fifteen server files (all set from `trustedProxy !== null`), 13 reads of the sandbox provider in
`server.ts`, three separate `trustedProxy ? "server" : "local"` derivations of the record side,
and in the web `isElectron()`, `isMacDesktop()`, `teamServer()` and the capabilities object from
`/settings`. Nothing lists the divergences as a set, tests exercise one mode, and a fix for one
product changes the other quietly. The functional run of 2026-10-17 found this both ways:
desktop fixes shipped to the server for free, and a server-only project picker appeared on the
desktop unreviewed.

"Are we splitting the server from the desktop?" has two honest answers: split the packages (a
core plus two hosts), or keep one codebase and make the profile explicit. The owner chose the
second, to be reassessed later.

## Decision

1. **One profile, resolved once.** `resolveProfile(env)` in `apps/server/src/profile.ts` returns
   `desktop` or `shared-server` (today: a trusted proxy configured means shared server), the
   proxy configuration and the record side. `server.ts` derives `sharedServer`, the record side,
   the sandbox choice and the context from it. The startup log prints
   `[profile] <profile> (trusted proxy <team domain>), sandbox <provider>`.
2. **The web gates on the same fact.** `/settings` capabilities carry `profile`; the store keeps
   it; a screen that differs by product reads the profile, not a proxy of it. `isElectron()`
   stays for what is truly Electron-only: webviews, file pickers, native attention, window chrome.
3. **Every divergence is a listed decision.** The matrix below is the list. A new branch on the
   profile adds a row in the same change; a row without a reason is a bug to remove.
4. **Both profiles are tested.** The key route tests run under both profiles (PRF-02 adds the
   harness parameter); a matrix row without a test under both is incomplete.

## Behaviour matrix (as of 2026-10-17)

| Area                                                            | Desktop                                   | Shared server                                                                                            | Why                                      |
| --------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Identity on requests                                            | none                                      | Access-verified user on every request and RPC upgrade                                                    | ADR 0003                                 |
| Record side (`location.kind`)                                   | `local`                                   | `server`                                                                                                 | ADR 0006                                 |
| Session creation                                                | any folder                                | inside a registered project only; the project selector is the draft card                                 | ADR 0007 (write roots)                   |
| Sandbox                                                         | `none` unless `AGENT_DECK_SANDBOX` is set | `srt` required; an explicit `none` warns                                                                 | ADR 0007                                 |
| Pi agent dir                                                    | the user's `~/.pi/agent`                  | a per-user dir under the data dir, shared entries linked                                                 | SRV-11                                   |
| Git identity                                                    | global gitconfig                          | the session owner's identity in the Pi env; the typing user's in the terminal and the Git screen         | SRV-04                                   |
| GitHub                                                          | the host's `gh` login                     | a per-user connection under Providers; pushes and Issues run as the connecter                            | SRV-06                                   |
| Provider credentials in Environment                             | allowed                                   | refused (`PROVIDER_CREDENTIAL_ENV_KEYS`)                                                                 | credentials live in the user's agent dir |
| Host launchers (terminal in its own window, editor open)        | allowed                                   | refused; the terminal runs inside the session sandbox                                                    | SRV-09                                   |
| Share, move and return of sessions                              | available                                 | refused ("already on a shared server"); device-only routes answer 409                                    | SRV-12                                   |
| Project removal                                                 | Hide unregisters                          | creator or operator only; the clone stays on disk (open, ade-2qxj)                                       | SRV-12a                                  |
| Analytics                                                       | opt-in                                    | off, notice marked seen                                                                                  | ANA-01                                   |
| Doctor                                                          | runtime checks                            | plus the sandbox, Claude Code for the bridge, your GitHub connection, your git identity, the data volume | 2026-10-17                               |
| Doctor and Issues copy for `gh`                                 | "run gh auth login"                       | "connect GitHub under Providers"                                                                         | SRV-06                                   |
| MCP assignment network                                          | not applicable                            | assigned HTTP MCP hosts join the sandbox grants                                                          | ADR 0007 am. 20                          |
| Instructions project scope                                      | the sidebar's project                     | the screen's own picker                                                                                  | ade-v3zw                                 |
| New chat without a project                                      | a project-less draft                      | the only project, or pick; own drafts reused                                                             | ade-zzrp                                 |
| Web: browser panel, drop of files and folders, native attention | Electron                                  | placeholder; images only; none                                                                           | truly Electron-only                      |

## Alternatives considered

- **Split into packages** (a server core, a desktop host, a shared-server host). Structurally
  honest, but it duplicates the surface that is identical today, which is almost everything, and
  the matrix would still be needed to say what differs. Reassess when the matrix stops fitting
  one page, or when one host needs code the other must not ship.
- **Leave the flags.** Rejected: that is the state that produced the unreviewed divergences.

## Consequences

- Lane PRF (epic ade-qpt0): PRF-01 ade-4koj (this change: the module, the derivations, the
  capability, the matrix), PRF-02 ade-lqmw (move the existing `sharedServer` reads to
  `ctx.profile` and run the key route tests under both profiles), PRF-03 ade-7w6y (web gates on
  the store profile; `isElectron()` only for Electron-only features; tests for the web rows).
- `docs/remote-server-poc.md` keeps the live setup; this ADR keeps the list of differences.
