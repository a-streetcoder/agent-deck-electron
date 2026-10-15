---
id: ade-aier
status: open
deps: [ade-gfs4, ade-wgkk, ade-t77e, ade-shxc, ade-iarr, ade-k7s3]
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

**2026-10-15T07:00:03Z**

2026-10-15 owner answers to the four open questions: (1) a shared project checks out the repository's default branch, per-session worktrees as today; (2) only the creator or the operator may delete a shared project (the project records its creator); (3) whether a moved session carries its worktree branch needs an edge-case analysis before a decision (dispatched to the oracle); (4) a session move is a COPY on the system (new server id, 'shared from' link, local kept) but for the user it must look and behave as the same session (one entry, one title, the local copy becomes a pointer/mirror rather than a second visible session). SRV-06 approved and dispatched as the prerequisite.

**2026-10-15T07:05:03Z**

2026-10-15 oracle memo on the session-move branch question (summary; full memo in the architect session). Facts: worktreeIsolation defaults to false and the app commits only at merge, so a session's work is almost never on a branch; Pi resumes from the cwd in the transcript header (changing meta.cwd does nothing; rewrite the header or use Pi's forkFrom); a server worktree cannot be carried over (worktreeIdentity is per machine), only the base commit differs; the desktop talks to one backend at a time; the outbound push uses the LOCAL user's git login (SRV-06 only needed for the return trip); the event log cannot drive a live mirror yet. Inventory: transcript header remapped, SessionMeta title/plan/agent/launch config move, device-local fields dropped, drafts/pastes/images re-keyed and uploaded, checkpoints/subagent runs/Loop cells/plan history/event history dropped with a notice, refuse while streaming or a subagent runs or for Loop review sessions. Options: A conversation-only (uncommitted work never reaches the server; needs a 'your earlier edits are not in this workspace' prompt line) = consented FALLBACK; B push the session branch = NO (carries nothing without a commit); C automatic snapshot commit of the working tree (temporary index, -p HEAD), pushed to a transfer ref, server fetches, branches, adds the worktree and resets HEAD~1 so the work is uncommitted again = RECOMMENDED v1 (risks: untracked non-ignored secrets get pushed: show the file list in the confirmation; custom ref namespace acceptance on GitHub unverified; ignored files do not travel). 'Same session': local copy becomes a frozen read-only pointer (sharedTo {serverOrigin, serverSessionId, sharedAt}) with Open-on-server and Continue-locally (fork); live mirror after A1d; return trip later (needs SRV-06 and merge-as-PR on the server). Also: server merge must become push + PR on the shared server, and server worktree allocation should fetch first. Awaiting the owner's one-word answers: A fallback / B no / C yes / pointer frozen / return later.

**2026-10-15T07:20:12Z**

2026-10-15 owner: the target is the LIVE MIRROR with the RETURN TRIP ('more logical'). Phasing recorded by the architect: v1 = snapshot move (option C, A as consented fallback) + frozen pointer; v2 = live mirror (the local copy follows the server copy through the event log; needs the local app to call the remote server, which SRV-12b builds anyway, and the log authoritative for the session's events); v3 = return trip (server pushes the snapshot, needs SRV-06 and merge-as-PR on the server). Sub-tickets to be written after the event-log discussion closes.

**2026-10-15T07:37:11Z**

2026-10-15 sub-tickets written per the owner's answers and the oracle memo: ade-wgkk (SRV-12a repo projects), ade-t77e (SRV-12b Make shared + remote client), ade-shxc (v1 snapshot move + frozen pointer), ade-iarr (v2 live mirror), ade-k7s3 (v3 return trip + merge as PR). The ticket tree awaits the word approved; SRV-12a starts after SRV-06 merges.
