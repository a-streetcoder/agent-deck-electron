# MCP-18 — protected environment and header editing

The owner selected keys-only editing instead of returning saved values to the
renderer. Local servers expose Environment entries; HTTP servers expose HTTP
headers. Existing entries show **Saved value**, with Replace and Remove actions.
Add creates a new entry. Replacement inputs are masked; an explicitly empty
replacement is a real empty string, while untouched entries retain their values.
Cancel discards the draft. Switching transport warns that the previous
transport's entries will be removed.

## Contract and persistence

`GET /mcp` returns `envKeys` or `headerKeys` only for editable global definitions;
it never returns the corresponding stored values. Project and environment
definitions retain their existing read-only policy. Manual edits submit explicit
per-key set/remove operations. The backend merges those operations with the
latest file, preserving untouched concurrent changes. HTTP header names match
without regard to case; ambiguous pre-existing duplicates fail closed. A stale
editor whose original transport no longer matches the saved definition receives
409 and must be reopened. Existing full-record/paste requests remain supported.

All definition mutations pass through the injectable `McpDefinitionStore`, backed
by the existing resource writer. A merged definition is written once using a
temporary file and rename, with owner-only permissions on POSIX. No storage
format migration, engine upgrade, cloud synchronization, or encryption change is
introduced. The [sync seam inventory](sync-seams.md) records the new boundary.

Validation rejects invalid environment names/NULs, HTTP header names/CRLFs, and
overlapping or duplicate operations. Unexpected persistence failures return a
value-free message. Saved values are not seeded into DOM inputs or responses.
This protects the editor boundary; MCP still uses configured environment values
and sends configured headers to the selected server as before.

## Review and validation

Implementation and independent correctness/accessibility review used Sol with
medium thinking. Parent review additionally checked API compatibility, stale
transport edits, responsive labels, and preservation of existing values.

Focused checks: 32 server route/edit tests, 49 resource MCP tests, and 62 renderer
MCP tests passed. The browser acceptance scenario covers masked replacement,
removal, a new empty value, keyboard focus, saved-value non-disclosure, and
persistence across an app-server restart. The final renderer regression also proves that existing environment names with
surrounding spaces retain their exact identity; trimming applies only to newly
added names.

Local validation on 2026-09-16:

- Full `pnpm test`: 2,564 JavaScript tests passed, 14 skipped; 39 Rust tests passed.
  The last whitespace-name correction additionally passed all 62 MCP renderer tests.
- Full `pnpm test:pi`: 146 passed against the pinned real Pi runtime.
- Full `pnpm test:e2e`: 252 passed, 14 skipped, four failures outside MCP
  (history re-run, Loop keyboard approval, agent deletion, and session pinning).
  All four passed on isolated rerun; the original broad failures remain recorded.
- The final protected-editor browser scenario passed with restart persistence.
  Wide/light and 940-pixel light/dark editor screenshots were captured and directly
  inspected; fields, actions, and focus indicators are legible without clipping
  at the supported desktop minimum width.
- Workspace typecheck, lint/design-system, formatting, native build/smoke, web
  build (through the browser harness), and backend build passed.

The broad UI run is not recorded as fully green. No unrelated workflow was
changed to make these checks pass.

## Platform scope

The UI, HTTP contract, and per-key merge are shared across macOS, Windows, and
Linux. This slice adds no shell commands, executable discovery, native module,
packaging, or process-control behavior. POSIX file mode 0600 is meaningful on
macOS/Linux; Windows relies on its filesystem ACLs. Existing cross-platform unit,
real-Pi, and UI CI exercise the shared implementation. Local execution is macOS
arm64; Windows/Linux and packaged execution are not claimed from local results.
