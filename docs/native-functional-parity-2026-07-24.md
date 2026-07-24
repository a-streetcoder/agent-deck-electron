# Native functional parity audit — 2026-07-24

## Audit baseline and method

This report compares the committed source trees at:

- **Native macOS:** `/Users/andrea/Documents/GitHub/agent-deck` at `6ba89a5` (`2026-07-24`, “Fix native attachment pill hit testing”)
- **Electron:** `/Users/andrea/Documents/GitHub/agent-deck-electron` at `6194fd1` (`2026-07-24`, “Move Electron engineer to active agent catalog”)

It supersedes neither `docs/parity-audit.md` nor product planning. It is a new point-in-time, functionality-only audit. Styling, spacing, animation, pixel matching, and other visual polish are excluded. Apple-only implementations are separated from portable product outcomes rather than counted blindly as cross-platform defects.

The comparison was performed by tracing current source, persistence models, runtime routes, Electron main/preload boundaries, and nearby tests in both repositories. Existing audit and roadmap claims were treated as leads and checked against the two committed trees. Uncommitted Electron changes were not treated as part of the `6194fd1` baseline. **Tests were inspected, not executed for this comparison.** Consequently, “present” means a source-backed implementation and relevant test evidence exists where cited; it is not a fresh runtime certification.

Evidence paths prefixed **E:** are relative to `agent-deck-electron`; paths prefixed **N:** are relative to native `agent-deck`.

## Status and priority taxonomy

### Status

| Status         | Meaning                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Present**    | The user outcome and its load-bearing runtime/persistence path exist.                                                                |
| **Equivalent** | The implementation differs by platform or architecture but produces a materially equivalent portable outcome. This is not a gap.     |
| **Partial**    | A usable path exists, but important states, inputs, persistence, or controls are absent.                                             |
| **Missing**    | No corresponding product path was found.                                                                                             |
| **Divergent**  | Both sides implement the area, but Electron semantics materially differ; this is a gap only when it changes user outcomes or safety. |
| **Unsafe**     | The path exists but does not preserve a required write, data, isolation, or release boundary.                                        |
| **Excluded**   | Native behavior depends on Apple-only frameworks or macOS-only integration and has no required portable equivalent.                  |
| **Decision**   | Not automatically required for parity; product ownership must choose whether to port it.                                             |

### Priority

| Priority | Meaning                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0**   | Release/parity blocker: advertised behavior silently executes different behavior. **Reserved in this report for Loop structure execution only.** |
| **P1**   | Confirmed data-loss/write-boundary risk, release/isolation safety issue, or missing load-bearing workflow that prevents faithful use.            |
| **P2**   | Material capability or persistence limitation with a workaround or narrower usable path.                                                         |
| **P3**   | Minor limitation, lower-frequency depth, or explicit product decision.                                                                           |

## Executive verdict

Electron has a substantial, real cross-platform core: Pi-backed incremental sessions, project and resource management, provider login, worktrees, Git/release automation, memory, MCP runtime, GitHub issue browsing, browser/preview/terminal/file/diff tools, onboarding, desktop attention, and a signed/notarized macOS package with pinned Pi. Several older claims that these surfaces are wholly absent are now wrong.

It is nevertheless **not at native functional parity**.

1. **One P0 blocker remains.** The Loop domain and UI expose six structures, but all five non-single-agent selections invoke the single-agent engine. Maker+Checker, Pipeline, Parallel, Discovery/Triage, and Human Approval therefore silently do something other than their selected behavior. This is worse than a disabled feature because saved intent is accepted and misexecuted. Evidence: **E:** `packages/domain/src/loops.ts`, `apps/web/src/screens/LoopsScreen.tsx`, `apps/server/src/routes/loops.ts`, `apps/server/src/loopEngine.ts`; **N:** `agent-deck/LoopModels.swift`, `agent-deck/LoopLaunchViews.swift`, `agent-deck/PiAgentSessionStore.swift`, `agent-deckTests/LoopExecutionStoreTests.swift`.
2. **The highest non-blocking risks are data and boundaries.** Resource writes can traverse final or ancestor symlinks; skill repository updates detect conflicts using only `SKILL.md` before replacing a whole skill directory; worktree isolation can silently fall back to the project checkout; merge/release preflights are thinner than native. These are P1 because they can overwrite user data or defeat an expected safety boundary.
3. **Core orchestration and conversation workflows remain incomplete.** Electron supports fresh named/parallel streaming children and the child-to-supervisor answer flow, but not the native parent tool catalog or durable/continuable child model. Whole-session duplication exists, while per-message Pi fork, rerun/edit-resend, fork-to-agent-chat, provenance, and faithful attachment persistence do not.
4. **Distribution is macOS-real but not cross-platform-complete.** The macOS DMG is signed/notarized and bundles pinned Pi. App auto-update, independent bundled-Pi update, Windows/Linux release/signing/update pipelines, and a session-independent model catalog are still absent.

The correct delivery posture is: fix or hide Loop structures first; close write/data/isolation hazards next; then build durable orchestration/session workflows and cross-platform update/release support. Do not call the current product “full parity.”

## Corrected stale claims

The following claims in older audit/planning material are stale or need qualification at the audited heads:

