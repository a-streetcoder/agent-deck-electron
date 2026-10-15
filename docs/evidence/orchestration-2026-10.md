# Orchestration evidence run (A0), October 2026

Ticket `ade-l1h0`, roadmap lane A row A0, principle 8 of `VISION_ORCHESTRATION.md` (evidence before
orchestration depth). Three real goals from this repository were run as `singleAgent`, `makerChecker`
and `agentPipeline` through the existing loop engine (`apps/server/src/loopEngine.ts`), same maker
model, validation evidence on, one run at a time. Run date: 2026-10-15, 00:00–00:52 UTC.

## Reading

With the plumbing fixed (pass 3), all three structures solved all three goals in one iteration,
with one exception that was a plumbing failure too (the maker/checker doc run was killed by the
checker, whose read-only tool profile could not run the checks its rubric asked for). `singleAgent`
was the cheapest in every goal (37k–87k tokens, 31–106 s); `makerChecker` cost 1.4–2.1× and
`agentPipeline` 2.1–4.4× the tokens of `singleAgent` for the same validated outcome. Every failure
across the fourteen runs that preceded pass 3 was a legibility or plumbing failure (tool allowlist,
outcome contract, verdict parsing, judge model), none a topology failure. On these workloads
maker/checker does not beat single-agent, so A6–A12 should be weighted towards legibility (what ran,
with which tools, under which contract, which verdict, at what cost) and node-level retry, not
towards team topologies.

## Setup

- Where: VM `dev`, an isolated second Agent Deck server started from the Syncthing replica source
  with `AGENT_DECK_DATA_DIR=/tmp/a0/data PORT=4399`, loopback only, no trusted-proxy variables, so no
  identity: operator credentials in `~/.pi/agent`, host Claude Code login. The live unit on 4200 was
  not touched (health checked before and after).
- Project: a throwaway copy of the replica source tree (no `.git`, no `node_modules`), `git init`,
  committed and tagged `base`, `pnpm install --frozen-lockfile --offline`. Placed on disk at
  `/var/tmp/a0/projects/deck-a0` with `/tmp/a0/projects` as a symlink, because `/tmp` on the VM is a
  3.9 GB tmpfs and `node_modules` is 787 MB. Every run started from `git reset --hard base && git
clean -fd`. Registered with `POST /projects`.
- Maker model: `claude-bridge/claude-opus-5` (the owner's Claude subscription through the bundled
  `pi-claude-bridge` 0.9.3), thinking `medium`. Parent session model passed in the run body
  (`provider`, `model`); the same model set in every agent definition.
- Agents (project-scoped, `<project>/.pi/agents/*.md`): `a0-dev` (maker / pipeline stage 2),
  `a0-checker` (checker), `a0-planner` (stage 1), `a0-verifier` (stage 3). Final definitions carry
  `tools: read, bash, edit, write, grep, find, ls` (dev, verifier) or `tools: read, grep, find, ls`
  (checker, planner) and `defaultExpectedOutcome: directProjectWrites` (dev, verifier). Why those
  two lines were necessary is the first finding below.
- Loop definitions: nine, one per goal × structure, created with `PUT /loops`, `maxIterations: 3`,
  `writeTarget: currentCheckout`, `launchContextScope: firstIterationOnly`. Maker/checker rubric:
  "the diff achieves exactly the goal and nothing else; no file outside the goal's scope is touched;
  no test file is modified unless the goal says so; the validation command passes when you run it
  yourself; the maker's report matches the actual diff". Pipeline stages: `a0-planner`, `a0-dev`,
  `a0-verifier`.
