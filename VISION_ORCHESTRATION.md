# VISION_ORCHESTRATION — from one agent loop to a system of agents

_Decision of record: [ADR 0004](docs/adr/0004-orchestration-and-collaboration-direction.md),
2026-10-15. Sequenced work: [`docs/roadmap.md`](docs/roadmap.md), lane A._

## The ladder, and where we stand

The engineering of LLM agents has moved up a ladder: prompt and context engineering make a
model useful for one call; harness engineering (tools, memory, skills, runtime) and loop
engineering (plan → act → observe → verify → stop) make one agent useful across a task. That
is **individual intelligence**, and Agent Deck has it: Pi is the loop, Agent Deck is the
harness — scoped skills and prompts, memory, MCP, worktrees, checkpoints, the supervisor channel.

The next rung is **system intelligence**: a set of agents organised to pursue one objective,
where the organisation itself — what the work is, who does which part, what state the system is
in — is explicit and operable rather than buried in one context window. The survey that named
this "graph engineering" (arXiv 2608.21156, Aug 2026) puts it as three views on one system,
each a graph:

| View                         | Question it answers                | Nodes / edges                                                   |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| **Task organisation**        | What must be done, in what order?  | subtasks; precedence, data, verification dependencies           |
| **Agent coordination**       | Who does it, and how do they talk? | agents, roles, capabilities; assignment, review, hand-off       |
| **Runtime state management** | What has happened, what is valid?  | events, artifacts, checkpoints; provenance, recovery boundaries |

plus a fourth concern, **system evolution**: turning what worked into a structure that is reused.

We adopt the three views as the organising model for Agent Deck's orchestration. We do **not**
adopt the claim that more agents beat one strong agent; see "What we take and what we leave".

## What exists today, by view

Everything below is in the repository now (paths are the current ones).

**Task organisation.**

- Six loop structures run end to end — `singleAgent`, `makerChecker`, `agentPipeline`,
  `parallelAgents`, `discoveryTriage`, `humanApproval` (`packages/domain/src/loops.ts`,
  `apps/server/src/loopEngine.ts`): per-iteration timeline events, artifacts with a manifest,
  structured validation evidence, checker decisions `APPROVE / CONTINUE / REJECT / ASK_HUMAN /
FAIL`, a report-only evaluator with its own model, retry from a `definitionSnapshot`,
  retained worktrees with a review lifecycle.
- `managed_parallel` fans out up to eight children with bounded concurrency and optional
  per-child detached worktrees (`apps/server/src/bridgeTools.ts`).
- The session plan (`set_session_plan` / `update_session_plan`) is a flat checklist of
  `todo / in_progress / done / blocked / skipped`.

**Agent coordination.**

- Named agents with tool policy, model and thinking overrides; per-project assignment; loop role
  preflight (`loopRequiredAgentRoles`).
- `managed_subagent` with resume (`continueSubagentID`) and read-first hints (`reads`); every
  run persisted with status, model, tokens, duration, session file and worktree identity
  (`apps/server/src/subagentRunStore.ts`).
- The supervisor channel both ways: `contact_supervisor` (`progress_update`, blocking
  `need_decision` / `interview_request`) up, `answer_supervisor_request` /
  `list_supervisor_requests` down.

**Runtime state.**

- Per-turn checkpoints (conversation file + workspace as a hidden git ref) with idle-gated
  rollback (`apps/server/src/services/checkpoints.ts`, `checkpointRollback.ts`).
- Loop runs persist iterations, children, artifacts and validation results; subagent runs
  persist in their own store; supervisor requests in `SupervisorLog`; the transcript rides the
  per-session push bus with a sequence number.
- Project memory: `context / decision / runbook / failure / preference`, recalled lexically and
  semantically, secret-scanned, staleness-marked (`packages/memory`).

**Collaboration.** The shared server: Cloudflare Access identity, per-user provider sign-in,
`createdBy` / `author` on sessions and messages, server-owned clones and per-session worktrees
(`docs/remote-server-poc.md`, ADR 0003).

## What is missing, by view

**Task organisation.**

- The plan has no dependencies, so the parent cannot express "C after A and B" and nothing
  schedules the ready frontier; `managed_parallel` takes independent tasks only.
- `managed_subagent` blocks the parent turn until the child returns. There is no spawn / await.
- A loop structure is one of six fixed shapes with flat frontmatter (`makerName`,
  `pipelineStages`, `parallelBranches`, `triageAgent`). "Pipeline with a checker after stage
  two" or "parallel branches then one checker" cannot be written.

