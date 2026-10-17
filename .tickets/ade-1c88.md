---
id: ade-1c88
status: open
deps: []
links: []
created: 2026-10-17T01:19:52Z
type: epic
priority: 1
assignee: almoretti
tags: [shared-server, sandbox]
---
# SBX-00 (epic): a process sandbox around every session (ADR 0007)

Lane SBX. Every Pi process runs inside a process sandbox (bubblewrap/Landlock/seccomp via a SandboxProvider; srt first, Zerobox as the alternative), with a policy derived from the session record, visible violations, any-stack toolchains via per-user installs and a builder layer in the image, and the server container relaxed only where user namespaces need it. ADR: docs/adr/0007-per-session-process-sandbox.md.

## Acceptance Criteria

SBX-01..SBX-06 closed; deck.moretti.cc sessions run sandboxed; the stack matrix passes; ADR 0007 Accepted.


## Notes

**2026-10-17T01:31:57Z**

2026-10-17 ADR 0007 and the SBX tree approved by the owner ("make sense approved"). SBX-01 started.

**2026-10-17T06:54:17Z**

2026-10-17 DEPLOYED: production stack on the VM rebuilt from a846d15 (image ghcr.io/a-streetcoder/agent-deck-server:local, APP_VERSION poc-a846d15) with deploy/compose.yaml + seccomp.json in ~/agent-deck, AppArmor profile agent-deck-sandbox loaded from /etc/apparmor.d, .env gained AGENT_DECK_SANDBOX_DENY_ADDRESSES (VM public IP). Startup probe chose srt ('[sandbox] provider srt'); docker inspect: seccomp + apparmor + no-new-privileges, MaskedPaths/ReadonlyPaths empty, pids_limit 4096; health green; tunnel reconnected. Fresh volume kept. OWNER end-to-end on deck.moretti.cc (needs a signed-in session): a denied host (e.g. curl example.org) shows 'Sandbox refused: network to host' with Allow; allowing writes <dataDir>/sandbox-hosts.json and works after the session's Pi restarts; a write to an existing file outside the worktree (e.g. <project>/.git/config) is refused (no transcript line unless AGENT_DECK_SANDBOX_MONITOR=1); a worktree session can commit. Remaining lane: SBX-05 ade-jx7e (credential masking, needs tlsTerminate spike), SBX-06 ade-yp0q (stack matrix; notes on pids_limit and tmpfs parents).

**2026-10-17T09:13:24Z**

