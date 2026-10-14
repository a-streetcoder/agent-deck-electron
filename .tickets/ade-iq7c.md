---
id: ade-iq7c
status: in_progress
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