**Agent coordination.**

- Capability is a name. The run store already holds pass/fail, tokens and duration per agent
  and role, but nothing aggregates it or lets a parent route on it.
- Verification is a loop feature. Ad-hoc orchestration through `managed_subagent` has no
  verifier role: no read-only tool profile, no typed verdict, nothing that stops the producer
  grading its own work.
- Topology is a star: child ↔ parent only. What reaches the parent is the whole child result.
- A human is a modal (`need_decision`, `humanApproval`), not a node with a timeout policy and a
  place in the stream.

**Runtime state.**

- Five stores, five shapes (loop runs, subagent runs, supervisor log, checkpoint index, push
  bus). No single answer to "what happened in this project today, in order, with provenance".
- Recovery is per run or per turn. There is no "node C failed verification: A and B are trusted,
  C→E is affected, retry from C's checkpoint".
- Tool calls carry no reversibility. Worktree writes are reversible; an MCP call that sent an
  email is not, and nothing distinguishes them before execution.

**System evolution.**

- A run that worked cannot be promoted to a reusable structure; the loop bank only holds
  hand-written definitions. Memory records facts and failures, not structures.

## The direction, as principles

1. **One event log is the substrate.** Loop runs, subagent runs, supervisor requests, plan
   changes, checkpoints, approvals and messages become events on one append-only per-project
   log with stable, client-generated ids. The scheduler reads it; the UI projects it
   (execution-node tree); the shared server serves it. Build this before the graph — the graph
   is a projection of events, not a sixth store.
2. **Pure graph logic in `packages/domain`.** Ready-frontier scheduling, affected-region
   marking, template normalisation: pure functions over typed records, unit-tested like the
   transcript reducer, with the server doing only dispatch and IO.
3. **A node contract that outlives the engine.** `(harness, agent, task, reads) → (result,
artifacts, verdict, events)`. Pi is the only harness today; ACP becomes a node type later,
   not a rewrite.
4. **The producer never grades itself.** Verification is a node kind with a read-only tool
   profile and a typed verdict (`LoopCheckerDecision`), available to loops and to ad-hoc
   orchestration alike. A human is a node kind too, with a timeout policy.
5. **Delta, not transcript.** What a child reports up is what changed since the parent last
   looked; the full child transcript stays reachable on demand (the t3code
   `delta_since_target_last_seen` idea).
6. **Recover at the node, not the run.** Checkpoints attach to nodes; a failed verification
   marks the affected subgraph and offers retry from the last trusted node.
7. **Legibility before depth.** Every step must make a run easier to read, inspect and resume.
   A feature that only adds agents is not in scope.
8. **Evidence before orchestration depth.** The loop engine already runs the same goal as
   `singleAgent`, `makerChecker` and `agentPipeline` with validation evidence and token counts.
   Use it. If maker/checker is not beating single-agent on our workloads, the graph work stays
   on legibility (DAG view, retry-from-node, event log) rather than team topologies.
9. **JSON, JSONL, git refs.** No graph database, no ontology layer, no SQLite until a query
   is measurably slow.

## What we take from the paper and what we leave

Take: the three views as the model; explicit dependency graphs for scheduling and parallelism;
independent verification as a structural role; runtime state as recorded, provenance-bearing
events with recovery boundaries; "system evolution" as promoting a run to a template.

Leave: the premise that intelligence must be distributed across many agents to progress; graph
databases and ontology engineering; "graph-native agent operating systems"; communication
topologies optimised across many peers. Agent Deck's value is control and visibility. If
multi-agent throughput turns out to be real on our tasks, the primitives above will carry it; if
it does not, they still make a single strong agent with a few helpers easier to run.

## Where it starts

The two items the roadmap carried from t3code's orchestration-v2 are the first steps and are now
lane A of [`docs/roadmap.md`](docs/roadmap.md): the **execution-node tree** (one structure for a
run, rendered and replayed from events) and **delta merge-back** for subagent results. Then
spawn / await, dependencies on the plan, capability profiles, the verifier role, loops as graphs,
node-level retry, reversibility on tools, and run-to-template promotion.

## Reference

- Feng et al., _Graph Engineering in the Era of LLM Agents: From Individual Intelligence to
  System Intelligence_, arXiv 2608.21156 (21 Aug 2026). Resource list:
  https://github.com/DEEP-JLU/Awesome-Graph-Engineering.
- t3code `docs/orchestration-v2/` (reference clone, read-only) for the execution-node tree and
  delta merge-back.