- **Provider login is not OAuth-only.** Electron discovers API-key and OAuth providers, supports search/grouping, lets the user select an available method, relays interactive prompts, and opens browser authorization URLs. The remaining account-lifecycle gap is explicit removal: the backend logout route exists, but the renderer exposes no disconnect/logout action. Selecting a configured provider does permit re-authentication and credential replacement. **E:** `packages/resources/src/providers.ts`, `packages/resources/src/providerLogin.ts`, `apps/server/src/routes/settings.ts`, `apps/web/src/screens/ProvidersScreen.tsx`, `apps/web/src/components/ProviderLoginSheet.tsx`, `e2e/tests/provider-login.spec.ts`; **N:** `agent-deck/PiProviderCatalogService.swift`, `agent-deck/PiProviderLoginService.swift`, `agent-deck/ProviderLoginSheets.swift`.
- **macOS packaging is no longer parked.** Electron uses electron-builder, has hardened-runtime/notarization DMG configuration and a macOS release workflow, and packages the pinned Pi runtime. **E:** `electron-builder.yml`, `package.json`, `.github/workflows/release-macos.yml`, `scripts/build-pi-runtime.mjs`, `scripts/validate-macos-release.sh`, `apps/desktop/main.js`.
- **Desktop notifications and badges exist.** The remaining limitation is observation of only the active session, plus no renderer handling that navigates a notification click to its originating session. **E:** `apps/web/src/state/useDesktopAttention.ts`, `apps/desktop/main.js`, `apps/desktop/preload.cjs`, `e2e/tests/desktop-electron.spec.ts`.
- **Basic subagents are not missing.** Fresh anonymous/named children, bounded parallel fan-out, incremental transcript cards, cancellation/cleanup, and blocking child `contact_supervisor` questions with a UI answer route exist. The gap is the richer native tool and durable-child contract. **E:** `apps/server/src/bridgeTools.ts`, `apps/server/src/services/sessionManager.ts`, `apps/server/src/routes/bridge.ts`, `packages/domain/src/transcript.ts`, `apps/server/test/subagent-*.pi.test.ts`.
- **MCP HTTP and OAuth are not absent from the backend.** Stdio and Streamable HTTP runtime/config, live tools, OAuth endpoints, and agent allowlists exist. The normal add UI is still stdio-only, OAuth callback handling is manual paste, and edit/assignment/master controls are incomplete. **E:** `packages/mcp/src/client.ts`, `packages/mcp/src/oauth.ts`, `packages/resources/src/mcp.ts`, `apps/server/src/routes/mcp.ts`, `apps/web/src/screens/McpScreen.tsx`, `apps/server/test/mcp-http.pi.test.ts`, `apps/server/test/mcp-per-agent.pi.test.ts`.
- **Packaged Electron normally does not require a manual Pi installation.** It resolves the bundled pinned runtime through `process.resourcesPath`. Doctor install/update/repair controls remain a gap primarily for development/external runtimes and dynamic Pi maintenance, not for first launch of a correctly packaged app. **E:** `apps/desktop/main.js`, `electron-builder.yml`, `packages/pi-host/src/resolve.ts`, `packages/pi-host/src/doctor.ts`.

## Consolidated gap table

This table consolidates confirmed functional gaps. Present/equivalent behavior is documented in the domain sections rather than repeated here.

