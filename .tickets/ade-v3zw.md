---
id: ade-v3zw
status: open
deps: []
links: []
created: 2026-10-17T19:51:16Z
type: bug
priority: 2
assignee: almoretti
parent: ade-1c88
---
# QA: project-scoped screens unreachable on the shared server (no project selector)

Browser run 2026-10-17. Instructions > Project says 'Select a project in the sidebar to edit its AGENTS.md', but the server sidebar groups sessions under non-selectable project headers and page activation sets currentProjectId to null, so the project scope (and anything keyed on currentProjectId) cannot be reached. The Git screen has its own project dropdown and works; Issues 'This project' scope is in the same situation. Also: the Issues screen on the server says 'run gh auth login in a terminal' instead of pointing to Providers > GitHub (the clicker's connection).

## Acceptance Criteria

A project picker on the Instructions (and Issues) screen like Git's, or the sidebar group header selects the project; Issues copy on a shared server points to Providers > GitHub.

