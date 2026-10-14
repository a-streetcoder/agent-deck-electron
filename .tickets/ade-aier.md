---
id: ade-aier
status: open
deps: [ade-gfs4]
links: []
created: 2026-10-14T18:00:31Z
type: epic
priority: 2
assignee: almoretti
---
# SRV-12: shared projects come from a GitHub repository, local projects can become shared, sessions can move to the server

DRAFT, NOT APPROVED: captured from the owner on 2026-10-14, to be refined before any dispatch. Owner intent (paraphrased): the server should not dictate projects by folder. A shared project is a server project backed by a GitHub repository. From the server UI the user picks a GitHub repository instead of a folder and the server clones it under AGENT_DECK_PROJECT_ROOT. From the desktop app a user can create a shared project the same way, and can transform an existing local project into a shared one: the app reads the local origin remote and asks the server to create the matching project. So a user has local (single) projects and shared projects. Once a project is shared, a session on it can be shared too, that is, moved or copied to the server. Today: POST /projects takes a path (apps/server/src/routes/projects.ts ~265) and the shared server already forces the server folder browser (remote: true); gitClonePersistent in apps/server/src/git.ts clones for skill discovery; there is no session export or import route (see architect note 2026-10-14). Proposed split, each its own ticket after approval: (a) SRV-12a server: POST /projects accepts { repo: owner/name or https url, ref? } on a shared server, clones into <PROJECT_ROOT>/<name> (containment, name collision -> 409, private repos need a credential: the SRV-06 per-user GitHub connection, or the VM credential until then), registers the project with origin recorded; web: on a shared server the Add project flow offers Repository (default) and Server folder. (b) SRV-12b desktop: a Make shared action on a local project reads origin, calls (a) through the configured remote server URL, stores the link (sharedProjectId plus server origin) on the local project and shows a badge; refuse when there is no origin or the remote is not GitHub. (c) SRV-12c session hand-off: export a local session (Pi transcript JSONL plus SessionMeta, images, drafts) and import it on the server under the linked project with the project path remapped and the Access identity as createdBy; one direction (local to server) first; the server copy is a new session id; branch and uncommitted work are NOT transferred (the user pushes first; the import warns when the local HEAD is not on the remote). Open questions for the owner: which branch does a shared project check out (default branch, with per-session worktrees as today); who may delete a shared project; should the import also carry the session worktree branch; is move (delete local) or copy wanted.

## Design

Architecture notes to settle before approval: project identity across machines (origin URL plus repo id, not path); the hand-off needs the existing session persistence format to be the contract (apps/server/src/persistence.ts, services/persistence.ts); no new dependency; private-repo cloning must not store a token on the VM outside the per-user connection from SRV-06. Dependencies: (a) none for public repos, SRV-06 (ade-gfs4) for private ones; (b) depends on (a); (c) depends on (a) and (b).

## Acceptance Criteria

To be written per sub-ticket after the owner approves the split and answers the open questions.


## Notes

**2026-10-14T18:08:14Z**

2026-10-14 contrarian amendments: SRV-06 (ade-gfs4) is a hard prerequisite of (a), because nearly every real repo is private and cloning with a VM credential would repeat the shared-credential problem for GitHub; (c) session hand-off becomes its own epic later, because the Pi session header stores an absolute cwd and session folders are keyed by cwd, so a path remap in SessionMeta alone does not move a session; project identity across machines is the GitHub repository id, not the origin URL.
