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


## Correction (architect, 2026-10-17)

"Hide" in the project row menu already calls DELETE /projects/:id (unregister), so the
missing Remove is a naming issue, not a missing action. Remaining: the clone folder stays on
disk after unregistering a server-cloned project (owner decision: delete, archive or say so),
and the Add Projects dialog stayed open after a successful clone (fixed: closes on success).

## Outcome (2026-10-17)
Add Projects dialog closes after a successful clone (verified). Open for the owner: whether unregistering a server-cloned project removes the clone folder, and whether "Hide" should read "Remove" on the server.

## Update (2026-10-17)
On the shared server the row menu now says "Remove from server" with the note that the clone
folder stays. Left open for one owner decision: delete or archive the clone on unregister.