| Priority | Domain          | Capability                                                                              | Status    | User impact / required correction                                                                                                                            |
| -------- | --------------- | --------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0**   | Loops           | Five non-single-agent structures execute the single-agent path                          | Divergent | Selected Maker+Checker/Pipeline/Parallel/Triage/Human Approval intent is silently ignored. Implement each engine or stop exposing unsupported structures.    |
| **P1**   | Loops           | Structure-specific configuration and validation                                         | Missing   | No checker/rubric, stage graph, branches/concurrency, triage handoff, or approval checkpoint can be represented faithfully.                                  |
| **P1**   | Loops           | Durable run/session/transcript identity and replay                                      | Partial   | Runs use a hidden/transient parent path rather than a durable user session with reconstructable rounds and recap.                                            |
| **P1**   | Loops           | Per-iteration artifacts and durable artifact directory                                  | Missing   | Outputs/evidence cannot be inspected, retained, revealed, or recovered after restart.                                                                        |
| **P1**   | Loops           | Explicit run-worktree review/apply/discard lifecycle                                    | Partial   | Electron can use a temporary isolated worktree, but removes the checkout on completion and provides no durable review, apply, or discard controls.           |
| **P1**   | Loops           | Human Approval pause/resume and approve/reject                                          | Missing   | The advertised structure cannot stop safely for a person or resume deterministically.                                                                        |
| **P1**   | Resources       | Writes can follow final symlinks or symlinked parent directories                        | Unsafe    | Agent/prompt/skill edits may escape the intended resource root. Canonicalize/validate the complete write path and reject links at every traversed component. |
| **P1**   | Skills          | Conflict fingerprint covers only `SKILL.md`; update replaces whole directory            | Unsafe    | Locally edited assets/reference files can be silently overwritten by repository update. Use a per-file manifest and explicit conflict resolution.            |
| **P1**   | Subagents       | Parent bridge lacks `ask_user`, `list_supervisor_requests`, `answer_supervisor_request` | Missing   | Parent agents cannot drive the full native human/supervisor control plane.                                                                                   |
| **P1**   | Subagents       | Durable child/run/artifact model, continuation ID, declared reads, per-child worktree   | Missing   | Child work cannot be resumed, audited, isolated, or recovered as native workflows expect.                                                                    |
| **P1**   | Subagents       | `managed_parallel` caller concurrency and worktree policy                               | Missing   | Caller cannot bound fan-out below the hard cap or request isolation semantics.                                                                               |
| **P1**   | Sessions        | Per-message Pi fork and rerun/edit-resend                                               | Missing   | Users can only duplicate the whole session file, not branch or retry from a chosen turn.                                                                     |
| **P1**   | Sessions        | Fork-to-agent-chat plus origin/provenance/actions                                       | Missing   | A conversation cannot be handed to a named one-to-one agent with a durable recap/origin trail.                                                               |
| **P1**   | Sessions        | Transcript attachment persistence for images/files/folders/pastes                       | Partial   | Image input reaches Pi, but resume/history cannot faithfully reconstruct all user attachments and actions.                                                   |
| **P1**   | Worktrees       | Isolation failure silently falls back to project root                                   | Unsafe    | A user who enabled isolation may unknowingly let an agent edit the primary checkout. Fail closed or require explicit opt-in to continue unisolated.          |
| **P1**   | Worktrees       | Merge preflight and conflict outcome depth                                              | Partial   | Parent cleanliness/source validity are not explicit guards and all merge failures collapse to a generic conflict response.                                   |
| **P1**   | Release         | No remote ahead/behind synchronization gate                                             | Unsafe    | A clean local tree may still tag/push from stale or divergent remote state.                                                                                  |
| **P1**   | Updates         | No Electron application auto-update                                                     | Missing   | Packaged users cannot receive verified app updates in product.                                                                                               |
| **P1**   | Updates         | No independently updatable bundled Pi                                                   | Missing   | Fixes to the pinned runtime require an application release; no native-like Pi update/rollback status path exists.                                            |
| **P1**   | Distribution    | No Windows/Linux release, signing, and update pipelines                                 | Partial   | Cross-platform source exists without equivalent production distribution assurance.                                                                           |
| **P2**   | Providers       | No renderer disconnect/logout control                                                   | Partial   | Users can re-authenticate and replace credentials, but cannot explicitly remove a credential from the UI despite a backend logout route.                     |
| **P2**   | Models          | No session-independent model catalog                                                    | Divergent | Models/onboarding choices can be empty until a Pi session supplies availability.                                                                             |
| **P2**   | Notifications   | Only active-session transitions are observed                                            | Partial   | Background sessions finishing or requesting approval can be missed.                                                                                          |
| **P2**   | Notifications   | Click does not navigate to originating session                                          | Partial   | Notification focuses the app but leaves the user to locate the relevant session.                                                                             |
| **P2**   | Agents          | Per-project custom-agent assignment matrix and builtin disable                          | Missing   | Projects cannot curate the visible/allowed agent catalog as native can.                                                                                      |
| **P2**   | Agents          | Portable avatar import/storage and profile cards                                        | Missing   | User-selected agent identity cannot survive as a managed portable asset.                                                                                     |
| **P2**   | Agents          | Several subagent behavior fields are not editable                                       | Partial   | Expected outcome/progress/interactive/output/reads/depth policy cannot be configured from Electron.                                                          |
| **P2**   | Agents          | Extension allowlist editing                                                             | Partial   | Existing extension configuration cannot be fully managed through the agent editor.                                                                           |
| **P2**   | Skills          | Git fetch/preview and per-skill selection                                               | Missing   | Import commits all discovered skills without review/selection.                                                                                               |
| **P2**   | Skills          | Local folder import with multiple roots/assets                                          | Partial   | Local import accepts a Markdown file; folder structures and associated assets are not faithfully imported.                                                   |
| **P2**   | Skills          | Collection sync/detail/provenance UX                                                    | Partial   | Repository-level update exists, but collection management, per-skill detail, comparison, and sync explanation are thinner.                                   |
| **P2**   | Prompts         | Rich catalog/library/package/settings/builtin discovery                                 | Partial   | Core CRUD works, but native discovery/import and builtin-disable workflows are absent.                                                                       |
| **P2**   | Instructions    | Catalog and assembled instruction preview                                               | Missing   | Users cannot inspect the final instruction set that a session will receive.                                                                                  |
| **P2**   | Resources       | Extension/instruction watcher coverage                                                  | Partial   | Some external edits do not refresh until manual reload/rescan.                                                                                               |
| **P2**   | Memory          | Semantic default/fallback and qualification timing differ                               | Divergent | Electron may recall/inject different memories, including weaker matches, than native.                                                                        |
| **P2**   | Memory          | No embedder/readiness status                                                            | Missing   | Users cannot tell whether semantic recall is available or which fallback is active.                                                                          |
| **P2**   | Memory          | No “Memory Recalled” transcript card/navigation                                         | Missing   | Injected context is invisible in the conversation and cannot be traced back to a record.                                                                     |
| **P2**   | Memory          | Tags, usage, stale cleanup, pause, detail depth                                         | Partial   | Memory lifecycle and explainability are materially thinner despite a working store.                                                                          |
| **P2**   | MCP             | Add UI is stdio-only; no edit                                                           | Partial   | HTTP/OAuth servers require out-of-band config, and existing definitions cannot be corrected in place.                                                        |
| **P2**   | MCP             | No automatic OAuth callback capture                                                     | Partial   | Users must paste a code/redirect URL even though OAuth endpoints and loopback helper code exist.                                                             |
| **P2**   | MCP             | Config source/provenance and project/global assignment                                  | Partial   | Users cannot reliably see ownership/source or assign server availability at native granularity.                                                              |
| **P2**   | MCP             | No master toggle                                                                        | Missing   | MCP cannot be globally paused without editing/removing configuration.                                                                                        |
| **P2**   | MCP             | Tool exposure semantics differ                                                          | Divergent | Electron bridge registration and native extension/direct-tool exposure yield different default tool universes; document and align intentional policy.        |
| **P2**   | GitHub issues   | Post reply and reopen                                                                   | Missing   | Issue handling is read/close-centric; users must leave the app for common write-back actions.                                                                |
| **P2**   | GitHub issues   | Rich structured Open-in-Pi context                                                      | Partial   | The agent receives thinner issue context than native (relationships/body/comment structure/provenance).                                                      |
| **P2**   | GitHub issues   | Relationships, broader search/type/reason/account UX                                    | Partial   | Triage and navigation are materially narrower.                                                                                                               |
| **P2**   | Worktrees       | Branch retention and cleanup policy controls                                            | Divergent | Electron always preserves branches and lacks native cleanup/keep policy choices; safe but accumulative and behaviorally different.                           |
| **P2**   | Projects        | Assigned agents/MCP and portable project icon controls                                  | Partial   | Project preferences cover skills/prompts/default agent but not the native assignment breadth.                                                                |
| **P2**   | Projects        | Discovery heuristics differ                                                             | Divergent | Different projects may be found/typed; this is a gap only where users cannot add or classify the omitted project manually.                                   |
| **P2**   | Dev preview     | Non-Node dev-server detection                                                           | Missing   | Automatic launch is primarily `package.json` script based; other stacks require manual commands/browser use.                                                 |
| **P2**   | Terminal        | External terminal workflow differs                                                      | Divergent | Electron provides an owned PTY terminal, an equivalent embedded outcome, but not native’s external-terminal launch/integration choices.                      |
| **P2**   | Composer        | Native slash-command/resource universe is broader                                       | Partial   | Some native actions/resources cannot be discovered or inserted from the composer.                                                                            |
| **P2**   | Preview         | Inspector is manual selector/note, not point-and-click                                  | Divergent | Element context works, but users must identify DOM targets manually; screenshot annotation is absent.                                                        |
| **P2**   | Preview         | Iframe embedding fails on frame-blocking dev servers                                    | Partial   | Some common dev servers render blank/refuse embedding; Browser remains a workaround.                                                                         |
| **P2**   | Files/diffs     | Search and comparison scope are limited                                                 | Partial   | File search is substring/capped and diffs lack richer branch/turn/split workflows.                                                                           |
| **P2**   | Doctor          | No install/update/repair actions or Web Access diagnostics                              | Partial   | Checks and copied commands exist, but remediation and Exa/url-fetch readiness are not managed in app.                                                        |
| **P2**   | Doctor/settings | Warning and settings-file inspection depth                                              | Partial   | Users receive less provenance and actionable configuration diagnosis.                                                                                        |
| **P2**   | Onboarding      | Gating/preferences are thinner                                                          | Partial   | Setup works, but some native defaults/integrations cannot be selected or validated during onboarding.                                                        |
| **P3**   | Sessions        | Per-message copy/fork action affordances and richer status provenance                   | Missing   | Lower-severity efficiency and explainability gap after core fork/rerun is addressed.                                                                         |
| **P3**   | Skills          | Rich compare/summary/collection detail                                                  | Missing   | Helpful management depth, not required for safe basic import once per-file conflicts are fixed.                                                              |
| **P3**   | Prompts         | Search, argument-hint editing, external-file import                                     | Partial   | Core prompt execution remains usable.                                                                                                                        |
| **P3**   | Memory          | Usage counters/source-agent metadata/near-duplicate richness                            | Partial   | Management telemetry and quality tuning are thinner.                                                                                                         |
| **P3**   | MCP             | Smart-paste and per-tool description depth                                              | Partial   | Manual configuration remains possible.                                                                                                                       |
| **P3**   | Issues          | Result truncation notice, relationships/detail metadata                                 | Partial   | Primarily triage efficiency and transparency.                                                                                                                |
| **P3**   | Analytics       | Native analytics has no Electron equivalent                                             | Decision  | Decide privacy/product goals first; do not treat telemetry collection as unquestioned required parity.                                                       |