- Goal evaluator (the engine's per-iteration `evaluator` role, tool policy `none`): pass 3 used
  `openai-codex/gpt-6-sol`, thinking `medium`, through the owner's Codex subscription. Passes 1 and
  2 used the parent model (claude-bridge); see finding 3 for why that had to change.
- Runs: `POST /loops/:id/run` with `currentCheckoutConfirmed: true`; polled `GET /loops/runs/:id`
  every 15 s; cap 40 min (never reached; the longest run was 315 s). Driver and helper scripts, run
  JSON, diffs and token files are kept on the VM under `/tmp/a0/evidence` (the server log is
  `/tmp/a0/server.log`).

### Goals and validation commands

| Goal | Task                                                                                                                                                                                        | Validation command (shell, 120 s engine timeout)                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1   | Bug fix with a failing test: `reasoning === false` flipped to `=== true` in `packages/domain/src/thinking.ts`; make `test/thinking.test.ts` pass without touching tests                     | `cd packages/domain && npx vitest run test/thinking.test.ts && cd ../.. && git diff --quiet -- packages/domain/test/ && test -z "$(git diff --name-only \| grep -v '^packages/domain/src/thinking.ts$')"`                                                                                              |
| G2   | Doc restructure: split `docs/agent-guidelines/TESTING.md` (33 lines, one heading) into ≥3 `##` sections with a table of contents, nothing lost, prettier clean, no other file               | `npx prettier --check docs/agent-guidelines/TESTING.md && test "$(grep -c '^## ' …)" -ge 3 && grep -qiE 'table of contents\|^## contents\|^- \[[^]]+\]\(#[^)]+\)' … && test "$(git diff --name-only \| wc -l)" -eq 1`                                                                                  |
| G3   | Cross-package rename: `normalizeLoopLaunchContext` → `normalizeLoopLaunchContextText` (12 occurrences in 5 files across `packages/domain`, `packages/resources`, `apps/server`, `apps/web`) | `! grep -rwq normalizeLoopLaunchContext apps packages --include='*.ts' --include='*.tsx' --exclude-dir=node_modules && grep -rwq normalizeLoopLaunchContextText packages/domain/src/loops.ts && pnpm --filter @agent-deck/domain --filter @agent-deck/resources --filter @agent-deck/server typecheck` |

The `apps/web` typecheck was left out of G3 to stay inside the engine's fixed 120 s validation
timeout; all three pass-3 G3 makers reported running it anyway, and all three diffs touch exactly the
five expected files.

## Results, pass 3 (valid comparison)

Tokens are the sum of Pi's per-message `usage` over every child session of the run (maker, checker,
stages, evaluator), recovered from the Pi session files because the run API does not expose them
(gap 6). `in` is uncached input; claude-bridge reports most input as `cacheRead`/`cacheWrite`.

| Goal | Structure     | Outcome                                                  | Iter. | Checker     | Evaluator           | Wall  | Tokens total (in / out / cacheR / cacheW)  | Tool calls | Run id                                 |
| ---- | ------------- | -------------------------------------------------------- | ----- | ----------- | ------------------- | ----- | ------------------------------------------ | ---------- | -------------------------------------- |
| G1   | singleAgent   | completed, validation passed                             | 1     | —           | SUCCESS             | 31 s  | 36,897 (2,658 / 997 / 31,079 / 2,163)      | 4          | `37c20cf6-fabe-4a1b-85a0-ec1b7ea02e2a` |
| G1   | makerChecker  | completed, validation passed                             | 1     | APPROVE     | SUCCESS             | 61 s  | 69,009 (4,412 / 2,901 / 51,665 / 10,031)   | 8          | `853a13e3-f895-44ad-bb32-9ea4eb71f2c4` |
| G1   | agentPipeline | completed, validation passed                             | 1     | —           | SUCCESS             | 91 s  | 161,762 (5,054 / 4,942 / 128,784 / 22,982) | 13         | `683e044d-0dcd-41dc-98b2-b167c952ecbd` |
| G2   | singleAgent   | completed, validation passed                             | 1     | —           | SUCCESS             | 31 s  | 49,992 (2,560 / 2,017 / 41,678 / 3,737)    | 4          | `d84c9769-cae8-49ce-accc-4c89bfb9c102` |
| G2   | makerChecker  | failed (`agentFailed`): checker FAIL, validation not run | 1     | FAIL        | not reached         | 76 s  | 102,512 (20 / 5,224 / 82,676 / 14,592)     | 12         | `0e447ff2-0831-4807-8a37-cdce571eae1b` |
| G2   | agentPipeline | completed, validation passed                             | 1     | —           | SUCCESS             | 76 s  | 110,875 (5,130 / 4,495 / 74,230 / 27,020)  | 8          | `f7051bfb-2355-4f5c-b674-d8179f3fd9e9` |
| G3   | singleAgent   | completed, validation passed (twice)                     | 2     | —           | CONTINUE\*, SUCCESS | 106 s | 87,244 (7,156 / 2,854 / 60,482 / 16,752)   | 8          | `15ad8636-85d8-40a5-829c-28b41865b8d9` |
| G3   | makerChecker  | completed, validation passed                             | 1     | ASK_HUMAN\* | SUCCESS             | 106 s | 124,151 (5,014 / 4,519 / 96,790 / 17,828)  | 14         | `54757aca-b4e6-4bb0-9c9d-87b3f8a5d7af` |
| G3   | agentPipeline | completed, validation passed                             | 1     | —           | SUCCESS             | 136 s | 185,695 (6,198 / 6,011 / 142,130 / 31,356) | 15         | `f38e51ce-fd14-43a4-9bc0-d781aaa98d21` |

