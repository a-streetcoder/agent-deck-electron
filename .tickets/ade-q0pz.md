---
id: ade-q0pz
status: in_progress
deps: []
links: []
created: 2026-10-15T19:10:48Z
type: bug
priority: 0
assignee: claude
tags: [security, shared-server]
---
# FINAL-fix: dispositions of the risk-focused review (review45) before the push

The final cross-vendor review of poc/shared-server (GPT, trust boundaries only; ade-s625) returned 2 blockers and 5 should-fix findings; all seven were verified against HEAD by the architect and are accepted. Fix every item; keep each change minimal and add one regression test per item in the existing test file for that module. (1) BLOCKER apps/desktop/main.js validatedResourceFile + resources:openFile/revealFile: in remote mode (remoteServer set) the catalog that authorizes shell.openPath comes from the server, so a compromised server can list any local executable and open it. Refuse both IPC handlers whenever remoteServer is set (the files live on the VM anyway); web shows nothing or a disabled action. (2) BLOCKER apps/server/src/sessionTransfer.ts createTransferWorktree (~751-761) runs gitWorktreeAdd (git.ts ~684) and gitResetMixedTo with hooks enabled; a returned snapshot plus a repository-relative core.hooksPath runs post-checkout code on the device. Run every git command of the transfer paths (worktree add, reset, fetch, merge) with -c core.hooksPath= (empty) like gitRestoreSnapshotInPlace does; test the fallback worktree path with a hook that would fail the test if executed. (3) apps/server/src/routes/sessionShare.ts POST /sessions/:id/share/abort is served on the shared server although preflight/share are refused there: member A can end or delete another member's prepared return. Return 404/409 when ctx.sharedServer (the return flow has its own owner/operator-checked abort). (4) apps/desktop/main.js ~1221-1228 attach(): the onBeforeSendHeaders listener adds cf-access-token only for the Access host but never strips it from a request to another host after a redirect. Add a second listener on <all_urls> that deletes cf-access-token when the URL host is not the Access host; unit-test the header logic by extracting it to a pure function. (5) apps/server/src/git.ts gitPush (~1824) and routes/git.ts push/commit routes: authenticated pushes run with hooks enabled and return raw git/hook stderr. Run with -c core.hooksPath= and pass the error text through redactSecrets (and the injected token value if available) before sending it to the renderer. (6) apps/desktop/shared-server.js ~203-215: the token is redacted in the raw text before JSON.parse, so a \uXXXX-escaped copy survives into the renderer. After parsing, walk the parsed value and replace the token in every string and key; keep the raw-text pass; regression test with an escaped token. (7) apps/server/src/sessionMirror.ts SECRET_KEY (~28) matches exact names only, so { database_password: ... } passes redactDeep. Match a secret word as a suffix of the key (e.g. ^[A-Za-z0-9_-]*?(?:token|secret|password|passwd|pwd|authorization|cookie|api[_-]?key|apikey|private[_-]?key|credentials?)$ keeping the exact list) and test a qualified key.

## Design

Worktree E:\agent-deck-wt\<ticket>; single test files only (apps/desktop node --test shared-server.test.js and a main.js helper test if one exists, apps/server test/sessionMirror.test.ts, test/sessionShare.test.ts or sessionMove.test.ts, test/sessionReturn.test.ts, test/git*.test.ts); no builds, no full suites, no Playwright, no real-Pi tests. Docs: one line in docs/remote-server-poc.md Security notes per item that changes behaviour (remote-mode resource actions refused; abort refused on the shared server). Use file-edit tools, never heredocs; check for control characters after editing.

## Acceptance Criteria

Each of the seven items has a regression test that fails on HEAD and passes after; node --test apps/desktop/shared-server.test.js and the touched vitest files pass; typecheck of apps/server and apps/web clean; scripts/check-design-system.mjs and prettier clean on changed files; a second GPT pass on the diff of this ticket reports no remaining blocker; ade-s625 note records the disposition of all seven.


## Notes

**2026-10-15T19:11:39Z**