2026-10-17 from SBX-07 review (ade-c3aa): srt 0.0.80 mounts a sandbox's private /tmp (a read-deny tmpfs) without --size, so it is bounded only by the container's mem_limit; the provider raises oom_score_adj to 1000 as a stopgap. Ask srt upstream for a tmpfs size option (or a bind-source option, which would let /tmp be the session's folder on disk).

**2026-10-17T09:32:57Z**

2026-10-18 REDEPLOYED: production stack rebuilt from 6ff9d9c (SBX-06 + SBX-07 in the image: sandbox-run CLI, private per-wrap /tmp, oom_score_adj, default toolchain hosts, NODE_ENV/PORT stripped). compose.yaml and seccomp.json refreshed in ~/agent-deck; .env unchanged. Owner end-to-end checks from the previous note still apply; additionally a session's Scope: all 15 workspace projects
 WARN  There are cyclic workspace dependencies: E:\AI Playground\a-streetcoding\agent-deck-electron\packages\contracts, E:\AI Playground\a-streetcoding\agent-deck-electron\packages\domain; E:\AI Playground\a-streetcoding\agent-deck-electron\packages\pi-host, E:\AI Playground\a-streetcoding\agent-deck-electron\packages\testkit
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 745ms using pnpm v10.32.1 now keeps devDependencies and Java/turbo builds work.

**2026-10-17T10:04:01Z**

2026-10-18 REDEPLOYED: production rebuilt from ade290c (SBX-08: Ruby per user, ~/.bundle writable, cache.ruby-lang.org; ade-zzrp new-chat fix already live). Lane SBX now has one open ticket, SBX-05 ade-jx7e.

## Browser verification 2026-10-17 (architect, deck.moretti.cc, owner's browser)

Ran the end-to-end checks myself. Four defects found and fixed on the way, each
deployed and re-checked (commits 9d649d9, d8b29a0, 8b32c4e, bdc00eb, 1fee302, 6d80a54):

1. **New chat on load still refused** — `findOrCreateSession` (page activation,
   agent switch) bypassed the ade-zzrp fallback; routed through `createChatSession`,
   which now also reuses the project's open draft instead of creating one per load.
2. **Every launch died: `pi exited (code=1)`** — (a) the server did not log Pi's
   stderr on a failed start (now `[sessions] session start failed: ... (stderr: ...)`
   with the whole capture); (b) cause 1: `packages: ["npm:pi-claude-bridge"]` in the
   shared settings.json made Pi install into the read-only `agent/npm` (EROFS) —
   removed by hand on the VM, backup `settings.json.bak-ade-sbx-packages`, follow-up
   SBX-09 (ade-91rh); (c) cause 2: the injected commands under
   `/data/injected-commands` were read-denied inside the sandbox ("Extension path
   does not exist") — `launchReadPaths(plan)` now re-allows the extensions, skills
   and prompt templates every spawn names (parent, helpers, children, one-shot).
   No session had launched in production since the SBX deploy (ade290c).
3. **"Sandbox refused: network to pi.dev" on every first launch** — Pi 1.2's model
   catalog refresh; `pi.dev` added to DEFAULT_SANDBOX_DOMAINS.
4. **Terminal commit failed "unable to auto-detect email"** — the terminal env had
   the typing user's GitHub connection but not their git identity (no global
   gitconfig on the server); same rule as the Git screen now.

Checks that pass (session terminal inside the sandbox, operator session,
CrunchyMurmur, no model available: Claude subscription out of extra usage, Codex
models refused for a ChatGPT account):
- denied host: `curl https://example.org/` → rc=56, transcript line "Sandbox refused:
  network to example.org" + "Allow example.org for this project" button; allowed host
  `registry.npmjs.org` → 200.
- `.git/config` write → "Read-only file system"; a project file write → ok;
  `/data/sessions.json` and other data-dir files → not visible; `/tmp` writable;
  TMPDIR=`/data/sandbox/<id>/tmp`; NODE_ENV and PORT empty.
- worktree session: cwd `/data/session-worktrees/<id>`, branch
  `agent-deck/session-<id>`, `.git` file read-only, `git commit` lands as
  `alemoretti <alemoretti@hotmail.com>` (after fix 4); deleting the session removed
  the checkout, the branch and the sandbox folder.
- devDependencies: npm `production=null`, `omit` empty, NODE_ENV empty; `pnpm` is not
  on PATH but `corepack pnpm` works (docs/stack-matrix.md recipe); `~/.local/bin`
  is not on the session PATH (follow-up, below).

Still the owner's: the Allow button itself (my browser session was not allowed to
click it) and a model-driven turn (needs a provider with quota). Test sessions
deleted; the owner's draft of 09:43 UTC kept.

Follow-ups noted, not scheduled: `$HOME/.local/bin` on the session PATH (pipx, uv,
corepack install dir); SBX-09 (ade-91rh).

## Full functional run 2026-10-17 (architect, deck.moretti.cc, CrunchyMurmur, owner's browser)

Owner asked for every feature exercised for real, not screens. Model path: the Claude
bridge cannot run on the server (no Claude Code in the image, PRV-02 ade-81m8); runs used
openai-codex/gpt-6-luna (the only Codex model the ChatGPT account accepts) and the app
default model was set to `openai-codex:gpt-6-luna` via PATCH /settings (left in place).