\* G3 singleAgent iteration 1: the evaluator wrote `SUCCESS` after a preamble sentence on the same
line, so `exactFirstLine` parsed it as `CONTINUE` and a second, redundant iteration ran (validation
had already passed). G3 makerChecker: the checker answered `ASK_HUMAN` because it had no shell to run
`git diff` or the typecheck; the engine applies the evaluator's `SUCCESS` before the checker's
`ASK_HUMAN`, so the run completed. G2 makerChecker: the maker's diff was correct (TOC plus five `##`
sections, only `TESTING.md` touched, one paragraph moved), but the checker returned `FAIL` for the
same reason (read-only tools, rubric asked it to run prettier and git), and a checker `FAIL` is
terminal before the validation command runs.

Per-structure totals over the three goals: singleAgent 174k tokens / 168 s / 3 of 3 goals;
makerChecker 296k / 243 s / 2 of 3; agentPipeline 458k / 303 s / 3 of 3.

## Results, passes 1 and 2 (what the engine does out of the box)

Pass 1: agents with explicit `tools:` but no `defaultExpectedOutcome`; evaluator on the parent model
(claude-bridge). Aborted after five runs because every structure was spending its iterations on the
same two defects. Pass 2: `defaultExpectedOutcome: directProjectWrites` added; evaluator still on the
bridge. Aborted after one and a half runs for the evaluator defect alone.

| Pass | Goal | Structure     | Outcome                                     | Iter. | Validation | Checker                    | Evaluator                                       | Wall  | Tokens  | Run id                                 |
| ---- | ---- | ------------- | ------------------------------------------- | ----- | ---------- | -------------------------- | ----------------------------------------------- | ----- | ------- | -------------------------------------- |
| 1    | G1   | singleAgent   | completed                                   | 2     | F, T       | —                          | CONTINUE, SUCCESS                               | 90 s  | 145,050 | `ac6e620e-421e-4de8-9705-3957a36419e6` |
| 1    | G1   | makerChecker  | notAchieved (`maxIterationsReached`)        | 3     | F, T, T    | CONTINUE, APPROVE, APPROVE | CONTINUE ×3 (text tool calls, parse fallback)   | 300 s | 494,486 | `732ae789-1db6-4ecf-8552-6bc5af3012aa` |
| 1    | G1   | agentPipeline | notAchieved (validation failed ×3)          | 3     | F, F, F    | —                          | CONTINUE ×3                                     | 315 s | 556,836 | `7035ad6c-e19c-45ab-8c81-8f9ae1534c8b` |
| 1    | G2   | singleAgent   | notAchieved (validation failed ×3)          | 3     | F, F, F    | —                          | SUCCESS (fabricated), CONTINUE, CONTINUE        | 225 s | 284,644 | `ab690031-c4fc-4532-92e3-1156c9335514` |
| 1    | G2   | makerChecker  | failed (`agentFailed`): evaluator tool call | 2     | F, —       | CONTINUE, CONTINUE         | CONTINUE, error "tool call could not be parsed" | 174 s | 196,661 | `d3a1823b-5ab5-4b95-a3cb-463abfff2f85` |
| 2    | G1   | singleAgent   | notAchieved (`maxIterationsReached`)        | 3     | T, T, T    | —                          | CONTINUE ×3 (text tool calls, parse fallback)   | 120 s | 172,750 | `b4d88296-e938-4096-a793-e03616c55f5f` |
| 2    | G1   | makerChecker  | stopped by me after iteration 1             | 1     | T          | APPROVE                    | (not reached)                                   | —     | 73,527  | `b7b5982a-8cbc-421f-8f65-340b755a5316` |

