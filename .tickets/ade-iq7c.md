---
id: ade-iq7c
status: closed
deps: []
links: []
created: 2026-10-14T22:33:57Z
type: feature
priority: 2
assignee: almoretti
---
# UI-01: sessions panel always in view, Orchestrate nav becomes the pull-up with a user row


Owner instruction 2026-10-14 (verbatim): "one thing i really would like to change is to invert the session window with the orchestrate window. I would like the session window to be the main on always in view and the orchestrate to be the one you slide up - with an orchestrate Writing and below a user icon and name clicking on the slide up on orchestrate is the same behaviour as now we can then have a user setting at some point now just the icon and the name".

Today (apps/web/src/components/Sidebar.tsx + SessionsPanel.tsx): below the brand title bar the sidebar has two permanently mounted layers. The NAV layer (Workspace and Runtime sections: Projects, Instructions, Issues, Git, Agents, Skills, Loops, Prompts, Memory, Themes, Performance, Models, Providers, ...) is the main one, with `SessionsCollapsedCard` pinned at its bottom; clicking the card slides the `SessionsExpandedOverlay` (the sessions list, new chat, project filter) up and docks it (PANEL_MOVE / PANEL_FADE, nav recedes scale .98 y -24, inert + aria-hidden on the hidden layer). A "Signed in as <name>" line (data-testid sidebar-signed-in) sits under the brand bar on the shared server.

Wanted: invert the two layers.
1. MAIN layer = the sessions panel content (what SessionsExpandedOverlay shows today: attention count, list, new chat, filters), always in view below the brand bar, filling the height minus the collapsed card.
2. PULL-UP = the nav. Pinned at the bottom of the main layer, a collapsed card titled "Orchestrate" (same card styling as today's collapsed sessions card, same test-id pattern renamed) with, below the title, a USER ROW: a round icon (initials from userDisplayName/userInitials in apps/web/src/lib/userIdentity.ts when `me` is set; a generic user glyph otherwise) and the display name (`me.name` or email local part; "Local" when `me` is null). The user row is display only for now (no settings yet). Clicking the card (anywhere, including the user row) slides the nav layer up and docks it with exactly today's motion (reuse PANEL_MOVE/PANEL_FADE, inert/aria-hidden, pointer-events), with the same collapse control today's overlay has (header with a collapse button). The nav layer content stays as it is (Workspace + Runtime sections); selecting a nav item keeps the pull-up open (mirrors today's "stay expanded while moving between sessions") and shows the screen in the detail column.
3. Remove the separate "Signed in as" line (the user row replaces it; keep the email in a title attribute). Any command/keybinding/menu item that toggles the sessions pull-up today (grep "panelExpanded", "toggleSessions", command palette entries, useMenuCommands) now toggles the Orchestrate pull-up; the sessions list no longer needs a toggle. Selecting a session from the main layer behaves as today (activation path untouched).
4. Keep the native parity comments honest: update the doc comments in Sidebar.tsx/SessionsPanel.tsx to describe the inverted layering (this deliberately departs from the native sidebar).

## Design

GUARDRAILS as every ticket (worktree, single vitest files, eslint, prettier, apps/web tsc; no builds, no Playwright, no ssh, no push). Ponytail: swap which content sits in which layer and rename the collapsed card; do not rewrite the sessions list or the nav rows; reuse the two existing layer containers and motion constants. Component shape: `OrchestrateCollapsedCard` (title + user row, onExpand) and `OrchestrateExpandedOverlay` (nav sections + collapse header), with the sessions content rendered directly in the main layer; delete `SessionsCollapsedCard` if nothing else uses it. Update the existing Sidebar/SessionsPanel tests rather than deleting them.

## Acceptance Criteria

Web tests: the sessions list renders without any click; the collapsed Orchestrate card shows "Orchestrate" and the user row (initials + name when `me` is set, generic icon + "Local" when null); clicking the card expands the nav (nav items visible, sessions layer inert/aria-hidden), the collapse control returns; selecting a nav item sets the view and keeps the pull-up open; the old sidebar-signed-in line is gone; existing keyboard/menu toggle test (if any) targets the new pull-up. eslint, prettier, apps/web tsc clean. Live check by the owner in the browser after deploy.

## Notes

**2026-10-14T22:38:31Z**