Fixed and deployed during the run (commits 47ba86b, c258665, fe5cf44): bridge default refused when Claude Code is missing (PRV-02 guard);
store fan-out skill links resolved before the launch plan (assigning an app-created
skill broke every new session); pinned launches prefer the app default model (a Loop
maker landed on a catalog model the account refuses).

PASS (real effect verified on the VM or in the transcript): new chat/draft/worktree
toggle; first prompt + streamed reply + title; stop a running bash tool + follow-up;
rename, pin, fork (provenance card), ?session= links, unknown link; bash tool; file edit
+ Changed files diff; protected writes refused (.git/config, /etc), data dir invisible,
denied host line + Allow button; Files panel (README preview); Checkpoints rollback
(CONTEXT.md reverted on disk); terminal; agent create -> file -> session obeys prompt on
its model, final system prompt dialog; skill create -> assign -> agent reads it (after
fix); prompt create/edit -> /qa-echo expands and fires; loop create -> run -> maker +
goal evaluator SUCCESS, artifacts on disk, Open Session, child card; Git screen AI
message + Commit all (commit as the owner; push skipped on purpose); subagent spawn +
await + child transcript dialog; ask_user card round trip; command palette; theme
switch persisted and restored; Memory/Models/Providers/Doctor/MCP/Extensions/
Performance render; add project from URL (server clone); worktree session: agent commit
as the owner; session delete removes worktree + branch + sandbox folder.

FOUND (tickets): ade-81m8 PRV-02 (image has no Claude Code; guard fixed, image + sign-in
owner's); ade-3q16 re-run / Pi restart loses the model chosen in the chip; ade-lgde
Prompt and Loop editors drop characters under fast input; ade-v3zw project-scoped
screens unreachable on the server (Instructions > Project, Issues copy); ade-2qxj
projects: no Remove in the UI, DELETE leaves the clone, Add dialog stays open; ade-d4ec
small UX findings (ask_user timeout, compact feedback, draft reuse, nav aria names,
Doctor copy, dangling skill links, palette entries, legacy loops); ade-91rh SBX-09.

NOT RUN: merge/PR from a worktree session (would push to GitHub), image attach (file
picker), provider sign-in sheet, MCP import, delegation cancel, keybindings editor.

Cleanup: test sessions deleted (incl. the 09:43 draft that New chat had reused), test
commit reset (`git reset --hard origin/main` in the clone), Hello-World clone removed,
agent/skill/prompt/loop qa-* deleted through the UI. Loop artifacts left in
/data/loop-artifacts (two small runs).

## Fix round + MCP, Environment, Doctor (2026-10-17, later)

Fixed and deployed: ade-3q16 (re-run keeps the chip model; rebound session launches on it),
ade-yu35 (skill delete unlinks the fan-out), ade-v3zw (Instructions project picker, Issues
copy, Doctor gh copy), ade-2qxj (Add dialog closes), ade-d4ec (ask_user 280 s default,
compact toast, own-draft reuse, Doctor copy). MCP tested for real: assigning cloudflare-docs
(HTTP, no auth) to the project, the session's Pi hit "Sandbox refused" for the MCP host; fixed
by ADR 0007 amendment 20 (assigned HTTP MCP hosts join the grants); after the deploy the agent
called search_cloudflare_documentation inside the sandbox and got results. Open: ade-sgw1
(MCP SDK 1.12.1 output-schema warning), OAuth remote MCP sign-in (owner: the cloudflare
server has a sign-in on file; the check froze my browser once — re-check by hand).
Environment: project variable set in the UI, seen by a fresh session's bash, deleted, .env
removed. Doctor on the server now adds: process sandbox, Claude Code for the bridge, your
GitHub connection, your git identity, data volume free space; verified on deck.moretti.cc.
Cleanup: test sessions deleted, cloudflare-docs unassigned, test variable removed.
