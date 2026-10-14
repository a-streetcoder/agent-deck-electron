# Syncr request: optional durable draft storage

Agent Deck now persists unstarted chats and unsent composer content through
`SessionDraftGateway`/`SessionIndex` and the injectable `ComposerDraftStore`
(`apps/server/src/composerDrafts.ts`). The pinned engine has no matching surface;
the host implementation remains authoritative until an explicit migration.

A future engine lift needs versioned get/put/delete operations keyed by stable
session identity, atomic durable acknowledgments, bounded text/image/paste
payloads, typed storage/conflict errors, and deletion tombstones that prevent
stale writes from resurrecting deleted drafts. Conflicting unsent edits must be
recoverable rather than silently overwritten. Migration must preserve corrupt
records for recovery and must never prune a never-started chat automatically.

This is a capability request, not authorization to sync sensitive unsent content.
Cross-device payload sync requires a separate product/consent and retention
decision. Pi processes, worktree ownership, local file references, and launch
environment secrets remain host-owned. No engine ABI or package-pin change is
required for the current implementation.
