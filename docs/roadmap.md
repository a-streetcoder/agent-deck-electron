# Agent Deck Cross-Platform — Delivery Roadmap

Living plan for what ships next. Curated for a **Linux/Windows** port — some
native-macOS features are intentionally cut. The canonical gap catalog is the
parity register: shared history in
[`docs/native-functional-parity-2026-07-24-andrea.md`](./native-functional-parity-2026-07-24-andrea.md)
and the active rows in
[`docs/native-functional-parity-2026-07-24-ale.md`](./native-functional-parity-2026-07-24-ale.md)
(they replaced the old `docs/parity-audit.md`); this file sequences the work and
records the KEEP / TRIM / CUT / DEFER decisions.

Decisions here are proposals — veto or reorder any row.

---

## Now shipping

- ~~**L4b — file editing + persist**~~ — **DONE**: autosave in
  `apps/web/src/lib/fileSaveCoordinator.ts` + `FilePreview.tsx`, guarded
  `file_write` in `apps/server/src/services/files.ts`, per-session page/file
  strips in `apps/web/src/state/store.ts` (present since `7f79a76`). Files become editable with
  **debounced autosave** (no save button) through a guarded `file_write` op
  (path-containment + atomic write + on-disk conflict guard); plus **per-session
  persistence** of the browser page-tabs and open files so toggling a tool's
  workspace tab off/on restores them.

---

## Track 1 — Technical follow-ups (near-term, small)

Do these right after L4b lands. Small, mostly local, high polish/security value.