## Domain-by-domain comparison

### 1. Providers, models, packaging, and updates

**Electron already has:** provider discovery over Pi’s current catalog; API-key and OAuth methods; provider search and grouping; method selection; an interactive relay with cancellation; automatic browser launch for advertised auth URLs; masked credential status; backend logout; model selection/disable state once availability is known; a sandboxed Electron shell; an ephemeral loopback-owned backend; packaged pinned Pi; electron-builder macOS DMG configuration with hardened runtime, signing, and notarization.

Evidence: **E:** `packages/resources/src/providers.ts`, `packages/resources/src/providerLogin.ts`, `apps/server/src/routes/settings.ts`, `apps/web/src/screens/ProvidersScreen.tsx`, `apps/web/src/components/ProviderLoginSheet.tsx`, `apps/desktop/main.js`, `electron-builder.yml`, `.github/workflows/release-macos.yml`, `e2e/tests/provider-login.spec.ts`, `packages/resources/test/providerLogin.test.ts`. Native reference: **N:** `agent-deck/PiProviderCatalogService.swift`, `agent-deck/PiProviderLoginService.swift`, `agent-deck/PiAuthCredentialStore.swift`, `agent-deck/PiModelDiscoveryService.swift`, `agent-deck/UpdaterService.swift`, `agent-deck/PiAgentUpdateService.swift`.

**Confirmed differences:** explicit renderer disconnect/logout is absent even though `POST /runtime/providers/:id/logout` exists; selecting a configured provider can re-authenticate and replace credentials; model discovery depends on an active/bootstrap Pi session rather than a standalone catalog; app auto-update and separately managed Pi update are absent; only macOS has a release pipeline. Bundling Pi is an **equivalent packaged-runtime design**, not a defect and not a reason to require users to install Pi manually. Dynamic runtime updates and signed cross-platform distribution remain gaps.

### 2. Loops

**Electron already has:** Loop Bank CRUD, `.loop.md` parsing/persistence, six structure enum values, project/model/agent launch inputs, live run status, single-agent fixed-iteration execution, validation command execution, early success stop, cancellation, and focused unit/real-Pi/e2e coverage.

Evidence: **E:** `packages/domain/src/loops.ts`, `packages/resources/src/loops.ts`, `apps/server/src/loopEngine.ts`, `apps/server/src/routes/loops.ts`, `apps/web/src/screens/LoopsScreen.tsx`, `apps/server/test/loopEngine.test.ts`, `apps/server/test/loops.pi.test.ts`, `e2e/tests/loops-run.spec.ts`. Native reference: **N:** `agent-deck/LoopModels.swift`, `agent-deck/LoopDefinitionStore.swift`, `agent-deck/LoopLaunchViews.swift`, `agent-deck/PiAgentLoopControlBar.swift`, `agent-deck/PiAgentSessionStore.swift`, `agent-deckTests/LoopDefinitionStoreTests.swift`, `agent-deckTests/LoopExecutionStoreTests.swift`.

**P0 defect:** `apps/server/src/loopEngine.ts` declares a minimal single-agent engine and `apps/server/src/routes/loops.ts` builds that same path without dispatching on the selected structure. The domain/UI accepting six values is therefore misleading.

**Additional P1 gaps:** no structure-specific schema; no checker/stage/branch/triage/approval orchestration; no durable user-visible run session and replayable round transcript; no artifact directory/per-iteration files; no run-owned worktree apply/discard lifecycle; no human approval state machine; no robust resume/retry after process/app restart. These should be designed together because durable run identity owns artifacts, child sessions, worktree, cancellation, approvals, and restart cleanup.

### 3. Parent/child agents and supervisor control plane

**Electron already has:** `managed_subagent` with optional named-agent resolution, `managed_parallel` with bounded fan-out and `allSettled`, real child Pi processes, incremental ordered transcript events, cancellation/cleanup, child-scoped `contact_supervisor`, non-blocking progress, blocking decision/interview requests, and a REST/UI answer path. This is meaningful functionality, not a mock.

Evidence: **E:** `apps/server/src/bridgeTools.ts`, `apps/server/src/services/sessionManager.ts`, `apps/server/src/routes/bridge.ts`, `apps/server/src/supervisor.ts`, `packages/domain/src/transcript.ts`, `apps/server/test/subagent-named.pi.test.ts`, `apps/server/test/subagent-parallel.pi.test.ts`, `apps/server/test/subagent-stream.pi.test.ts`, `apps/server/test/subagent-supervisor-blocking.pi.test.ts`. Native reference: **N:** `agent-deck/PiNativeSubagentBridgeExtensions.swift`, `agent-deck/PiSubagentRunService.swift`, `agent-deck/PiSubagentLaunchPlanner.swift`, `agent-deck/PiSubagentWorktreeService.swift`, `agent-deck/PiAgentSubagentViews.swift`, `agent-deckTests/PiNativeBridgeExtensionSourceTests.swift`, `agent-deckTests/PiSubagentWorktreeServiceTests.swift`.

**Gaps:** Electron’s parent bridge catalog does not expose `ask_user`, `list_supervisor_requests`, or `answer_supervisor_request`. `managed_subagent` accepts only task and optional agent—no continuation ID, reads, durable child/run/artifact record, or per-child worktree policy. `managed_parallel` lacks caller-specified concurrency and worktree policy. The current fresh-child design is valid for basic delegation; it is not equivalent to native durable orchestration.

### 4. Sessions, transcript, attachments, fork, and attention

**Electron already has:** create/resume/rename/delete/search; persisted Pi session file and launch plan; genuine incremental assistant/thinking/tool/subagent/supervisor delivery; cancellation; reconnect replay/snapshot; whole-session duplicate/fork via a safely copied JSONL file; image paste/file-picker input with limits; checkpoints; pending review/element/user-input composer cards; notifications and badge delivery through a narrow preload bridge.