In pass 1 the first iteration of every run was spent by the maker declining to edit ("Outcome
contract: Report only — I left the working tree untouched"); in `singleAgent` and `makerChecker` the
maker overrode the contract on iteration 2 after the evaluator's feedback, in `agentPipeline` the dev
stage obeyed it for all three iterations ("blocked by outcome contract, not by technique") while the
planner and verifier stages re-confirmed a settled diagnosis. Pass 2 G1 singleAgent passed validation
three times in a row and still ended `notAchieved`, purely on the evaluator.

## Findings (engine behaviour met on the way to a valid run)

1. **A loop maker with no `tools:` in its agent definition gets no tools at all.**
   `resolveChildTools(configured, toolPolicy)` in `apps/server/src/services/sessionManager.ts`
   returns Pi defaults only when both arguments are undefined; the loop route always passes a policy
   (`configured` for maker/stages), so an agent without an authored allowlist runs with `[]`. The
   first attempt (runs `82b895d6`, `9d072e14`, `1b4a2cfc`) produced makers that emitted tool calls as
   text (`{"name": "Read", "input": …}`, `<invoke name="Bash">`) and hallucinated results ("No such
   file or directory" for files that exist). The comment on the function says the opposite of what
   happens for loops.
2. **Loop children launch under the managed-subagent outcome contract, default `reportOnly`.**
   `managedNamedOutcomeContract(resolved.defaultExpectedOutcome ?? "reportOnly")` is appended to
   every named child's system prompt, including loop makers and pipeline stages whose loop has
   `writeTarget: currentCheckout`. The agent must say `defaultExpectedOutcome: directProjectWrites`
   or the maker is told not to modify project files while the goal demands it (pass 1 above). The
   Loops UI does not surface this.
3. **The evaluator is the weakest node, and it gates every structure.** It runs with tool policy
   `none`. Through claude-bridge (Claude Code CLI with its tools stripped) the model still tries to
   verify with tools and emits them as text; `exactFirstLine` then falls back to `CONTINUE` (pass 1
   G1 makerChecker: validation passed twice, checker approved twice, run `notAchieved`; pass 2 G1
   singleAgent: validation passed three times, run `notAchieved`), or the bridge fails the child
   outright ("The model's tool call could not be parsed (retry also failed)", pass 1 G2 makerChecker),
   or the judge fabricates a verification it never performed (pass 1 G2 singleAgent iteration 1:
   `SUCCESS` with "the file now contains the four sections" while `git status` was empty). Moving the
   judge to a native Pi provider (`openai-codex/gpt-6-sol`) fixed it; the Codex ChatGPT account
   refuses `gpt-5.5` and `gpt-5.3-codex-spark` (run `6532d9ef`).
4. **Verdict parsing is brittle.** `SUCCESS`/`APPROVE` must be the exact first non-empty line; a judge
   that prepends one sentence costs a whole extra iteration (pass 3 G3 singleAgent). The engine
   silently maps the unparseable verdict to `CONTINUE`; the run detail shows `goalDecision:
CONTINUE`, not "unparsed".
5. **Checker capability versus rubric, and FAIL ordering.** The checker's read-only profile is
   `read, grep, find, ls` (no `git`, no shell), so it cannot verify "only files in scope were
   touched" or run the validation command, and a conscientious checker says so with `FAIL` or
   `ASK_HUMAN`. A checker `FAIL` finalises the run before the validation command is executed, so the
   engine trusts an under-equipped judge over the deterministic check it already has (pass 3 G2
   makerChecker, correct diff discarded).
6. **Tokens are not exposed.** `LoopRun`, `LoopRunIteration` and `LoopChildRecord` carry no usage;
   loop children run with a tool policy, which routes them past the durable `subagent-runs.json`
   store (`durable = toolPolicy === undefined ? childRuns : undefined`), so `inputTokens` /
   `outputTokens` are never persisted for them either. The numbers above come from matching child
   `startedAt`/`endedAt` windows to the Pi session files under
   `~/.pi/agent/sessions/--var-tmp-a0-projects-deck-a0--/` (117 files, all children matched). Not
   patched, per the ticket.
7. Smaller points: the validation timeout is a fixed 120 s (`runValidationCommand`); loop
   definitions live only in the home catalog (`~/.pi/agent/loops`), so the nine temporary
   definitions were briefly visible to the live server and were deleted afterwards; `singleAgent` is
   really maker + evaluator, i.e. two model calls per iteration, not one.

## Recommendations for A6–A12 (topology / legibility / drop)

| Row | Title                  | Call                            | Why, from this run                                                                                                                                                                                                                                                         |
| --- | ---------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A6  | Capability profiles    | legibility, with a prerequisite | Pass rate, tokens and duration per role are exactly what this document had to reconstruct by hand (finding 6). Persist child usage on the run first; the "route on reliability" bridge tool is not supported by evidence yet.                                              |
| A7  | Verifier role          | legibility, first priority      | Every pass-1/2 failure and the one pass-3 failure were judge failures: wrong tool profile, verdict not parsed, checker FAIL before validation. One verify node with a read-plus-run profile, a tolerant typed verdict and validation-first ordering beats a second agent.  |
| A8  | Human node             | legibility, low                 | `ASK_HUMAN` appeared once and was correctly overridden by validation plus `SUCCESS`. Nothing here asks for a unified human node now; keep the timeout policy idea for when A7 produces real asks.                                                                          |
| A9  | Loops as graphs        | legibility only                 | The three topologies produced the same validated outcome when the plumbing worked; what differed was cost and what was visible when they failed. One interpreter and a DAG/event view are justified; `nodes[]/edges[]` as an authoring format is not.                      |
| A10 | Node-level retry       | legibility, keep                | Five of the eight wasted iterations re-ran the whole maker when only the judge needed re-running (pass 1 G1 makerChecker ×2, pass 2 G1 ×2, pass 3 G3 ×1). Retry-from-node (re-run evaluator or checker on the existing checkpoint) is the cheapest fix the data points at. |
| A11 | Reversibility on tools | drop (defer)                    | No run touched an irreversible tool; `git reset --hard base` and `currentCheckout` + `git diff` already gave full reversibility. No evidence to build on.                                                                                                                  |
| A12 | Run → template         | drop (defer)                    | Structure choice did not change outcomes across three task kinds, so a `pattern` memory of "which structure worked for which task" has nothing to record yet. Revisit if a workload ever shows a topology effect.                                                          |

## Raw run ids (all 27 runs in the isolated store)

- Pass 3 (valid): `37c20cf6-fabe-4a1b-85a0-ec1b7ea02e2a`, `853a13e3-f895-44ad-bb32-9ea4eb71f2c4`,
  `683e044d-0dcd-41dc-98b2-b167c952ecbd`, `d84c9769-cae8-49ce-accc-4c89bfb9c102`,
  `0e447ff2-0831-4807-8a37-cdce571eae1b`, `f7051bfb-2355-4f5c-b674-d8179f3fd9e9`,
  `15ad8636-85d8-40a5-829c-28b41865b8d9`, `54757aca-b4e6-4bb0-9c9d-87b3f8a5d7af`,
  `f38e51ce-fd14-43a4-9bc0-d781aaa98d21`.
- Pass 3 discarded for my own validation-command error (G2 check demanded the literal words "table
  of contents"; the makers wrote a link list, which satisfies the goal): `0df9b211-e04c-426c-af87-fcac1b833582`
  (singleAgent, notAchieved with a correct diff), `1b55d2d2-8142-40e9-b12f-65da815403a6` (makerChecker,
  stopped). Judge smoke test with an unsupported Codex model: `6532d9ef-ff92-4285-a5ba-d4a3346cb2c8`.
- Pass 2: `b4d88296-e938-4096-a793-e03616c55f5f`, `b7b5982a-8cbc-421f-8f65-340b755a5316`.
- Pass 1: `ac6e620e-421e-4de8-9705-3957a36419e6`, `732ae789-1db6-4ecf-8552-6bc5af3012aa`,
  `7035ad6c-e19c-45ab-8c81-8f9ae1534c8b`, `ab690031-c4fc-4532-92e3-1156c9335514`,
  `d3a1823b-5ab5-4b95-a3cb-463abfff2f85`.
- Attempt with tool-less agents (finding 1): `82b895d6-8c11-4f74-940b-118685fea2d3`,
  `9d072e14-5909-4861-8f74-39e88fd9ddaa`, `1b4a2cfc-0d0e-4919-a010-cd8399e0b8be`. Attempt with my
  first G1 check (`git diff --name-only | wc -l -eq 1`, wrong because the correct fix restores the
  base file exactly): `c0bbe3b9-31b2-42a9-88a7-e0c061c9ce0c`, `1364f7a8-a7ed-4f04-a52a-0dda86f46c28`.
- Two one-iteration judge smoke runs (`a0-smoke`, `gpt-5.3-codex-spark` refused, `gpt-6-sol`
  accepted); their ids were not recorded before the store was removed.

Run JSON, per-run diffs, driver logs and `tokens.json` for every pass are under `/tmp/a0/evidence`
on the VM (`pass3/`, `pass2/`, `pass1-reportOnly/`, `attempt1-no-tools/`,
`attempt2-bad-g1-validation/`, `pass3-badjudge/`, `pass3-badg2validation/`).

## Deviations from the brief, and what is not verified

- The goal evaluator ran on `openai-codex/gpt-6-sol` (owner's Codex subscription) in pass 3, not on
  the bridge Claude; makers, checkers and stages stayed on `claude-bridge/claude-opus-5`. The judge is
  the same for all nine runs, so the comparison between structures holds; absolute token totals
  include the judge's calls.
- Two of my validation commands were wrong on the first try and were corrected before the valid
  pass (G1 diff count, G2 literal "table of contents"); the affected runs are listed above as
  discarded, not counted.
- The throwaway clone lived on disk under `/var/tmp/a0` (symlinked from `/tmp/a0/projects`) because
  `/tmp` is tmpfs. `/tmp/a0/data`, the clone and the symlink were removed; `/tmp/a0/server.log` and
  `/tmp/a0/evidence` were kept. The 117 child Pi session files under
  `~/.pi/agent/sessions/--var-tmp-a0-projects-deck-a0--/` were left in place as the token source.
- "No lost content" for G2 was judged by the evaluator and by a line count of the diffs (singleAgent:
  1 line removed, the bare `Additional suites:` label replaced by a heading; agentPipeline: 0
  removed; makerChecker: 2 removed, one paragraph moved under a new heading), not by a word-by-word
  comparison. The G2 makerChecker diff was never run through prettier by the engine (validation did
  not execute); it was not re-checked by hand.
- Tokens are Pi's `usage` records matched by time window, not an engine export; `in` for pass 1 rows
  is near zero because the bridge accounts almost all input as cache reads/writes.
