---
name: parity-loop
description: Close rows in the agent-deck native→Electron functional parity register in a verified implementation loop, with Codex as implementer and Claude as orchestrator/validator. Use when implementing, validating, or closing parity rows, optionally starting from a supplied row ID.
---

Run the agent-deck Electron parity implementation loop.

Electron repository (the product being built):
`C:\Users\alemo\Desktop\AI Playground\a-streetcoding\agent-deck-electron`

Native macOS behavioral reference (**READ-ONLY, never modify**):
`C:\Users\alemo\Desktop\AI Playground\Agent-deck` — oracle HEAD when this skill was last revised: `4dc16c3`.

Active registers:

- `docs/native-functional-parity-2026-07-24-andrea.md` — Andrea's rows (the loop's normal scope).
- `docs/native-functional-parity-2026-07-24-ale.md` — Ale's rows. **Never touch ANA-01 or DST-01..06**; they are operator-only.

Requested starting row: the ID supplied by the user, or `none`.

## Roles

Claude Code is the **orchestrator and validator**. The **implementer is the Codex CLI**. This split
exists because the loop's recurring failures are mechanical — scripted multi-edit surgery that
asserts and writes nothing, anchors broken by prettier, off-by-one line maths, a TDZ from declaring
a derived value below its first use, a raw `<textarea>` where the design system owns the control,
a hand-built test fixture missing a field a shared type just gained.

- **Claude**: reads the register, verifies the row against BOTH sides, defines acceptance criteria,
  writes the failing test FIRST, authors the brief, invokes Codex, reviews the diff, runs every
  gate, two-sides every pin, maintains the register, commits, watches CI.
- **Codex**: writes the implementation from the brief. It does not choose work, edit the register,
  close rows, or commit.
- Minor fixups (an import, a lint nit) Claude applies directly. Wholesale reimplementation by Claude
  defeats the setup — if Codex has not converged after the brief plus two feedback rounds, stop and
  report the row rather than silently taking over.

**The review leg must not be the implementing session.** When Codex implemented, the independent
review runs as a FRESH `codex exec` (never `resume`), so it reviews without the memory of having
written the code. Claude's own leg is verification by EXECUTION — running the code, neutering the
fix and watching the test fail — not by reading and agreeing.

## Per-slice sequence

1. **Verify the row against BOTH sides before building.** The register is a source-backed LEAD, not
   truth. In this loop four rows overstated their gap, one was 80% already done, and two cited a
   native file that does not exist. Enumerate what exists in native AND in the port, name the files,
   and say so in the commit. If the behavior is already present, prove it and close the row — do not
   manufacture work.
2. **Read native's actual design, not the row's summary of it.** MCP-12's row said "populates the
   add form"; native actually ships a Manual|Paste mode that saves every parsed server verbatim.
   Building the row's summary would have shipped a feature that silently drops env and headers.
3. **RED first.** Claude writes the failing test before Codex writes code, and confirms it fails for
   the RIGHT reason (a missing testid produces "unable to find element", which is not a real red).
4. **Brief and dispatch Codex** (see below).
5. **Review the diff yourself**, then run the gates.
6. **Two-sided check, mandatory.** Green → revert the fix → confirm RED and quote it → restore →
   verify the restore with grep BEFORE running anything. A pin that still passes with the fix
   reverted is DELETED OR REWRITTEN. For a negative pin ("X must not appear"), neuter the exact
   mechanism the test names, not a different one that happens to share the outcome.
7. **Independent review** — a fresh `codex exec` pass with defensive framing. A fix that changes
   live behaviour gets a SECOND pass; that second pass has found real defects on every slice it ran.
8. **Register edits in-band**, commit explicit paths, push, check CI, re-arm.

## Dispatching Codex

Binary: `CODEX=/c/Users/alemo/.codex/packages/standalone/current/bin/codex.exe`.

Implementation round (Codex writes):

```
"$CODEX" exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  -C "<ELECTRON_REPO>" -m gpt-5.6-sol --ignore-user-config - < brieffile
```