1. **CodeMirror dark theme** — **DONE except the soft-wrap toggle (open)**:
   `theme="none"`, a visible cursor and a light-mode highlight style are in
   `apps/web/src/components/files/CodeMirrorView.tsx` (present since `7f79a76`);
   the soft-wrap toggle is still not built (comment in the same file). The editor content ignores the app theme
   (CodeMirror's default light theme paints white). Set `theme="none"` so our
   dark surface/tokens show, restore the edit cursor, add a light-mode token
   palette, and a soft-wrap toggle. Languages are fine — 143 via
   `@codemirror/language-data` incl. TypeScript (`.ts`); the white theme just made
   code look broken. Verify `.ts` renders + highlights after the fix. _(quick)_
2. ~~**Preview panel renders nothing for frame-blocking dev servers**~~ —
   **DONE** (PRE-01, `305c4af`): the desktop build embeds a `<webview>` guest
   (`apps/web/src/components/preview/PreviewPanel.tsx`, `preview-webview`);
   the web build keeps the sandboxed iframe. The preview
   used a sandboxed `<iframe>`, so a dev server that sends `X-Frame-Options` /
   CSP `frame-ancestors` (Next.js, many others) refuses to be framed → white,
   even on loopback (`localhost:3000`). In the desktop build, switch the preview
   embed to a `<webview>` (like the L2 browser, which isn't iframe-limited) so
   localhost dev servers render; keep the iframe fallback for the web build.
3. ~~**Server REST origin/CSRF guard**~~ — **DONE** (ade-63d3, `aaa6124`): an
   `onRequest` hook in `apps/server/src/server.ts` applies the WS origin rule to
   every mutating route and `/fs/dirs`. The WS upgrade has a local-origin guard
   but the REST mutating routes don't; the in-app browser (L2) makes that
   reachable from arbitrary web content. Mirror the WS guard onto REST. _(small —
   do early; it's the one open security item)_
4. ~~**S20 branch-vs-base diff**~~ — **DONE** (ade-3wuu, `b6d6d2e` on
   `poc/shared-server`): the diff panel's "Compare with" select offers
   "Uncommitted" (working tree vs HEAD) and "Since <source branch>" (merge base
   of the worktree's source branch and HEAD) for worktree sessions, so committed
   changes inside the worktree show in review; the branch set refetches at turn
   end. `diff_files`/`diff_file` take an optional `base`.
5. ~~**S19 image-dialog focus e2e**~~ — **DONE** (ade-mk3s, `bda3dd2` on
   `poc/shared-server`): `e2e/tests/expanded-image-focus.spec.ts` checks focus
   moves into the dialog, Escape closes it and focus returns to the trigger. The
   deferred a11y test for the expanded-image dialog. _(tiny)_
6. ~~**Repo cleanup**~~ — **DONE** (2026-07-22): archived
   `docs/checkpoints-design.md` → `docs/archive/`; verified the "legacy oracle"
   references are documentation/parity comments, not dead code (no `*legacy*.ts`
   files exist).

---

## Track 2 — Parity (curated: KEEP / TRIM / CUT)

From the old parity audit's fix-slices A–K, filtered for a Linux/Windows port.
Per the registers, every implementable parity row is now closed; the only open
rows are ANA-01 (decision) and DST-01..06 (distribution, see Track 5).

| Slice                            | Decision               | Priority          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A · Loops**                    | **SPLIT**              | P0 hon. / P3 eng. | **DONE**: all six structures are runnable (`RUNNABLE_LOOP_STRUCTURES` in `packages/domain/src/loops.ts`, engines in `apps/server/src/loopEngine.ts`; LOOP-01..05 `e50ca1a` `75cc054` `da4ac8f` `4ee0af4` `8c74deb`; artifacts LOOP-21 `ff0a408`). _Now:_ restrict the structure picker to the single-agent engine that actually runs (stop advertising the 4 broken structures) — cheap, closes the "shipped-but-doesn't-run" defect. _Later (large):_ build the 4 missing engines + human-approval + artifacts. |
| **I · Skills per-file conflict** | **KEEP**               | P0                | **DONE**: SKL-01 `f3cbab0`, SKL-02 `6335331`; import preview SKL-03 `efd094f`, folder import SKL-05 `db26d52`. **Data-loss**: a skill's reference-file edits are silently overwritten on sync (only SKILL.md is fingerprinted). Fix per-file fingerprinting. (The import-preview / folder-scan UX can trail as P2.)                                                                                                                                                                                              |
| **B · Providers**                | **KEEP**               | P1                | **DONE**: API-key login was already present (register correction); model catalog before first chat SES-30 `910e2b8`; logout SES-31 `c1404eb`. API-key sign-in (only OAuth today) + a session-independent model catalog (Models screen / onboarding picker are empty until a session exists).                                                                                                                                                                                                                     |
| **C · MCP**                      | **KEEP (trim)**        | P1                | **DONE**: MCP-01 `4e05d16`, MCP-02 `842fd03`, MCP-03 `b349bad`; default assignment MCP-05 `dd1e60d`. Add http/remote server + edit + OAuth auto-capture (kill the paste-the-code UX — the loopback listener is dead code). Per-project MCP assignment can trail.                                                                                                                                                                                                                                                 |
| **G · Memory**                   | **KEEP**               | P2                | **DONE**: MEM-01 `fe8cbc9`, MEM-03 `16c7129`, MEM-04 `158f71d`, recalled sources MEM-06 `6d1520f`. Semantic abstain/qualification gates + a "Memory Recalled" transcript card with click-through.                                                                                                                                                                                                                                                                                                                |
| **J · Desktop bg notifications** | **KEEP**               | P2                | **DONE**: SES-13 `f1ef30e`, SES-14 `1ea96b6`, notification click → session SES-29 `3b5a5a8`. Completes S22a: notify/badge for **background** (non-active) sessions, and wire notification-click → navigate to the raising session.                                                                                                                                                                                                                                                                               |
| **F · Sessions fork/rerun**      | **KEEP**               | P2                | **DONE**: SES-21/22/23 `2f760d9`, fork provenance SES-25 `04dd48c`, copy SES-26 `5f81d61`. Per-message fork via pi `/fork` + in-place rerun (edit-and-resend) + per-message hover actions.                                                                                                                                                                                                                                                                                                                       |
| **D · Issues**                   | **KEEP (optional)**    | P3                | **DONE**: ISS-01 `a0e9ed4`, ISS-02 `06eecfa`, ISS-03 `c5bbc01` (ISS-04..13 also closed). Reply/comment, reopen, rich `<github-issue-context>` for Open-in-Pi. Only if in-app issues matter to you.                                                                                                                                                                                                                                                                                                               |
| **H · Doctor**                   | **TRIM**               | P3                | **DONE**: DOC-01 `d7d863b`, DOC-02 `7942d89`, DOC-04 `ccd3d8a`, DOC-06 `6d0f498`, DOC-07 `b2ef808`. Keep in-app pi install/update + the Web Access (Exa) card; the rest (GitHub connect, settings-files viewer) is nice-to-have.                                                                                                                                                                                                                                                                                 |
| **E · Agents**                   | **TRIM → cut avatars** | P3                | **DONE**: AGT-02 `7c3a0fc`, SUB-21/AGT-06 `28bdf00`; avatar import shipped anyway (AGT-03 `55556be`), AI generation stays cut. KEEP the per-project assignment matrix + the missing subagent-config editor fields (portable, useful). **CUT** the avatar system — AI generation is Apple Image Playground (macOS-only); import-from-file is low value.                                                                                                                                                           |
| **K · Minor/polish**             | **DEFER**              | —                 | Open: ANA-01 (analytics decision) is the only non-distribution row left in the registers. Cherry-pick as needed; mostly cosmetic / deliberate reductions.                                                                                                                                                                                                                                                                                                                                                        |

---

## Track 3 — Deferred & logged (not scheduled)

Recorded so we don't lose them. Each needs a decision, or is large / low-value.

- **S21 — Remote access** — decided: shared headless host behind Cloudflare
  Access ([ADR 0003](./adr/0003-shared-server-trust-model.md), ade-brgd);
  work continues in Track 4.
- **S22b — Desktop auto-update** — open, moved to Track 5 (ade-za74 for
  Windows, ade-159t for the rest).
- ~~**Loops full multi-engine implementation**~~ — **DONE** (see Track 2 slice A).
- **Agent avatars (AI-gen)** — CUT (macOS-only Image Playground).
- **Parity minor/cosmetic tail** — deferred; see slice K + the registers' open rows.
- **Orchestrator: two ideas from t3code orchestration-v2** (donor drifted;
  see their `docs/orchestration-v2/`). Worth taking with Pi as the only engine:
  - **Execution-node tree** — model a run as a tree of nodes (message,
    reasoning, tool, approval, subagent, hook) instead of flat cards; only the
    root node completes the run, child nodes complete independently. Gives the
    timeline and subagent views one structure to render and replay.
  - **Delta merge-back for subagent results** — when a child reports to the
    parent, feed the parent what changed since it last looked (t3's
    `delta_since_target_last_seen`), not the whole child transcript; keep the
    full transcript reachable on demand.
  - Deliberately NOT taking: the AppThread/provider-thread split and
    ContextHandoff machinery — they only pay off with a second engine.
- **S21 follow-up — shared server POC** (`poc/shared-server` branch,
  `docs/remote-server-poc.md`): Cloudflare Access identity, createdBy/author on
  sessions and messages, desktop remote mode. ADR done (ADR 0003); REST
  origin/CSRF guard done (ade-63d3); per-user git author, GitHub credentials and
  desktop browser login are tracked in Track 4.
- **Session move between backends (local ↔ shared server)** — "Move to
  server" / "Bring back local" on a session. Export = Pi session file (opaque
  JSONL, same pinned Pi on both sides) + Agent Deck session metadata + the
  worktree branch pushed to the remote; import = fetch the branch into a
  worktree of the matching project, remap the recorded cwd/paths, register the
  session, resume. Both directions. Depends on: per-user identity on the shared
  server (so the moved session keeps its owner), project identity shared across
  backends (same origin URL), and a path-remap rule for the transcript. Until
  then the manual path is push the branch + start a fresh session with a short
  handoff (delta, not transcript).

---

## Track 4 — Shared-server lane

See [ADR 0003](./adr/0003-shared-server-trust-model.md) and
[`docs/remote-server-poc.md`](./remote-server-poc.md). Tickets in `.tickets/`.

- ade-brgd — SRV-01: ADR shared headless host vs VISION_EDGE — closed
- ade-63d3 — SRV-02: REST origin and CSRF guard mirroring the WebSocket guard — closed
- ade-hnym — SRV-03: Andrea round via browser (co-working checklist) — open
- ade-fr91 — SRV-04: git identity per session follows the session owner — open
- ade-1vjx — SRV-05: spike - desktop login through the system browser via a per-user Access token — closed
- ade-gfs4 — SRV-06: per-user GitHub connection for push and PR as the session owner — open
- ade-fdjz — SRV-07: prune session-authors.json on session delete and retry remote health check — closed
- ade-zvv5 — SRV-08: desktop sign-in page starts the cloudflared browser login on click — open
- ade-s625 — FINAL: validation of the shared-server lane before pushing poc/shared-server — open

---

## Track 5 — Distribution lane

See [`docs/release-windows.md`](./release-windows.md). Tickets in `.tickets/`.

- ade-lfpv — DST-A (operator): create the Agent Deck certificate profile on Azure Artifact Signing — closed
- ade-za74 — DST-03/04: signed Windows installer, release workflow and auto-update — open
- ade-159t — DST epic stub: remaining distribution rows DST-02, DST-05, DST-06, DST-01 — open

---

## Suggested order

1. ~~**Ship L4b**~~ — done.
2. **Track 1** in order (theme → REST guard → branch diff → a11y e2e) — quick, clears the security + polish debt. Theme (bar soft-wrap), REST guard and a11y e2e (ade-mk3s) done; branch diff (ade-3wuu) open.
3. ~~**Track 2 P0**~~: Loops honesty fix + Skills per-file conflict (the two data-integrity items) — done.
4. ~~**Track 2 P1**~~: Providers, MCP — done.
5. ~~**Track 2 P2**~~: Memory, desktop bg notifications, sessions fork/rerun — done.
6. **Track 2 P3 / Track 3**: as prioritized when we get there. Track 2 P3 is done.