2026-10-15 owner approved (exact word) all seven items. Dispatched in worktree E:\agent-deck-wt\ade-q0pz (wt/ade-q0pz).

**2026-10-15T19:26:58Z**

2026-10-15 round 1 (a389707) reviewed: GPT second pass (review47) NOT READY: blocker = transfer cleanup (discard, update-ref) still runs hooks; should-fix = tokenless shared-server pushes keep hooks, commit route returns raw hook stderr, revealArtifacts/revealWorktree IPCs still take server paths in remote mode, resource test exercises only the helper. Fix round 2 sent to the developer; contrarian pass still running.

**2026-10-15T19:31:23Z**

2026-10-15 contrarian on a389707: no blocker; confirmed with git 2.48 that -c core.hooksPath=<empty dir> outranks repository config and that the sessionReturn test fails on base for the right reason; should-fix: hook-free pushes skip git-lfs pre-push (LFS pointers without objects), drop:classifyPaths and the reveal IPCs still take server paths in remote mode, SECRET_KEY misses AWS_SECRET_ACCESS_KEY/passwordHash/DATABASE_URL, items 1 and 4 tested only through helpers, docs bullet overclaims. All folded into fix round 2. Owner live check before shipping remote mode: WebSocket connects and a forced cross-host redirect arrives without cf-access-token (Electron behaviour not testable here).

**2026-10-15T19:48:54Z**

2026-10-15 round 2 (fb9c637) verified by GPT (review49): cleanup hooks, tokenless push, remote guard order and resource test check out; NOT READY: new blocker = the snapshot capture (temporary index read-tree/add) still runs hooks; should-fix = release push/rollback hook-enabled on the shared server, synchronization.blocker.message unredacted, LFS check only on the current checkout and bypassed by transfer pushes, KEYED_SECRET not extended like SECRET_KEY. Fix round 3 sent.

**2026-10-15T19:58:28Z**

2026-10-15 round 3 (e2f4423): snapshot capture (gitWorkTreeCommit, also checkpoints) under withoutHooks; release fetch/status/tag push/rollback hook-free on the shared server (no LFS refusal for releases: the push is leased to a commit the remote has); fetch-failure text redacted at the source; gitPushCarriesLfs scans checkout + HEAD + up to 200 outgoing commits; moves/returns of LFS checkouts refused; KEYED_SECRET extended. Round 4 sent: preflight reports lfs instead of refusing, dialog falls back to conversation-only.

**2026-10-15T20:07:35Z**

2026-10-15 round 4 (704c492): preflight reports lfs, dialog offers the conversation-only move, snapshot share and return refused. Final verification (review50) NOT READY: blocker = gitSharePlan status and gitWorkingTreeClean in the in-place restore can refresh the index with hooks on; should-fix = LFS range scan fails open (no upstream, >200 commits), snapshot transfers skip history/untracked LFS detection and detection errors pass, connection-string values only partly redacted, a styling assertion in the web test. Round 5 sent (attribute-aware range scan, fail-closed detection, check-attr on consented untracked files, whole-value redaction for connection strings). Reviewer's accidental server-suite run showed two return timeouts and two Windows symlink-permission failures: environmental on this machine, to be confirmed on the owner's full run.

**2026-10-15T20:17:20Z**

2026-10-15 round 5 (5e4038d): share-plan status and in-place restore clean check hook-free (mtime-touch tests); gitCarriesLfs: checkout + consented untracked (check-attr) + tip + every outgoing commit touching an attributes file (no cap; range upstream..HEAD or tip --not --remotes), fail-closed with its own refusal text; assertNoLfs on gitPush/gitPushBranch; prepareSessionExport runs the full detection before gitPushTransfer (share and return); CONNECTION_SECRET redacts whole connection-string values; styling assertion dropped. Verification review51 launched.

**2026-10-15T20:21:11Z**

2026-10-15 review51 on 5e4038d: no blocker; two should-fix (merge-only attributes missed by the path-limited log without -m; backslash ends an unquoted connection-string value). Round 6 sent; after it the ticket merges and any further reviewer item becomes a follow-up note.
