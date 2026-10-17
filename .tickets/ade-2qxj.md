---
id: ade-2qxj
status: open
deps: []
links: []
created: 2026-10-17T19:51:16Z
type: bug
priority: 3
assignee: almoretti
parent: ade-1c88
---
# QA: Projects on the server — no Remove in the UI, DELETE leaves the clone, Add dialog stays open

Browser run 2026-10-17. Add Projects from a repository URL cloned https://github.com/octocat/Hello-World to /data/projects/Hello-World and listed it (pass), but the dialog stayed open with the URL still filled after success. The project row menu offers only Choose Image / Remove Image / Hide: no Remove. DELETE /projects/:id (200) unregisters the project but leaves the clone folder on disk.

## Acceptance Criteria

Decide the server removal flow (operator-only or owner), expose it in the row menu, remove or archive the clone on delete (or say it stays), close the Add dialog on success.