Evidence: **E:** `apps/server/src/routes/sessions.ts`, `apps/server/src/services/sessionManager.ts`, `apps/server/src/pushBus.ts`, `packages/domain/src/transcript.ts`, `apps/web/src/components/Transcript.tsx`, `apps/web/src/components/Composer.tsx`, `apps/web/src/components/SessionsPanel.tsx`, `apps/web/src/state/clientTransport.ts`, `apps/web/src/state/useDesktopAttention.ts`, `apps/desktop/main.js`, `apps/desktop/preload.cjs`, `apps/server/test/persistence-roundtrip.test.ts`, `apps/server/test/session-resume-nofile.pi.test.ts`, `e2e/tests/chat.spec.ts`, `e2e/tests/session-manage.spec.ts`, `e2e/tests/desktop-electron.spec.ts`. Native reference: **N:** `agent-deck/PiAgentRunnerService.swift`, `agent-deck/PiAgentSessionStore.swift`, `agent-deck/PiAgentSessionModels.swift`, `agent-deck/PiAgentTranscriptViews.swift`, `agent-deck/PiAgentComposerViews.swift`, `agent-deckTests/PiAgentForkSemanticsTests.swift`, `agent-deckTests/PiAgentSessionStoreTests.swift`.

**Gaps:** duplicate is not Pi’s per-user-message `/fork`; no edit-and-resend/rerun; no fork-to-agent-chat; no origin recap/provenance or message actions. Images reach Pi, but Electron does not persist/render the full native attachment record across transcript reload. File/folder attachments and large-paste marker/chip semantics are incomplete. Notifications watch only the selected session. Main sends `focus-session` on click, but preload/renderer do not consume it to select that session. Native’s persisted `needsAttention`, error, and notification state is richer than Electron’s active-view edge detector.

### 5. Agents

**Electron already has:** catalog scanning across builtin/global/project-visible scopes; create/edit/delete/rename; builtin overrides and reset; enable/disable; default-agent launch; model/thinking/tools/skills/MCP fields; project-sensitive resolution; and named-agent subagent launching.

Evidence: **E:** `packages/resources/src/scanner.ts`, `packages/resources/src/writer.ts`, `packages/resources/src/overrides.ts`, `apps/server/src/routes/resources.ts`, `apps/server/src/routes/sessions.ts`, `apps/web/src/screens/AgentsScreen.tsx`, `apps/web/src/components/AgentEditor.tsx`, `e2e/tests/agents.spec.ts`, `apps/server/test/agent-rename.test.ts`. Native reference: **N:** `agent-deck/AgentPersistence.swift`, `agent-deck/AgentManagementViews.swift`, `agent-deck/SubagentConfigPersistence.swift`, `agent-deck/AgentImageStore.swift`, `agent-deckTests/BuiltinOverrideDisabledTests.swift`.

**Gaps:** no per-project custom-agent assignment matrix or per-project builtin disable; no portable avatar file import/storage/profile-card path; several subagent configuration fields cannot be edited (`defaultExpectedOutcome`, progress behavior, interactive/output policy, default reads, depth); extension allowlist management is incomplete. Apple Image Playground avatar generation is excluded, but **portable image import/storage is not**.

### 6. Skills and skill repositories

**Electron already has:** skill CRUD/rename/disable; global/project resolution; local Markdown import; persistent Git clone and provenance; source URL normalization; nested `SKILL.md` discovery; whole-directory copy including assets for Git imports; remote update check; fast-forward clone update; and Keep-Mine/Take-Remote behavior.

Evidence: **E:** `packages/resources/src/skillSource.ts`, `packages/resources/src/writer.ts`, `apps/server/src/routes/resources.ts`, `apps/server/src/persistence.ts`, `apps/web/src/screens/SkillsScreen.tsx`, `apps/server/test/skill-repo-import.test.ts`, `e2e/tests/skills-git.spec.ts`. Native reference: **N:** `agent-deck/SkillImportSheet.swift`, `agent-deck/SkillRepositorySyncService.swift`, `agent-deck/SkillRepositoryModels.swift`, `agent-deck/SkillUpdateConflictSheet.swift`, `agent-deck/SkillCompareSheet.swift`, `agent-deckTests/SkillRepositorySyncServiceTests.swift`.

**P1 data-loss defect:** Electron stores and compares a SHA-256 only for `SKILL.md`, then repository resync can recursively remove and replace the destination skill directory. A locally edited `references/*`, script, template, or other asset does not trigger conflict and can be silently lost. Per-file fingerprints plus explicit added/modified/deleted conflict handling are required.

**Other gaps:** no fetch-and-preview sheet or per-skill selection before import; local import does not scan a selected folder and preserve multiple skill roots/assets; collection management, per-skill repository detail, duplicate comparison, summaries, and richer sync provenance trail native.

### 7. Prompts, instructions, extensions, and resource write safety

**Electron already has:** prompt CRUD/rename/assignment and slash insertion; global/project instruction editing; safe refusal of a final symlink for project `AGENTS.md`/`CLAUDE.md`; extension discovery, Pi loading, enable/disable, and conflict reporting; builtin override persistence rather than bundled-resource mutation.

Evidence: **E:** `packages/resources/src/scanner.ts`, `packages/resources/src/writer.ts`, `packages/resources/src/watcher.ts`, `apps/server/src/routes/resources.ts`, `apps/server/src/routes/projects.ts`, `apps/web/src/screens/PromptsScreen.tsx`, `apps/web/src/screens/InstructionsScreen.tsx`, `apps/web/src/screens/ExtensionsScreen.tsx`, `e2e/tests/prompts.spec.ts`, `e2e/tests/instructions.spec.ts`, `e2e/tests/extensions.spec.ts`. Native reference: **N:** `agent-deck/PromptsViews.swift`, `agent-deck/SystemInstructionsViews.swift`, `agent-deck/PiExtensionDiscoveryService.swift`, `agent-deck/ExtensionsScreen.swift`, `agent-deck/ResourceRenameSupport.swift`.

**P1 write-boundary defect:** at Electron `6194fd1`, general resource writers form lexical paths and use `mkdirSync`/`writeFileSync` without rejecting a final symlink or a symlink in an existing parent. Writes can therefore follow a link outside the intended global/project catalog. Deletes need precise treatment: deleting a **final symlink** with `rm` removes the link and does **not** recursively erase its target; however, a symlinked parent can still redirect deletion to an external descendant. The risk is unauthorized write/replace/delete through path traversal by filesystem links—not a claim that every symlink delete recursively destroys its target. Evidence: **E:** `packages/resources/src/writer.ts`, `packages/resources/src/paths.ts`, `apps/server/src/routes/resources.ts`.