Review round (Codex reads only — also the mandatory review leg):

```
"$CODEX" exec -s read-only --skip-git-repo-check -C "<ELECTRON_REPO>" -m gpt-5.6-sol \
  --ignore-user-config --output-schema <schema> -o <out.json> "$(cat promptfile)" < /dev/null
```

Rules that have each cost a run:

- **Always `< /dev/null`** on the review form, or Codex waits on stdin and writes no output file.
- **Write the brief to a file and redirect it in.** Heredoc quoting has broken a dispatch.
- **Never trust Codex's exit code.** It has exited 0 having written nothing. After every write round:
  `git status --porcelain` the Electron repo, read the actual diff, and drive
  `codex exec resume --last` naming precisely what is missing rather than re-sending the brief.
- **After every write round, require `git -C "<NATIVE_REPO>" status --porcelain` to be EMPTY.** Any
  modification of the oracle is an immediate stop-and-restore.
- **Never launch any Codex round while the tree is neutered** — a review of a neutered tree burns a
  pass on unreal findings.
- Phrase review briefs **defensively** ("assess correctness and completeness", "where does the
  guarantee not hold"). An offensive-sounding brief trips a content filter, burns the run, writes
  nothing. `--output-schema` must be STRICT (`additionalProperties: false`, every property in
  `required`) or it 400s with no file.
- Give it a generous timeout (600000 ms) and `run_in_background` when useful. MCP OAuth noise on
  stderr is cosmetic.

Every implementation brief contains:

1. The register row ID and its Difference text verbatim.
2. The acceptance criteria, including the relevant **shared behavioral contracts** from the register.
3. The native reference files to study, absolute paths, marked READ-ONLY.
4. A pointer to `AGENTS.md`/`CLAUDE.md` plus the specific Electron files to touch.
5. Scope limits: this slice only, no unrelated refactors, no new dependencies.
6. "Do not run the suites or the gates; the orchestrator validates. Write focused tests beside the
   code." — and the failing test Claude already wrote, quoted, as the target.

## Gates (all of them, every slice)

- `pnpm exec prettier --write` on touched files, then **re-run tsc AND lint** — prettier reformats
  your own code and a refactor leaves dead imports.
- `pnpm exec tsc --noEmit -p <project>` per touched project.
- `pnpm lint` from the repo root.
- `node scripts/check-design-system.mjs` for anything under `apps/web` — it catches a raw control
  where a design-system one is required.
- Suites: `cd packages/<pkg> && pnpm exec vitest run`; `cd apps/web && pnpm exec vitest run`;
  `cd apps/server && pnpm exec vitest run --reporter=dot`; `cd apps/desktop && pnpm test`;
  real-Pi `pnpm exec vitest run --config vitest.pi.config.ts <spec>`; e2e `cd e2e && pnpm exec playwright test <spec>`.
- A new field on a shared type breaks hand-built fixtures in tests you never opened — fix the FIXTURE.

Local baselines (update when they legitimately move): packages/domain 157, packages/resources 257
(+11 skipped), apps/web 482, apps/server ≈1087 passed with 6–8 machine-class failures.

**Windows machine-class CI failures**: this machine's `test` and `test-pi` jobs intermittently time
out short-budget tests in packages the commit never touched. Before blaming your commit, check
whether the failing test lives in a package you touched.

## Register maintenance

Only after the gates pass: remove the closed row, decrement the active-row count in the owner line,
and record any policy question the slice surfaced as a numbered workstream rather than deciding it.
When Codex calls something a product decision, escalate it — do not decide silently.

Commit `parity(<ID>): <resolved user outcome>` with what+why, real pass numbers, the Codex
disposition, and honest gaps. Stage EXPLICIT paths — never `git add -A`, never `git stash`; the
checkout is shared with another session.

## Stop conditions

No active rows remain; a genuine owner decision blocks the row; Codex plus two feedback rounds has
not converged; or pre-existing work cannot be preserved safely. When blocked, do not remove the row
or commit an unaccepted slice — report the row, the blocker, and the evidence gathered.