Dev (a6e7218 on wt/ade-iq7c): Sidebar.tsx (OrchestrateCollapsedCard + OrchestrateExpandedOverlay, sessions layer main), SessionsPanel.tsx (SessionsCollapsedCard deleted, SessionsExpandedOverlay -> SessionsMainPanel without its motion wrapper, new-chat moved into its header), store.ts (setView no longer collapses panelExpanded), commands.ts (label Toggle Orchestrate Panel; command id panel.sessions.toggle / mod+s kept for keybinding compat), Sidebar.test.tsx new (6), SessionsPanel.test.tsx updated. vitest Sidebar+SessionsPanel+store.memoryNavigation: 3 files, 13 passed. eslint, prettier, apps/web tsc clean. Unverified: motion/layout visually (no browser); e2e Playwright specs still use sessions-expand/sessions-collapse/sessions-expanded/chat-list and will fail until updated (not run, out of scope).

**2026-10-14T22:42:28Z**

Dev round 2 (486a6d3): e2e updated to the inverted layering, edit only, Playwright NOT run. New helper openNav(page, id[, {timeout}]) in e2e/helpers/fixtures.ts (expand Orchestrate, click nav item, collapse) replaces 120 direct nav-* clicks; selectProject uses sessions-panel; chat-list and sessions-expanded -> sessions-panel; sessions-expand/collapse steps removed; history-actions row count uses [data-active]; session-panel.spec rewritten for always-in-view list + persisted Orchestrate pull-up (obsolete 'nav pick collapses panel' test dropped); desktop-electron boot checks orchestrate-expand. Files: e2e/helpers/fixtures.ts and 45 specs under e2e/tests (agents, assignments, attention, command-palette, desktop-electron, discovery, editing, env-edit, extensions, git-message, git-push, git-release, git, history-actions, instructions, issues-board, issues-filter, issues, loops-run, loops, mcp, memory, models, performance, polish, project-type-icons, projects, prompts, provider-login, providers, resource-lifecycle, resources, runtime, sent-files, sent-folders, sent-images, sent-pastes, session-empty-state, session-manage, session-panel, session-pinning, session-worktree, skeletons, visual, worktree-merge). User row: me without name and email -> generic icon + Local. Checks: vitest Sidebar+SessionsPanel+store.memoryNavigation 3 files, 14 passed; apps/web eslint/prettier/tsc clean; e2e tsc --noEmit -p e2e clean; eslint + prettier on the 46 e2e files clean. Unverified: any e2e run; visual.spec screenshot baselines will differ (sidebar changed) and need --update-snapshots; motion not checked visually.

**2026-10-14T22:48:58Z**

Dev round 3 (560139e), contrarian + GPT focus items: PANEL_KEY -> agentdeck-orchestrate-expanded (old key not migrated, everyone starts collapsed); setView('chat') sets panelExpanded false without persisting (covers Loops/MCP/Issues/palette/commands/menu/notification paths since all route through setView('chat')), nav picks keep it open; orchestrate-attention-count on the pull-up header; store meKnown (set by setMe): icon only until /me answers, Local after a null answer; if /me never answers the row stays icon-only; focus handoff via refs + effect on panelExpanded (open -> orchestrate-collapse, close -> orchestrate-expand), only when focus was inside the layer going inert or on body, so mod+s from the composer does not steal focus; e2e openNav checks orchestrate-expanded aria-hidden before expanding; useKeyboardShortcuts comment and SessionsPanel test name nits. Files: apps/web/src/components/Sidebar.tsx, Sidebar.test.tsx, SessionsPanel.test.tsx, apps/web/src/state/store.ts, useKeyboardShortcuts.ts, e2e/helpers/fixtures.ts. Checks: vitest Sidebar+SessionsPanel+store.memoryNavigation+wsBridge.refreshMe 4 files, 21 passed (Sidebar 12); eslint + prettier on touched files clean; apps/web tsc clean; e2e tsc clean. Playwright still not run; focus behaviour with real inert verified only in jsdom (no inert there). Owner note: from a nav screen back to a session is now two clicks (collapse, then row) where it was one for top-five sessions.

**2026-10-14T22:50:03Z**

2026-10-14 merged (wt/ade-iq7c: a6e7218, 486a6d3 e2e, 560139e review fixes). Contrarian: storage key renamed (old value meant the opposite), setView(chat) collapses the pull-up again, attention count on the Orchestrate header, icon-only user row until /me answers (meKnown), focus handoff on open/close (GPT review10), e2e openNav helper tolerant of an open pull-up. Post-merge: web tsc + Sidebar/SessionsPanel/store tests 19, e2e tsc clean. Not run: Playwright (45 specs edited, selectors only); visual.spec baselines need --update-snapshots on a machine with memory. Owner live check pending after deploy; UX note: nav screen -> session is now two clicks (collapse, then row).