**Catalog gaps:** prompts lack native’s richer library/package/settings/builtin sections, search and external import; instructions lack a catalog and assembled launch preview; watcher coverage does not comprehensively include externally changed extension and instruction files.

### 8. Memory

**Electron already has:** project-scoped Markdown persistence; memory types/statuses; create/edit/archive/delete/search; secret scanning; bridge tools; launch and per-turn injection; lexical/fuzzy and optional semantic ranking; eligibility filters; tests against real Pi injection/recall.

Evidence: **E:** `packages/memory/src/store.ts`, `packages/memory/src/secrets.ts`, `packages/memory/src/semantic.ts`, `packages/memory/src/embedder.ts`, `packages/memory/src/preamble.ts`, `apps/server/src/routes/memory.ts`, `apps/server/src/memoryTools.ts`, `apps/web/src/screens/MemoryScreen.tsx`, `apps/server/test/memory-inject.pi.test.ts`, `apps/server/test/memory-recall.pi.test.ts`, `packages/memory/test/store.test.ts`. Native reference: **N:** `agent-deck/AgentMemoryStore.swift`, `agent-deck/AgentMemoryEmbedder.swift`, `agent-deck/AgentMemoryModels.swift`, `agent-deck/AgentMemoryViews.swift`, `agent-deck/PiAgentTranscriptNativeMemory.swift`, `agent-deckTests/MemoryRecallCalibrationTests.swift`.

**Divergence:** semantic defaults, fallback behavior, qualification/abstention gates, and injection timing are not identical. Electron’s semantic path does not expose native-equivalent readiness/status and can accept weaker top-N matches. This is not “memory missing”; it is recall-policy divergence that must be calibrated with realistic evaluations.

**UI/persistence gaps:** no “Memory Recalled” transcript card or navigation to the injected record; no embedder status; tags, usage (`useCount`/`lastUsedAt`), stale bulk cleanup, pause toggle, record detail, and source metadata are thinner or absent.

### 9. MCP

**Electron already has:** standard config parsing/writing for stdio and HTTP; runtime connection lifecycle; OAuth discovery/PKCE/token persistence endpoints; live tool registration; refresh/remove/logout; per-agent MCP allowlists; and real-Pi tests for HTTP, per-agent exposure, routes, and tool calls.

Evidence: **E:** `packages/resources/src/mcp.ts`, `packages/mcp/src/client.ts`, `packages/mcp/src/oauth.ts`, `apps/server/src/mcpTools.ts`, `apps/server/src/mcpOAuth.ts`, `apps/server/src/routes/mcp.ts`, `apps/web/src/screens/McpScreen.tsx`, `apps/server/test/mcp-http.pi.test.ts`, `apps/server/test/mcp-per-agent.pi.test.ts`, `apps/server/test/mcpOAuth.test.ts`. Native reference: **N:** `agent-deck/MCP/MCPConfigParser.swift`, `agent-deck/MCP/MCPConnectionManager.swift`, `agent-deck/MCP/MCPHTTPTransport.swift`, `agent-deck/MCP/MCPOAuthService.swift`, `agent-deck/MCP/MCPLoopbackServer.swift`, `agent-deck/MCPServersScreen.swift`, `agent-deckTests/MCPAssignmentTests.swift`.

**Gaps:** UI creation is stdio-only despite backend HTTP support; no edit; OAuth requires pasted code/redirect rather than automatic callback capture; no complete native config-source/provenance display; no project/global assignment matrix or master toggle. Electron exposes connected tools through app bridge names such as `mcp__server__tool`; native uses its extension/direct-tool bridge and richer assignment semantics. Basic tool use is an **equivalent outcome**, but default exposure and context composition are divergent and should be made explicit rather than assumed identical.

### 10. GitHub issues

**Electron already has:** `gh`-backed project issue listing; filters; detail/body/comments; close with reason; browser link; and Open in Pi basics. Focused route/e2e tests cover list/filter/detail/close/open.

Evidence: **E:** `apps/server/src/routes/projects.ts`, `apps/web/src/screens/IssuesScreen.tsx`, `apps/server/test/issues-filter.test.ts`, `apps/server/test/issues-detail.test.ts`, `apps/server/test/issues-close.test.ts`, `e2e/tests/issues.spec.ts`. Native reference: **N:** `agent-deck/GitHubAPIClient.swift`, `agent-deck/GitHubIssueService.swift`, `agent-deck/GitHubSearchService.swift`, `agent-deck/PiIssuePromptBuilder.swift`, `agent-deck/GitHubIssuesViews.swift`.

**Gaps:** no comment posting/reply, reopen, rich structured `<github-issue-context>`, issue relationships, broader search, issue type/state-reason depth, or equivalent account/connect UX. Using the user’s authenticated `gh` CLI is a valid cross-platform design choice, but it does not by itself provide equivalent API data or actions.

### 11. Worktrees, Git, merge, and release automation

**Electron already has:** optional session worktree isolation; fresh branch creation; persisted worktree metadata; delete cleanup; auto-commit then merge; project status/commit/push; AI commit messages; generalized release preflight, AI notes, annotated tag/push, and rollback-aware Git helpers.

Evidence: **E:** `apps/server/src/git.ts`, `apps/server/src/routes/sessions.ts`, `apps/server/src/routes/git.ts`, `apps/web/src/screens/GitScreen.tsx`, `apps/server/test/session-worktree.pi.test.ts`, `apps/server/test/git.test.ts`, `apps/server/test/release.pi.test.ts`, `e2e/tests/worktree-merge.spec.ts`, `e2e/tests/git-release.spec.ts`. Native reference: **N:** `agent-deck/PiAgentSessionWorktreeService.swift`, `agent-deck/GitRepositoryService.swift`, `agent-deck/PiAgentShipService.swift`, `agent-deck/ReleaseService.swift`, `agent-deckTests/PiSubagentWorktreeServiceTests.swift`, `agent-deckTests/ReleaseServiceTests.swift`.

**Safety/behavior gaps:** worktree creation failure is swallowed and the session runs in the project root; Electron retains the session branch on deletion and keeps worktrees after merge without native’s policy controls; merge lacks explicit parent-clean/source-valid preflight and collapses conflict classes into generic `409`; cleanup path policy is less explicit; release checks clean tree/tags but not remote ahead/behind synchronization. Branch retention is conservative rather than data loss, but it is not equivalent lifecycle behavior.

### 12. Projects and coding tools

**Electron already has:** explicit project add/remove/hide, configurable discovery roots, project typing/icons, per-project preferences, project instructions, `package.json` script discovery, owned dev-server process lifecycle, loopback-only preview, a hardened arbitrary-site Browser webview, a real PTY terminal, bounded scrollback, file tree/read/edit with conflict checks, unified diffs and review comments, editor launch, command palette, checkpoints, and composer context cards.

