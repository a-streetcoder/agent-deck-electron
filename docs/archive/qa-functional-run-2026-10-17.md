# Agent Deck functional checklist — browser run 2026-10-17 (deck.moretti.cc, project CrunchyMurmur)

Legend: [ ] todo · [x] pass · [!] bug found (ticket/fix) · [-] not runnable here (why)

## A. Sessions and chat

- [x] A1 New chat draft: project picker, agent picker, worktree toggle, draft retained on reload
- [x] A2 (gpt-6-luna; claude account out of usage) First prompt launches Pi (claude-bridge model); streamed reply renders; title auto-generated
- [ ] A3 Model switch mid-session (Codex) and thinking level change take effect
- [x] A4 (stop aborted a running bash tool; follow-up answered) Stop/abort a running turn; follow-up while streaming (queue modes: steer / follow-up)
- [~] A5 (rename + pin pass; delete and search pending) Rename, pin, delete session; search sessions by title/content
- [x] A6 (fork pass; ?session= link opens the session; re-run: see finding) Copy link (?session=) opens that session; Re-run a prompt; Fork from a message (provenance card)
- [ ] A7 Compact context; context % indicator
- [x] A8 (rows are event-log entries, one per event, by design) Activity list ("needing attention"), member filter

## B. Tools inside a turn

- [x] B1 bash tool: ls / git status in the project (sandbox allows); output rendering
- [x] B2 read + edit a project file (write root); Changed files panel shows the diff
- [x] B3 write outside the write root is refused and reported (transcript violation line)
- [ ] B4 Ask-user decision card (agent asks a question; answer controls)
- [ ] B5 Attach file by path (@ files) and a pasted image; sent image gallery
- [ ] B6 Slash commands: /compact, injected command (optimize-agents-md), prompt template

## C. Panels (toolbar)

- [x] C1 Files panel (browse project tree, open file)
- [x] C2 Changed files (diff view)
- [x] C3 (rollback reverted CONTEXT.md on disk, Changes 0) Checkpoints (create, list, restore)
- [ ] C4 Preview and Browser toggles
- [ ] C5 Terminal (done 2026-10-17: pass)

## D. Worktree and merge

- [ ] D1 Worktree session: Pi commits on the session branch (identity = owner)
- [ ] D2 Merge flow on the shared server: push + pull request (MergePullRequest), merge cleanup

## E. Screens

- [~] E1 (add from repository URL: cloned to /data/projects/Hello-World and listed; the Add dialog stays open after success; remove: see note) Projects: list, add from repository URL (server clone), share control, remove
- [x] E2 (agent created, file on disk, session ran on the agent model and obeyed its prompt) Agents: list, create/edit (AgentEditor, final system prompt dialog), run a session with an agent
- [x] E3 (skill created, assigned, read by the agent from its real folder after the fan-out fix; bug fixed) Skills: list, enable/assign to project, import preview
- [x] E4 (prompt created in prompt-library, /qa-echo expands from the composer autocomplete and the agent obeys; edit + save work) Prompts: list, search, copy; use a template from the composer
- [~] E5 Extensions (list + toggles render), Instructions (Global/Project tabs render; edit pending) (AGENTS.md edit), Memory
- [~] E6 (MCP screen lists servers with toggles; import panel not exercised) MCP: list, import panel
- [~] E7 (Models and Providers screens render with real catalog and sign-in state; default model change via PATCH works) Models and Providers screens (status, no secrets), Provider login sheet
- [x] E8 (status, AI commit message, Commit all: commit 7958c9d landed as alemoretti; push not run on purpose: would publish to GitHub main) Git screen: status, AI commit message, commit, push (clicker identity)
- [ ] E9 Issues screen (GitHub issues of the project)
- [x] E10 (loop qa-loop created, run failed on the catalog pin (fixed), retry completed: maker + goal evaluator SUCCESS, artifacts and manifests on disk, Open Session works) Loops screen (list; create a loop only if cheap)
- [x] E11 (Nord applied and persisted as selectedThemeID, Default restored; Performance screen renders; Team server screen: not in nav) Performance, Team server, Themes screens render; theme switch persists

## F. Shell and navigation

- [x] F1 (ctrl+k opens the palette with commands; keybindings editor not opened; note: no palette entry for the Themes/Performance/Models screens) Command palette (keyboard), keybindings editor
- [ ] F2 Onboarding overlay dismiss persists; analytics notice
- [x] F3 (unknown ?session= lands on the project draft) Deep link to an unknown session recovers to a new chat