Evidence: **E:** `packages/resources/src/discovery.ts`, `apps/server/src/routes/projects.ts`, `apps/server/src/services/scriptRunner.ts`, `apps/server/src/terminalGateway.ts`, `apps/server/src/routes/shared.ts`, `apps/web/src/components/preview/PreviewPanel.tsx`, `apps/web/src/components/browser/BrowserPanel.tsx`, `apps/web/src/components/TerminalDrawer.tsx`, `apps/web/src/components/files/FilesPanel.tsx`, `apps/web/src/components/diff/DiffPanel.tsx`, `apps/web/src/components/CommandPalette.tsx`, `apps/desktop/main.js`, `e2e/tests/projects.spec.ts`, `e2e/tests/preview.spec.ts`, `e2e/tests/terminal.spec.ts`, `e2e/tests/files-l4b.spec.ts`, `e2e/tests/diff.spec.ts`. Native reference: **N:** `agent-deck/ProjectDiscovery.swift`, `agent-deck/ProjectPreferences.swift`, `agent-deck/ProjectServerService.swift`, `agent-deck/SlashUniverse.swift`, `agent-deck/PiAgentComposerViews.swift`, `agent-deck/PiAgentViews.swift`.

**Equivalent designs:** Electron’s embedded owned PTY is a portable equivalent for an in-app terminal even though native also integrates external Terminal; Electron’s hardened Browser webview is an appropriate cross-platform browser outcome. Neither needs Swift/AppKit parity.

**Gaps/divergences:** project assignment does not cover agents/MCP at native depth and portable icon customization is limited; discovery heuristics differ; auto dev-server detection is Node/package-script focused; external-terminal launch choices differ; the slash universe is narrower; preview uses a sandboxed cross-origin iframe and manual selector/note capture rather than the separate Browser webview or a point-and-click inspector; frame-blocking headers can prevent preview rendering; no screenshot annotation; file search is capped substring matching and diff scope lacks some native branch/turn/comparison controls.

### 13. Doctor, onboarding, settings, and analytics

**Electron already has:** Pi/Node/bash/auth checks, masked environment viewing/editing, phased onboarding, provider setup, project gating, default model/thinking/title/subagent preferences, and copied remediation commands. Packaged runtime resolution normally satisfies Pi availability without user installation.

Evidence: **E:** `packages/pi-host/src/doctor.ts`, `packages/pi-host/src/resolve.ts`, `apps/server/src/routes/settings.ts`, `apps/web/src/screens/RuntimeScreens.tsx`, `apps/web/src/components/OnboardingOverlay.tsx`, `apps/server/test/settings-preferences.test.ts`, `e2e/tests/onboarding.spec.ts`. Native reference: **N:** `agent-deck/EnvironmentDoctorViews.swift`, `agent-deck/OnboardingViews.swift`, `agent-deck/PiAutoInstallService.swift`, `agent-deck/PiAgentUpdateService.swift`, `agent-deck/AppSettings.swift`.

**Gaps:** Doctor mostly diagnoses/copies commands rather than performing install/update/repair; no Web Access card for Exa/url-fetch; warnings and settings-file provenance/viewing are thinner; GitHub setup and some onboarding preferences/gates are less complete. Manual Pi installation should not be made a packaged-app prerequisite; remediation needs to distinguish bundled, development, and user-selected runtimes.

**Analytics:** native has `agent-deck/Analytics.swift` and tests; no Electron equivalent was found. This is **P3/product decision**, because telemetry introduces privacy, consent, policy, and infrastructure choices. Absence is not automatically a parity defect.

## Platform-specific exclusions and portable targets

The following native implementations are **excluded** from cross-platform parity because they rely on Apple-only OS/framework capabilities:

- Apple Foundation Models and Apple Intelligence model execution.
- Image Playground avatar generation.
- macOS Computer Use integrations and Apple-specific brokers.
- Xcode bridge and Xcode-specific MCP behavior.
- AppKit/SwiftUI-only window, menu, Dock, accessibility, and rendering implementation details where Electron provides the same portable outcome.

Related portable outcomes remain in scope:

- **Avatar import from a normal image file**, app-owned storage, and profile display.
- **Application updates** with signature verification and safe rollback behavior.
- **Desktop notifications and badges** on supported Windows/macOS/Linux environments, including correct session routing.
- Browser, terminal, editor, project discovery, and MCP outcomes implemented with platform-appropriate facilities.

“Different implementation” is not itself a defect. A difference becomes a gap only when it changes capability, persistence, safety, discoverability, or runtime semantics.

## Ordered parity workstreams and dependencies

1. **Loop honesty hotfix (P0).** Until multi-engine work lands, restrict creation/edit/run to `singleAgent` or reject unsupported structures server-side with a clear migration-safe error. Add a negative test proving unsupported values cannot silently execute as single-agent.
2. **Filesystem and repository data safety (P1).** Add canonical containment and component-by-component symlink rejection for all resource writes/renames/deletes; then replace skill `SKILL.md`-only hashes with per-file manifests and three-way user choices. These changes should precede broader import UX because new import paths increase the affected data surface.
3. **Durable Loop execution architecture (P1).** Define versioned structure configs and a durable run record first. Make the run own child sessions, artifact directory, worktree, approval state, cancellation, replay, restart recovery, and cleanup. Then implement Maker+Checker → Pipeline → Parallel → Triage → Human Approval, reusing the durable subagent substrate below.
4. **Durable subagent/control-plane substrate (P1).** Add child/run IDs, continuation, reads, artifacts, per-child worktrees, cancellation and retention policy; add `ask_user`, list, and answer tools with scoped authorization. Add caller concurrency/worktree controls to parallel fan-out. Loop multi-agent structures should depend on this rather than creating a second child runtime.
5. **Session branching and attachment fidelity (P1).** Introduce a versioned attachment/provenance record, persist it with transcript entries, and verify resume first. Then expose Pi per-message fork, edit/rerun, fork-to-agent-chat, recap/origin cards, and message actions. Fork/rerun must preserve original image/paste/file semantics and cancellation.
6. **Isolation, merge, and release safety (P1).** Fail closed when requested worktree creation fails or obtain explicit user consent to continue; add source/parent preflight and typed merge outcomes; define branch/worktree retention settings; add remote-sync release gates. Keep recovery paths from deleting committed work.
7. **Update and cross-platform distribution (P1).** Decide feeds, signing identities, rollout/rollback policy, and supported targets. Implement app auto-update and bundled-Pi update as separate, signed channels only if product policy permits. Add Windows/Linux build/sign/package validation; do not infer those platforms from macOS success.
8. **Provider/model lifecycle and desktop attention (P2).** Wire an explicit renderer disconnect/logout control to the existing route and retain the existing re-authentication path; create a standalone model catalog service; track attention transitions for every session and consume `focus-session` in preload/renderer.
9. **Catalog assignment completeness (P2).** Add project agent assignment/builtin disable and MCP project/global assignment using one explicit persistence model. Then fill agent subagent fields, extension allowlists, avatar file storage, prompt/instruction assembled previews, and watcher coverage.
10. **MCP and issue workflow completion (P2).** Add HTTP server create/edit, automatic OAuth loopback capture with strict state/owner/timeout cleanup, source provenance and master toggle. Add issue reply/reopen and a structured context builder before broader metadata/search.
11. **Skills/Memory/Doctor/tool depth (P2/P3).** Add skill preview/selection and folder import after per-file safety; calibrate semantic memory and surface recall provenance/status; add runtime-aware Doctor repair and Web Access diagnostics; broaden dev detection, preview inspector options, file search, and diff scope without weakening sandbox/control-plane protections.
12. **Analytics decision (P3).** Decide whether Electron should collect analytics only after defining consent, minimization, retention, offline behavior, and policy. “Port native analytics” is not an implementation-ready requirement.