## G. Orchestration

- [x] G1 (subagent spawn, result card, await_subagents, Deck card, child transcript dialog all work) Orchestrator agent spawns a child (subagent); child card, child transcript dialog
- [x] G2 (ask_user card with Red/Blue, Answer -> agent replied Blue; sidebar attention item "Question · ..." shown; plan panel not exercised) Session plan panel (plan with nodes), human node (ask user) round trip
- [ ] G3 Delegation cancel

## H. Server-specific

- [ ] H1 GitHub connection card (status only), Share project control
- [ ] H2 Sandbox allow-host button (owner), violation lines
- [ ] H3 Session move/return UI is hidden or sane on the server

## Findings log

- [!] A6/A3 Re-run from a message ignores the model selected in the chip: with gpt-6-sol selected, "Re-run from this message" relaunched on claude-opus-4-8 (the session's launch plan model) and failed with the Claude usage error (request req_011Cg8JShPupxyiWnWmWrkPE). Expected: re-run uses the current model. Desktop likely affected (same wsBridge/server path).
- [-] A2 claude-bridge: works mechanically, but the Claude account the server is logged into answers 400 "You're out of extra usage" (claude.ai/settings/usage). Owner's account state, not a bug.
- [!] A3 follow-up: after the re-run relaunched Pi, the model chip still showed gpt-6-sol but the next NEW message also went to claude-opus-4-8 (req_011Cg8Ja6DYuofQJaff5acwi): a live model switch is lost when Pi restarts (session failure, re-run) and the chip is not refreshed from the relaunched Pi's state. Expected: the switch persists in the session record (launch plan override) or the chip follows Pi.
- note B3: a write to a NEW file in the operator's own agent dir root (/data/home/.pi/agent/check.txt) succeeds: by design (agentDir is a write root except the protected entries). Re-checked against .git/config, /etc and a data-dir read instead.
- [!] A2 (corrected): the Claude turn did NOT go through the bridge. The container has no Claude Code executable, so the bridge is never available on the server; the launch guard let a claude-bridge default through and Pi fell back to the Anthropic sign-in (the forbidden route). Ticket PRV-02; guard fix in progress; image + sign-in is the owner's.
- note: native window.confirm() in Composer (compact), SessionsPanel (delete) and NodeTreeView blocks browser automation; overridden in-page for the run. Not a bug for users.
- [?] A8 clicking an Activity row did not open its session (the draft stayed selected); re-check once.
- note: app default model set to openai-codex:gpt-6-luna via PATCH /settings for the run (was unset; Pi default claude-fable-5 cannot run on the server, PRV-02).
- [~] A7 compact at 3% ctx: no visible effect and no feedback (Pi has nothing to compact; the button re-enables after 15 s). Minor UX: say "nothing to compact". Layout jumped once right after (composer mid-screen, empty area below); not reproduced after reload.
- [?] boot on the server lands on the project draft instead of the newest session (the page-activation fallback resumes the draft); desktop picks the newest project-less session. Check the boot path.
- boot decision: landing on the project draft at boot on the shared server is kept (the newest session may be another member's; a boot resume would wake their Pi, same rule as ?project= links). Not a bug.
- note: navigator.clipboard.readText() freezes automation (permission prompt); Copy link verified by the ?session= deep link instead.
- note: the shared skills folder on the VM (/data/home/.pi/agent/skills) is full of symlinks to the owner's desktop paths (/c/Users/alemo/.agents/skills/...), dangling in the container; the Skills screen showed "No skills found". Data hygiene of the copied agent dir, plus: the app could flag dangling links.
- [!] E3 BUG: assigning the app-created skill qa-greet to the project breaks every new session: "A required launch resource could not be read safely." The store writes the skill at ~/.agents/skills/qa-greet and links ~/.pi/agent/skills/qa-greet to it; the launch plan carries the link path and fingerprintLaunchResources refuses symlinks. Desktop affected (same store). Fix: canonicalize candidate paths (realpath) before the plan.
- [?] New chat reuses the project's open draft even when another member created it (my fallback); restrict to own drafts.
- [?] E4: the saved prompt body lost one character ("rompt qa-echo fired" instead of "Prompt ..."): the typed text was "Reply with exactly this sentence and nothing else: Prompt qa-echo fired, Quartz." Could be an automation typing race; re-check by editing the prompt in the UI.
- [x] E5 Memory screen renders (memory automation on, semantic memory off); Doctor runs checks (see warnings zoom).
- E4 char drop: reproduced twice when typing the 80-char body in one go (the "P" after "else: " at position 52 vanished); not reproducible with shorter input or the same substring later. Likely a fast-input race in the controlled body textarea (PromptsScreen setDraft per keystroke); low priority, human typing unaffected.
- E10 note: Loops screen lists three legacy test loops (fail-loop, pass-loop, wt-loop) each marked "This structure is unavailable. Convert it before saving or running." (A9 graph conversion pending on the server data). Creating a fresh loop next.
- [!] Editors drop characters under fast input: Prompt body ("P" at char 52, three times) and Loop goal ("the heading" -> "theheading", "single" -> "ingle") lose characters when ~80-140 chars are typed quickly; the Agent and Skill editors took the same input intact. Controlled textareas that re-render heavily per keystroke (PromptsScreen, LoopsScreen). Human typing probably unaffected; paste unaffected. Medium-low.
- [!] E10: first loop run failed at iteration 1 because the maker (coder, no model of its own) was pinned to the first catalog entry gpt-5.3-codex-spark, refused for the ChatGPT account. Fixed: a pinned launch now prefers the app default model (deployed); run retried below. The loop mechanics worked: run manifest, iteration manifest, progress file, session with the failed subagent card, failure shown in the Loops panel with Retry.
- [!] E9 Issues screen on the server: "GitHub CLI is not authenticated. Run `gh auth login` in a terminal, then reload" and "Couldn't search issues — needs the gh CLI installed, authenticated, and GitHub remotes". On a shared server the clicker's GitHub connection (SRV-06) should feed gh (GH_TOKEN) for the Issues screen, or the message should point to Providers > GitHub instead of a terminal. Check whether the owner has a GitHub connection on the server (H1).
- [!] E5 Instructions > Project on the server: "Select a project in the sidebar to edit its AGENTS.md", but the server sidebar has no project selector (group headers are not selectable; currentProjectId stays null after page activation). Project-scoped screens are unreachable there. Check Git / Issues "This project" scope too.
- H1 note: Git screen says "Pushing as the server default. Connect GitHub under Settings > Providers to push as you": the owner has no GitHub connection on the server, which also explains the Issues screen error (gh unauthenticated). Not a bug; the Issues message should point to Providers > GitHub on a shared server instead of "run gh auth login in a terminal".
- G2 note: the first ask_user call timed out before a human answered (~30 s from card to click). Server default when the model omits timeout is 110 s (askUserCoordinator); the model can pass 1-290 s. Consider a human-scale floor or the A8 timeoutPolicy by default.
- [?] E1 remove: the project row menu on the server offers only "Choose Image" and "Hide" — no Remove for a server-cloned project. Removed via the API for cleanup; check the intended server flow (operator removes? then the UI should say so).
- E1 note: DELETE /projects/:id (200) unregisters the project but leaves /data/projects/Hello-World on disk (orphan clone). Removed by hand at cleanup.

## MCP real test 2026-10-17

- [x] E6 MCP screen: assign cloudflare-docs (HTTP, no auth) to CrunchyMurmur via the row checkbox -> project.assignedMcpServers updated; server-side "Check" discovered the tool (log: output-schema warning, ticket ade-sgw1) but the row still showed not checked / Tools (0) and the renderer froze during the check (re-check once).
- [!] Session with the assigned server: Pi's native MCP tried docs.mcp.cloudflare.com from inside the sandbox -> "Sandbox refused: network to docs.mcp.cloudflare.com" + "MCP servers need attention: cloudflare-docs failed: fetch failed"; the agent had no tool. Fix: an assigned HTTP MCP server's host is granted to the project's sandbox automatically (assignment = intent).
- fix: assigned HTTP MCP server hosts join the sandbox grants at launch (ADR 0007 am. 20); re-test after deploy: new session must list the tool and the search must return a result.
- [x] MCP real test PASS after the grant fix: new session listed cloudflare-docs, the agent called search_cloudflare_documentation inside the sandbox and got Cloudflare docs results (first result "Glossary"); tool output spooled to the session tmp folder.
- [x] Environment: Add variable (project scope) QA_ENV_CHECK -> listed masked; a fresh session's bash printed QA_ENV_CHECK=[granite]. Value never appeared in the server log.