## Recommended acceptance and validation checks

These are implementation acceptance checks, not claims that they were run for this report.

### Cross-cutting release gate

- Run Electron `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` for every affected slice.
- Run `pnpm test:pi` for Pi protocol, session, subagent, Loop, memory, MCP, resource launch, provider, or extension changes. Preserve multiple real deltas before completion, total ordering, cancellation propagation, and clean child exit.
- Run `pnpm test:e2e` for renderer/backend and Electron behavior. Main/preload/lifecycle work must use the real Electron Playwright path, test negative sender/navigation/security behavior, and verify clean shutdown.
- Run native focused XCTest/build checks when native behavior is used as the acceptance oracle; do not infer native correctness solely from source.
- Validate packaged Electron separately from development. For native modules and PTY paths, run inside the target Electron ABI and packaged ASAR layout.

### Loops

- A saved unsupported structure must never execute the single-agent engine. Before implementation it is rejected/hidden; after implementation, dispatch tests assert each structure’s distinct child topology and config validation.
- Restart during every phase (child running, validation, approval wait, apply/discard) and verify deterministic replay/recovery without duplicate children.
- Cancel at every phase and verify Pi processes, process groups, timers, subscriptions, artifact streams, and worktrees are cleaned once.
- Parallel output remains incremental and globally ordered; queues/buffers are bounded.
- Artifacts and worktree changes survive restart, are scoped to the run, and require explicit apply; discard cannot escape the run worktree.

### Resource and skill safety

- Test final symlinks and symlinks in every existing parent component for create/edit/rename/delete across global and project agents, prompts, skills, instructions, and overrides on POSIX; add Windows junction/reparse-point coverage on Windows.
- Verify final-symlink delete unlinks only the link while symlinked-parent operations are rejected before touching the target.
- Race path replacement between validation and write/rename/delete; use descriptor/atomic patterns or fail safely.
- Edit, add, rename, and delete non-`SKILL.md` assets locally, then update the remote clone. Every difference must be preserved or presented as an explicit conflict—never silently replaced.
- Simulate interrupted clone/update and ensure the catalog remains at the previous complete version.

### Subagents and sessions

- Verify fresh, named, continued, and parallel children retain streaming, cancellation, scoped tools, declared reads, and worktree ownership.
- Reject continuation/run IDs not owned by the requesting parent; ensure child bridge tokens cannot call parent-only or another session’s tools.
- Exercise progress, blocking request, answer, denial, disconnect, parent cancellation, child crash, reload, and app quit. No unresolved waiter or temp extension may remain.
- Fork from repeated identical user messages and prove the chosen Pi entry is used. Rerun must truncate at the correct point and resend the exact prompt/attachments once.
- Resume after app restart and verify images, files, folders, large pastes, issue context, fork origin, and actions render from persisted data without embedding unbounded blobs in hot state.
- Complete a background session while another is selected; assert notification/badge appears and click selects exactly the originating session.

### Worktrees, Git, release, and updates

- Force worktree creation failures (detached HEAD, branch collision, permissions, invalid path). No isolated session may silently run in the source checkout.
- Test dirty parent, missing/changed source branch, nothing-ahead, clean merge, true conflict, interrupted merge, and cleanup policy as distinct outcomes with recoverable commits.
- Release preflight must detect dirty state, missing remote, ahead, behind, diverged, existing local/remote tag, push rejection, and rollback limits immediately before mutation.
- Validate signed/notarized macOS DMG launch and bundled Pi resolution. Separately validate Windows/Linux package installation, native module loading, PTY helper paths, process-tree shutdown, signing, and updater behavior on those platforms when pipelines exist.
- Update tests must cover signature failure, partial download, rollback, app-owned versus development backend ownership, Pi/runtime compatibility, and no mutation inside ASAR/bundled resources.

### Providers, MCP, memory, Doctor, and tools

- Provider connect/re-auth/logout/account-switch tests must cover API key and OAuth, browser launch, cancellation, malformed prompts, stale login IDs, credential masking, and model availability before any user session.
- MCP HTTP add/edit and OAuth must validate URL schemes, state/PKCE, callback ownership, timeout, port cleanup, logout, reconnect, token secrecy, source ownership, assignment filtering, and app quit.
- Run calibrated memory queries covering relevant, ambiguous, unrelated, lexical fallback, semantic unavailable, and secret-containing content; assert abstention and transcript provenance.
- Doctor must distinguish bundled Pi, external Pi, missing development Pi, outdated Pi, and corrupt runtime. Repair actions must be cancelable, non-blocking, and unable to overwrite bundled resources.
- Preview/browser tests must keep the control-plane origin blocked from hostile guest content. If preview moves from iframe to webview for frame-header compatibility or inspection, preserve sandbox, context isolation, no Node/preload leakage, loopback allowlisting, popup denial, and teardown.

## Residual risks of this audit

- This is source review, not execution; platform APIs, packaging credentials, network providers, Git remotes, and native modules can still fail at runtime.
- Only the specified commits were compared. Later uncommitted or subsequent changes may already address individual findings and require re-audit before implementation.
- macOS source/package evidence does not validate Windows or Linux behavior.
- Native behavior is a product reference, not always the correct cross-platform architecture. Security, privacy, update-feed, signing, analytics, and retention decisions still require explicit product approval.
