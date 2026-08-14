import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath from "node:path";
import type { DiffPush, ServerMessage, SessionMeta } from "@agent-deck/contracts";
import { extensionBridgeConflict } from "@agent-deck/domain";
import {
  addResourceWatchPaths,
  appendSystemPromptPath,
  projectWatchDirs,
  readMcpServerCatalog,
  scanAgents,
  scanEnv,
  scanExtensions,
  scanSkillCandidates,
  scanSkills,
  watchResources,
  ProviderLoginManager,
  SessionWorktreeStore,
  type ResourceRoots,
} from "@agent-deck/resources";
import { hasEffectiveEnvValue, writeBridgeExtension } from "@agent-deck/pi-host";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
  buildMemoryPreamble,
  createOnDeviceEmbedder,
  EmbedderUnavailableError,
  injectableIndex,
  searchMemories,
  semanticSearchMemories,
  type Embedder,
  type MemorySearchHit,
  type MemoryStore,
} from "@agent-deck/memory";
import { FileMcpOAuthStore } from "@agent-deck/mcp";
import { projectAllowsAgent } from "./agentCuration.ts";
import { resolveExplicitSkills } from "./agentSkillResolution.ts";
import { AskUserCoordinator } from "./askUserCoordinator.ts";
import { FileAgentAvatarStore } from "./agentAvatars.ts";
import { registerAskUserBridgeTool } from "./askUserBridgeTool.ts";
import { BridgeRegistry } from "./bridge.ts";
import {
  asThinkingLevel,
  envDefaults,
  type NamedAgentLaunch,
  type ServerContext,
} from "./context.ts";
import {
  registerDeckBridgeTools,
  registerSupervisorAnswerBridgeTool,
  registerSupervisorListBridgeTool,
} from "./bridgeTools.ts";
import { EngineSkillStore } from "./skills/engineSkillStore.ts";
import { loadSkillEngineNative } from "./skills/skillEngineNative.ts";
import { createDiffGateway, sessionDiffBase } from "./diffGateway.ts";
import { createEditorLauncher } from "./editorLauncher.ts";
import { createScriptRunnerGateway } from "./scriptRunnerGateway.ts";
import { makeCheckpointRollback } from "./checkpointRollback.ts";
import { makeCheckpointService } from "./services/checkpoints.ts";
import { createFileService } from "./services/files.ts";
import { LoopEngine } from "./loopEngine.ts";
import {
  McpManager,
  mergeMcpServerConfigs,
  mcpServerConfigsFromEnv,
  scopeMcpBridgeSpecs,
  type McpServerConfig,
} from "./mcpTools.ts";
import { McpOAuthCoordinator } from "./mcpOAuth.ts";
import { registerMemoryTools } from "./memoryTools.ts";
import { defaultDataDir, ProjectIndex, SessionIndex, SettingsStore } from "./persistence.ts";
import { ReceiptBus } from "./receipts.ts";
import { makeServerRuntime, type ServerRuntime } from "./runtime.ts";
import { registerBridgeRoutes } from "./routes/bridge.ts";
import { registerGitRoutes } from "./routes/git.ts";
import { registerLoopRoutes } from "./routes/loops.ts";
import { registerMcpRoutes } from "./routes/mcp.ts";
import { registerMemoryRoutes } from "./routes/memory.ts";
import { registerProjectRoutes } from "./routes/projects.ts";
import { registerResourceRoutes } from "./routes/resources.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { SessionManager } from "./SessionManager.ts";
import { SessionImageStore } from "./sessionImages.ts";
import { forkSessionAttachmentStores } from "./sessionAttachmentLifecycle.ts";
import { SessionPasteStore } from "./sessionPastes.ts";
import { LoopSessionSnapshotStore } from "./loopSessionSnapshots.ts";
import { SubagentRunStore } from "./subagentRunStore.ts";
import { resolveTrustedDataDir } from "./trustedDataDir.ts";
import { SupervisorLog } from "./supervisor.ts";
import { createTerminalGateway } from "./terminalGateway.ts";
import { setupWebSocket } from "./wsHandler.ts";

/** Child-only tools must not leak into a parent agent's launch allowlist.
 * Parent bridge tools remain eligible because their bridge is actually exposed. */
const BRIDGE_ONLY_TOOLS = new Set(["contact_supervisor"]);

/**
 * The child subagent's supervisor tool. Exposed ONLY through the per-child bridge
 * (never in the parent bridge's specs, so a parent never sees it). Non-blocking
 * `progress_update` acknowledges immediately; the BLOCKING `need_decision` /
 * `interview_request` suspend the child until the supervisor answers, and the
 * answer becomes this tool's result.
 */
const CONTACT_SUPERVISOR_SPEC = {
  name: "contact_supervisor",
  label: "Contact supervisor",
  description:
    "Talk to your supervisor. 'progress_update' reports a short status and returns immediately (non-blocking). 'need_decision' and 'interview_request' ASK the supervisor a question and BLOCK until they answer — the answer is returned to you as the tool result. Use a blocking method only when you genuinely cannot proceed without a decision.",
  parameters: {
    type: "object",
    properties: {
      method: {
        type: "string",
        enum: ["progress_update", "need_decision", "interview_request"],
        description:
          "'progress_update' (non-blocking status), or 'need_decision' / 'interview_request' (block until answered).",
      },
      message: {
        type: "string",
        description:
          "The status (progress_update) or the question/decision to put to the supervisor.",
      },
      title: { type: "string", description: "Optional short title for the request." },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional suggested choices for a need_decision.",
      },
    },
    required: ["method", "message"],
    additionalProperties: false,
  },
  promptSnippet:
    "contact_supervisor — progress_update (non-blocking), or need_decision/interview_request (block for an answer).",
} as const;

export interface AgentDeckServer {
  fastify: FastifyInstance;
  port: number;
  sessions: SessionManager;
  receipts: ReceiptBus;
  /** App-managed tool registry (memory/mcp/subagents register their tools here). */
  bridge: BridgeRegistry;
  /** Records child subagents' contact_supervisor requests (progress_update, …). */
  supervisor: SupervisorLog;
  /** Parent-only structured human decision coordinator. */
  askUser: AskUserCoordinator;
  /**
   * Effect composition seam (Slice 3): the ManagedRuntime serving every
   * `serverLayers` service (runtime.ts). Created per server, disposed in
   * close(). Later slices resolve their services through this.
   */
  runtime: ServerRuntime;
  close(): Promise<void>;
}

export interface StartServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  /** Serve a built web app (apps/web/dist) at /. */
  staticDir?: string;
  /**
   * Inject a semantic-recall embedder (tests). In production, semantic recall is
   * opt-in via AGENT_DECK_SEMANTIC_MEMORY=1, which lazily loads the real
   * on-device embedder; absent both, recall stays lexical+fuzzy (the default).
   */
  memoryEmbedder?: Embedder;
}

export async function startServer(options: StartServerOptions = {}): Promise<AgentDeckServer> {
  // Effect runtime first: services composed in runtime.ts live for exactly the
  // server's lifetime (disposed last in close(), so scoped services from later
  // slices get their finalizers after the HTTP/WS surface is gone).
  const effectRuntime = makeServerRuntime();
  try {
    return await initServer(options, effectRuntime);
  } catch (error) {
    // Startup failed after the runtime existed (e.g. fastify.listen rejecting
    // with EADDRINUSE): run the runtime's finalizers so scoped services
    // (Slice 4+, e.g. pi subprocesses) never leak on the error path.
    try {
      await effectRuntime.dispose();
    } catch {
      // Intentionally swallowed — the original startup error is the one that
      // matters and must not be masked by a dispose failure.
    }
    throw error;
  }
}

/** The body of {@link startServer}; split out so the caller can guarantee
 * `effectRuntime.dispose()` on ANY startup failure without a 400-line try. */
async function initServer(
  options: StartServerOptions,
  effectRuntime: ServerRuntime,
): Promise<AgentDeckServer> {
  const requestedDataDir = options.dataDir ?? defaultDataDir();
  // Establish and validate the trusted app-data directory before any persistence or native
  // capability opens it: create it if missing, reject a linked/reparse root, and resolve ancestor
  // links to one authoritative physical directory for all app-data services below.
  const dataDir = resolveTrustedDataDir(requestedDataDir);
  const receipts = new ReceiptBus(process.env.AGENT_DECK_TEST === "1");
  const index = new SessionIndex(dataDir);
  const sessionImages = new SessionImageStore(dataDir);
  const agentAvatars = new FileAgentAvatarStore(dataDir);
  const sessionPastes = new SessionPasteStore(dataDir);
  // App-managed tool bridge (memory/mcp/subagents register here). The endpoint
  // is only known after listen(), so the factory reads it lazily and returns no
  // extension until both a tool is registered and the address is bound.
  const bridge = new BridgeRegistry();
  // Filled in after listen() binds a port; the factory closure reads it lazily.
  const bridgeAddress: { endpoint?: string } = {};
  // Per-session secret baked into each generated bridge extension. The /bridge
  // route requires a call's token to match its session's, so a local caller
  // can't invoke another session's (project/session-scoped) tools.
  const bridgeTokens = new Map<string, string>();
  // Supervisor channel (native-subagent-bridge.md): a child subagent talks UP to
  // its parent via a contact_supervisor tool. `supervisor` records those requests;
  // `childSupervisors` maps a child's bridge session id → the parent transcript
  // cell its progress flows into. v1 handles non-blocking progress_update only.
  const supervisor = new SupervisorLog();
  const childSupervisors = new Map<string, { parentSessionId: string; cellId: string }>();
  // Blocking supervisor requests awaiting an answer: requestId → resolver. The
  // child's contact_supervisor call is suspended on the /bridge request until
  // answerSupervisor() (via POST /supervisor/:id/answer) settles it.
  const pendingSupervisor = new Map<
    string,
    {
      parentSessionId: string;
      childSessionId: string;
      settle: (result: { content: string; isError?: boolean }) => void;
    }
  >();
  // Native memory (memory.md), on by default like the native app; storage under
  // the app data dir. AGENT_DECK_MEMORY=0 disables it entirely.
  const memoryEnabled = process.env.AGENT_DECK_MEMORY !== "0";
  const memoryBaseDir = nodePath.join(dataDir, "memory");
  // Construct the deletion authority once from trusted app data. Its held native
  // direct-child capability and authoritative physical path own ordinary session
  // worktrees for this server lifetime. Loop uses only the dedicated `loop`
  // child, which the ordinary-session leaf policy can never select.
  const sessionWorktreeStore = new SessionWorktreeStore(dataDir);
  const worktreesRoot = sessionWorktreeStore.rootPath;

  // Recall engine. Lexical+fuzzy is the always-on default; SEMANTIC recall is
  // opt-in — an injected embedder (tests) or AGENT_DECK_SEMANTIC_MEMORY=1 (which
  // lazily loads the real on-device embedder, kept out of the base install). The
  // embedder is loaded once and reused; if it fails to load, recall silently
  // stays lexical. Every search path (bridge tool, /memory/search, recall hook)
  // routes through recallMemories so semantic applies everywhere when enabled.
  const semanticMemoryEnabled =
    options.memoryEmbedder !== undefined || process.env.AGENT_DECK_SEMANTIC_MEMORY === "1";
  let embedderPromise: Promise<Embedder> | undefined;
  let embedderFailed = false;
  async function resolveEmbedder(): Promise<Embedder | undefined> {
    if (options.memoryEmbedder) return options.memoryEmbedder;
    if (process.env.AGENT_DECK_SEMANTIC_MEMORY !== "1" || embedderFailed) return undefined;
    if (!embedderPromise) embedderPromise = createOnDeviceEmbedder();
    try {
      return await embedderPromise;
    } catch (error) {
      embedderPromise = undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof EmbedderUnavailableError) {
        // A missing optional dep can't appear without a restart — stop retrying.
        embedderFailed = true;
        console.warn(`[memory] semantic recall unavailable, using lexical: ${message}`);
      } else {
        // A transient init failure (e.g. first-run model download) — allow retry.
        console.warn(
          `[memory] semantic embedder init failed (will retry), using lexical: ${message}`,
        );
      }
      return undefined;
    }
  }
  async function recallMemories(
    store: MemoryStore,
    query: string,
    limit?: number,
  ): Promise<MemorySearchHit[]> {
    if (!semanticMemoryEnabled) return searchMemories(store, query, limit);
    const embedder = await resolveEmbedder();
    // semanticSearchMemories itself falls back to lexical if an embed call throws.
    return embedder
      ? semanticSearchMemories(store, query, embedder, limit === undefined ? {} : { limit })
      : searchMemories(store, query, limit);
  }

  // `broadcast` lives in the WebSocket layer (wsHandler.ts) and
  // `cancelChildSupervisorRequests` in the bridge/supervisor route module —
  // both are wired up below, after the state they need exists. The closures
  // created here only capture the bindings and never run before assignment;
  // the throwing initializers keep any unexpected early call failing fast.
  let broadcast: (message: ServerMessage) => void = () => {
    throw new Error("broadcast called before the WebSocket layer was set up");
  };
  let broadcastDiff: (message: DiffPush) => void = () => {
    throw new Error("broadcastDiff called before the WebSocket layer was set up");
  };
  let cancelChildSupervisorRequests: (childSessionId: string) => void = () => {
    throw new Error("cancelChildSupervisorRequests called before the bridge routes registered");
  };

  // Slice 9: per-session changed-file tracking + on-demand diffs, resolved
  // through the runtime's SessionDiff service (see services/diff.ts).
  const diffs = createDiffGateway(effectRuntime);
  // Slice 18a: per-turn checkpoint capture (conversation-file snapshot + hidden
  // git-ref of the worktree) + the checkpoints_list op. Config-bound to the data
  // dir, so built directly here (not a runtime layer) — see services/checkpoints.ts.
  const checkpoints = makeCheckpointService({ dataDir });
  const loopSnapshots = new LoopSessionSnapshotStore(dataDir, (message, error) =>
    fastify.log.warn({ err: error }, message),
  );
  const subagentRuns = new SubagentRunStore(dataDir, (message, error) =>
    console.warn(`[subagent-runs] ${message}`, error),
  );

  const sessions: SessionManager = new SessionManager(
    effectRuntime,
    receipts,
    (meta) => {
      // User activity (create / resume / prompt / title) floats the session up
      // the most-recent-first list. Process exit is NOT activity: an ended or
      // crashed session keeps its last-active time instead of jumping to the top
      // (resume clears endedAt, so it re-floats correctly).
      if (!meta.endedAt) meta.updatedAt = new Date().toISOString();
      index.upsert(meta);
      // An ended session's changed-file cache is stale by definition — drop it
      // (a resume recomputes at the next turn boundary).
      if (meta.endedAt) {
        diffs.drop(meta.id);
        if (meta.projectId && mcp) void reconcileProjectMcp(meta.projectId);
      }
      // `broadcast` is initialized during startServer, before any meta changes.
      broadcast({ type: "session_meta", session: meta });
    },
    () => envDefaults().providerExtensions,
    (meta) => {
      if (bridge.size === 0 || !bridgeAddress.endpoint) return undefined;
      const token = randomUUID();
      bridgeTokens.set(meta.id, token);
      // Per-session MCP scoping: project assignment is the execution trust grant.
      // Plain sessions see assigned servers; named-agent policy can only narrow that set.
      // Non-MCP bridge tools remain independently available.
      const scope = meta.projectId;
      const nonMcpTools = bridge.specs().filter((spec) => !spec.name.startsWith("mcp__"));
      let tools = scope ? [...nonMcpTools, ...mcp.specs(scope)] : nonMcpTools;
      const allow = mcpAllowlistForSession(meta);
      tools = scopeMcpBridgeSpecs(tools, allow);
      return writeBridgeExtension({
        endpoint: bridgeAddress.endpoint,
        sessionId: meta.id,
        token,
        tools,
        // The generated bridge is appended after every provider/user extension.
        // Its single final hook applies recall first, then captures the exact
        // chained prompt Pi will use for this turn.
        recall: memoryEnabled,
        promptAudit: true,
      });
    },
    (cwd, home) => {
      // Parent system-prompt appends. When memory is off we add nothing, so pi
      // auto-discovers APPEND_SYSTEM.md itself. When on, we inject the memory
      // block — which suppresses that discovery — so we re-add the resolved
      // APPEND_SYSTEM.md path FIRST, then the memory block. Both are passed as
      // FILE PATHS (pi reads a path entry as a file): a multi-line literal
      // --append value is truncated on Windows, where pi runs via a .cmd shim
      // through cmd.exe. `home` is the pi child's HOME so the global
      // APPEND_SYSTEM.md resolves where pi would find it.
      if (!memoryEnabled) return { appends: [] };
      const appends: string[] = [];
      const appendPath = appendSystemPromptPath({ home, projectPath: cwd });
      if (appendPath) appends.push(appendPath);
      const block = buildMemoryPreamble(
        injectableIndex({ baseDir: memoryBaseDir, projectPath: cwd }),
      );
      const cleanupDir = mkdtempSync(nodePath.join(tmpdir(), "agent-deck-mem-append-"));
      const blockFile = nodePath.join(cleanupDir, "memory.md");
      writeFileSync(blockFile, block, "utf8");
      appends.push(blockFile);
      return { appends, cleanupDir };
    },
    // Child subagent supervisor bridge: registers a child-scoped bridge token +
    // supervisor route, and generates an extension exposing ONLY contact_supervisor
    // (never in the parent bridge's specs, so parents never get it). dispose()
    // tears the whole thing down after the child exits.
    (childSessionId, route) => {
      if (!bridgeAddress.endpoint) return undefined;
      const token = randomUUID();
      // Generate the extension FIRST; only register the token + route if it
      // succeeds, so a writeBridgeExtension failure can't leak map entries with
      // no dispose() to clean them (dispose is only returned on success).
      const extension = writeBridgeExtension({
        endpoint: bridgeAddress.endpoint,
        sessionId: childSessionId,
        token,
        tools: [CONTACT_SUPERVISOR_SPEC],
      });
      bridgeTokens.set(childSessionId, token);
      childSupervisors.set(childSessionId, route);
      return {
        extension,
        dispose: () => {
          // Release any still-pending blocking supervisor requests so a dead
          // child's suspended tool call doesn't linger until the timeout.
          cancelChildSupervisorRequests(childSessionId);
          bridgeTokens.delete(childSessionId);
          childSupervisors.delete(childSessionId);
          try {
            rmSync(nodePath.dirname(extension), { recursive: true, force: true });
          } catch {
            // Best-effort: a leftover temp dir is harmless.
          }
        },
      };
    },
    // Resolve a named agent for `managed_subagent{agent}` delegation, scoped to
    // the delegating session's project. Invoked only at subagent-run time, so the
    // forward reference to `resolveNamedAgent`/`rootsFor` (defined below) is
    // resolved by then. A disabled or missing agent isn't delegatable → undefined.
    (name, projectId) => {
      const resolved = resolveNamedAgent(name, projectId);
      if (resolved.status === "invalid") return { error: resolved.error };
      if (resolved.status !== "ok") return undefined;
      const { agent } = resolved;
      return {
        body: agent.body,
        model: agent.model,
        thinking: asThinkingLevel(agent.thinking),
        tools: agent.tools,
        mcpDirectTools: agent.mcpDirectTools,
        skillDirs: agent.skillDirs,
        defaultReads: agent.defaultReads,
        defaultExpectedOutcome: agent.defaultExpectedOutcome ?? "reportOnly",
        output: agent.output,
        extensions: agent.extensions,
      };
    },
    // Live autoTitle preference (native OnboardingPreferencesView). `settings` is
    // declared below; this closure only runs at title time, long after startup.
    () => settings.get().autoTitle,
    // Slice 9 turn-boundary hook: refresh the session's changed-file set when a
    // turn reaches idle; when the set CHANGED vs the previous one, push it to
    // clients and emit the diff_refreshed receipt (tests synchronize on it).
    async (meta) => {
      const base = await sessionDiffBase(meta);
      const { changed, set } = await diffs.refresh(meta.id, meta.cwd, base);
      if (!changed) return;
      broadcastDiff({
        type: "diff_changed",
        sessionId: meta.id,
        repo: set.repo,
        files: [...set.files],
        truncated: set.truncated,
      });
      receipts.emit("diff_refreshed", meta.id);
    },
    // Slice 18a checkpoint-capture hook: at each turn boundary (after the
    // session-file handle is flushed) snapshot the conversation + capture the
    // worktree as a hidden git ref. Runs in its OWN forked fiber, separate from
    // the diff refresh above, so it never perturbs the idle / diff_refreshed
    // receipt timing. Best-effort — a capture failure is swallowed by the
    // facade; the receipt lets tests synchronize on the capture attempt.
    async (meta, label) => {
      await checkpoints.capture({
        sessionId: meta.id,
        cwd: meta.worktreePath ?? meta.cwd,
        sessionFile: meta.piSessionFile,
        label,
      });
      receipts.emit("checkpoint_captured", meta.id);
    },
    loopSnapshots,
    subagentRuns,
    (sessionId, cell, rawContent) => {
      let decorated = cell;
      try {
        decorated = sessionImages.attachToUserCell(sessionId, decorated, rawContent);
      } catch {
        // Corrupt/missing image metadata never drops user text or later metadata.
      }
      try {
        decorated = sessionPastes.attachToUserCell(sessionId, decorated, rawContent);
      } catch {
        // Corrupt/missing paste metadata never drops user text or image metadata.
      }
      return decorated;
    },
    (sourceSessionId, targetSessionId) => {
      return forkSessionAttachmentStores(
        [sessionImages, sessionPastes],
        sourceSessionId,
        targetSessionId,
      );
    },
    (sessionId, users) => {
      try {
        sessionImages.reconcileHistory(sessionId, users);
      } catch {
        // Image cleanup is conservative and must not make an otherwise valid resume fail.
      }
      try {
        sessionPastes.reconcileHistory(sessionId, users);
      } catch {
        // Paste cleanup is conservative and must not make an otherwise valid resume fail.
      }
    },
    (sessionId) => {
      try {
        sessionImages.expirePending(sessionId);
      } catch {
        // Image cleanup must not perturb session failure or shutdown.
      }
      try {
        sessionPastes.expirePending(sessionId);
      } catch {
        // Paste cleanup must not perturb session failure or shutdown.
      }
    },
  );
  // Loop run engine (native single-agent loop). Each run's agent executor is
  // built per-run, bound to a parent session in the project cwd.
  const loopEngine = new LoopEngine({
    dataDir,
    warn: (message, error) => fastify.log.warn({ err: error }, message),
  });
  // Interactive provider OAuth login relay (native PiProviderLoginService).
  const providerLogin = new ProviderLoginManager();
  const projects = new ProjectIndex(dataDir);
  const settings = new SettingsStore(dataDir);
  const parkingSettings = settings.get();
  sessions.configureIdleParking(
    parkingSettings.piAgentIdleParkingEnabled
      ? parkingSettings.piAgentIdleParkingTimeoutMinutes * 60_000
      : null,
    (meta) => {
      // Parking is runtime resource management, never conversation activity.
      index.upsert(meta);
      broadcast({ type: "session_meta", session: meta });
    },
    (sessionId) => broadcast({ type: "session_rebind", sessionId }),
  );

  // Resolve a named agent to the launch inputs a session (parent-backed OR a
  // delegated subagent) adopts, scoped to a project. One source of truth for
  // "launch a pi session from a named agent definition" — the agent-backed
  // /sessions route and the managed_subagent{agent} delegation share it, so a
  // subagent inherits the SAME persona/model/thinking/skills the parent launch
  // would. `not_found`/`disabled` are distinguished for the route's status codes.
  function resolveNamedAgent(
    name: string,
    projectId?: string,
  ):
    | { status: "ok"; agent: NamedAgentLaunch }
    | { status: "not_found" }
    | { status: "disabled" }
    | { status: "invalid"; error: string } {
    const roots = rootsFor(projectId);
    const project = projectId ? projects.find((item) => item.id === projectId) : undefined;
    const agent = scanAgents(roots).find((a) => a.name === name && !a.shadowed);
    // Missing and unassigned are deliberately indistinguishable to direct
    // launch/delegation callers. Disabled is reported only for an otherwise
    // curated agent so stale assignments never widen access.
    if (!agent || !projectAllowsAgent(project, agent)) return { status: "not_found" };
    if (agent.disabled) return { status: "disabled" };
    const skills = resolveExplicitSkills({
      agentName: agent.name,
      skillNames: agent.skills ?? [],
      candidates: scanSkillCandidates(roots),
      disabledSkills: new Set(settings.get().disabledSkills),
      strict: true,
      tools: agent.tools,
      toolsExplicit: agent.toolsExplicit,
    });
    if (skills.status === "error") return { status: "invalid", error: skills.message };
    return {
      status: "ok",
      agent: {
        body: agent.body,
        systemPromptMode: agent.systemPromptMode,
        model: agent.model,
        thinking: agent.thinking,
        tools: agent.tools?.filter((tool) => !BRIDGE_ONLY_TOOLS.has(tool)),
        mcpDirectTools: agent.mcpDirectTools,
        skillDirs: skills.skillDirs,
        extensions: enabledExtensionPaths(projectId, agent.extensions),
        mcpServers: agent.mcpServers ?? [],
        defaultReads: agent.defaultReads,
        defaultExpectedOutcome: agent.defaultExpectedOutcome ?? "reportOnly",
        output: agent.output,
      },
    };
  }

  // Which app-bridge tool a user extension conflicts with (else null). Reading the
  // source is best-effort: an unreadable file simply isn't flagged. pi hard-fails
  // to launch when two extensions register the same tool, so a conflicting one is
  // excluded from the launch (below) rather than allowed to crash the session.
  function extensionBridgeConflictAt(filePath: string): string | null {
    try {
      return extensionBridgeConflict(readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  // The user extensions to inject at launch: the manually-added registry PLUS the
  // ones DISCOVERED in the standard pi dirs (global + this project's), minus any
  // disabled or bridge-conflicting, deduped by absolute path. (App-generated
  // bridge extensions are added separately by the launch, never here.) A disabled
  // flag is keyed by the absolute path, so it applies to discovered and added
  // alike. Excluding bridge-conflicting extensions is a SAFETY requirement: pi
  // crashes if a user extension re-registers a bridge tool name.
  function enabledExtensionPaths(projectId?: string, allowlist?: readonly string[]): string[] {
    // "agentDeckManaged" (native PiAgentExtensionLoadingMode): load ONLY the app
    // bridges — neither defaults nor an agent-authored path may bypass this mode.
    if (settings.get().extensionLoadingMode === "agentDeckManaged") return [];
    const disabled = new Set(
      settings.get().disabledExtensions.map((entry) => nodePath.resolve(entry)),
    );
    const registry = settings.get().extensions.map((entry) => nodePath.resolve(entry));
    const discovered = scanExtensions(rootsFor(projectId)).map((entry) =>
      nodePath.resolve(entry.path),
    );
    const catalog = [...new Set([...registry, ...discovered])];
    const requested =
      allowlist === undefined ? catalog : allowlist.map((entry) => nodePath.resolve(entry));
    const catalogSet = new Set(catalog);
    return [...new Set(requested)].filter((entry) => {
      // Agent metadata can only narrow the current extension catalog. Package
      // refs, stale paths, directories, disabled files, and bridge conflicts
      // remain authored for diagnosis but fail closed at execution.
      if (
        !catalogSet.has(entry) ||
        disabled.has(entry) ||
        extensionBridgeConflictAt(entry) !== null
      ) {
        return false;
      }
      try {
        return statSync(entry).isFile();
      } catch {
        return false;
      }
    });
  }

  // Native memory tools (memory.md), registered on the bridge and scoped to each
  // session's project via its cwd. The launch-time index/policy injection is
  // handled by the parent-append factory above.
  if (memoryEnabled) {
    registerMemoryTools(
      bridge,
      memoryBaseDir,
      (sessionId) => sessions.get(sessionId)?.meta.cwd,
      recallMemories,
    );
  }

  // Parent-only human decision bridge. It is intentionally separate from the
  // Deck-agent bridge inventory and is never included in a child extension.
  const askUser = new AskUserCoordinator(sessions, (sessionId) => bridgeTokens.get(sessionId));
  registerAskUserBridgeTool(bridge, askUser);

  // Native subagents, supervisor listing, and the session activity plan: the
  // Deck-agent bridge tools every parent session gets.
  registerDeckBridgeTools(bridge, sessions);
  registerSupervisorListBridgeTool(bridge, supervisor);

  // Resource scanning follows the Pi subprocess HOME override so scanners,
  // configuration reloads, and Pi all observe the same user-owned files.
  const resourceHome = (): string => {
    const piEnv = envDefaults().env;
    return piEnv?.HOME ?? homedir();
  };

  const rootsFor = (projectId?: string): ResourceRoots => ({
    home: resourceHome(),
    projectPath: projectId ? projects.find((p) => p.id === projectId)?.path : undefined,
  });
  const scanSkillsFor = (projectId?: string) => scanSkills(rootsFor(projectId));
  const scanSkillCandidatesFor = (projectId?: string) => scanSkillCandidates(rootsFor(projectId));

  const createAgentWarningContext = (projectId?: string) => {
    const roots = rootsFor(projectId);
    const skillCandidateCounts = new Map<string, number>();
    for (const skill of scanSkillCandidates(roots)) {
      skillCandidateCounts.set(skill.name, (skillCandidateCounts.get(skill.name) ?? 0) + 1);
    }
    const inheritedExa = envDefaults().env?.EXA_API_KEY ?? process.env.EXA_API_KEY;
    return {
      skillCandidateCounts,
      disabledSkills: new Set(settings.get().disabledSkills),
      exaConfigured:
        (typeof inheritedExa === "string" && inheritedExa.trim().length > 0) ||
        hasEffectiveEnvValue(scanEnv(roots), "EXA_API_KEY"),
      projectSelected: Boolean(roots.projectPath),
    };
  };

  // Catalog definitions are inert until a project or named agent explicitly
  // assigns their id. Per-project catalogs merge global < project < environment.
  const mcpEnvConfigs = mcpServerConfigsFromEnv(process.env.AGENT_DECK_MCP_SERVERS);
  // MCP OAuth (native MCPOAuthService): authed http servers get a per-server
  // OAuth provider whose tokens persist under the app data dir. The redirect
  // target is where the browser lands after authorization; the loopback capture
  // of that redirect is finalized in the UI slice (env-overridable meanwhile).
  const mcpOAuth = new McpOAuthCoordinator({
    store: new FileMcpOAuthStore(nodePath.join(dataDir, "mcp-oauth")),
    redirectUrl:
      process.env.AGENT_DECK_MCP_OAUTH_REDIRECT ?? "http://127.0.0.1:33418/mcp/oauth/callback",
  });
  const oauthKey = (scope: string, id: string): string => `${scope}::${id}`;
  const mcp: McpManager = new McpManager(bridge, {
    httpAuthProvider: (scope, id) => mcpOAuth.providerFor(oauthKey(scope, id)),
    scopeForSession: (sessionId) => sessions.get(sessionId)?.meta.projectId,
    allowServerForSession: (sessionId, serverId) => {
      const meta = sessions.get(sessionId)?.meta;
      return meta ? mcpAllowlistForSession(meta).includes(serverId) : false;
    },
  });

  const globalMcpConfigs = (): { configs: McpServerConfig[]; valid: boolean } => {
    const catalog = readMcpServerCatalog(rootsFor());
    const fromFile = catalog.servers.flatMap((entry): McpServerConfig[] => {
      if (entry.transport === "http" && entry.url) return [{ id: entry.id, url: entry.url }];
      if (entry.command)
        return [{ id: entry.id, command: entry.command, args: entry.args, env: entry.env }];
      return [];
    });
    return { configs: mergeMcpServerConfigs(fromFile, mcpEnvConfigs), valid: catalog.valid };
  };

  const effectiveMcpConfigs = (
    projectId: string,
  ): { configs: McpServerConfig[]; valid: boolean } => {
    const catalog = readMcpServerCatalog(rootsFor(projectId));
    const fromFile = catalog.servers.flatMap((entry): McpServerConfig[] => {
      if (entry.transport === "http" && entry.url) return [{ id: entry.id, url: entry.url }];
      if (entry.command)
        return [{ id: entry.id, command: entry.command, args: entry.args, env: entry.env }];
      return [];
    });
    return {
      configs: mergeMcpServerConfigs(fromFile, mcpEnvConfigs),
      valid: catalog.valid,
    };
  };

  const pendingMcpSessionStarts = new Map<string, Map<string, number>>();
  const namedMcpIdsForLiveProject = (projectId: string): string[] => [
    ...sessions
      .list()
      .filter((meta) => meta.projectId === projectId && !meta.endedAt && meta.agentName)
      .flatMap((meta) => mcpAllowlistForSession(meta)),
    ...[...(pendingMcpSessionStarts.get(projectId)?.keys() ?? [])],
  ];

  const reconcileProjectMcp = async (
    projectId: string,
    extraIds: readonly string[] = [],
  ): Promise<{ ok: true; missing: string[] } | { ok: false; error: string }> => {
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      await mcp.reconcile([], projectId);
      return { ok: true, missing: [] };
    }
    const wanted = new Set([
      ...(project.assignedMcpServers ?? []),
      ...namedMcpIdsForLiveProject(projectId),
      ...extraIds,
    ]);
    const snapshot = effectiveMcpConfigs(projectId);
    if (!snapshot.valid) {
      // Parsing failure cannot authorize anything new. Keep only already-live
      // clients that remain explicitly assigned, so unassignment still tears
      // down deterministically without disturbing this scope's other clients.
      await mcp.retain(projectId, wanted);
      return {
        ok: false,
        error:
          "Global or project .pi/mcp.json is not valid JSON; assigned live connections were preserved and no new server was executed.",
      };
    }
    const byId = new Map(snapshot.configs.map((config) => [config.id, config]));
    const missing = [...wanted].filter((id) => !byId.has(id));
    await mcp.reconcile(
      [...wanted].flatMap((id) => {
        const config = byId.get(id);
        return config ? [config] : [];
      }),
      projectId,
    );
    return { ok: true, missing };
  };

  const prepareProjectMcpSession = async (projectId: string, serverIds: readonly string[]) => {
    const counts = pendingMcpSessionStarts.get(projectId) ?? new Map<string, number>();
    pendingMcpSessionStarts.set(projectId, counts);
    for (const id of new Set(serverIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      for (const id of new Set(serverIds)) {
        const next = (counts.get(id) ?? 1) - 1;
        if (next > 0) counts.set(id, next);
        else counts.delete(id);
      }
      if (counts.size === 0) pendingMcpSessionStarts.delete(projectId);
      await reconcileProjectMcp(projectId);
    };
    return { result: await reconcileProjectMcp(projectId), release };
  };

  // Missing assignment fields intentionally mean no servers. Repository config
  // is parsed but never connected until an explicit project/agent assignment exists.
  for (const project of projects.list()) await reconcileProjectMcp(project.id);

  const reloadMcpConfig = async (
    projectId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    const targets = projectId ? [projectId] : projects.list().map((project) => project.id);
    const errors: string[] = [];
    for (const id of targets) {
      const result = await reconcileProjectMcp(id);
      if (!result.ok) errors.push(result.error);
    }
    return errors.length > 0 ? { ok: false, error: [...new Set(errors)].join(" ") } : { ok: true };
  };

  const fastify = Fastify({ logger: false });

  // Shutdown admission barrier. Requests admitted before shutdown are allowed
  // to finish, including create/resume transactions that publish a session only
  // near the end of their handler. Once closing begins, later HTTP requests fail
  // with a stable response and the close path waits for every admitted handler
  // before SessionManager snapshots its owned sessions.
  let shuttingDown = false;
  let admittedRequests = 0;
  let admissionDrain: Promise<void> | undefined;
  let resolveAdmissionDrain: (() => void) | undefined;
  const requestReleases = new WeakMap<object, () => void>();
  fastify.addHook("onRequest", async (request, reply) => {
    if (shuttingDown) {
      return reply.status(503).send({
        code: "server_shutting_down",
        error: "Agent Deck server is shutting down.",
      });
    }
    admittedRequests += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      requestReleases.delete(request);
      admittedRequests -= 1;
      if (admittedRequests === 0) {
        resolveAdmissionDrain?.();
        resolveAdmissionDrain = undefined;
      }
    };
    requestReleases.set(request, release);
  });
  // onSend runs only after the route handler has settled, unlike socket abort/
  // close signals: an HTTP client may disconnect while an accepted create is
  // still publishing its session. The later hooks are idempotent fallbacks for
  // error and transport completion paths.
  fastify.addHook("onSend", async (request, _reply, payload) => {
    requestReleases.get(request)?.();
    return payload;
  });
  fastify.addHook("onError", async (request) => {
    requestReleases.get(request)?.();
  });
  fastify.addHook("onResponse", async (request) => {
    requestReleases.get(request)?.();
  });
  const closeHttpAdmission = (): void => {
    shuttingDown = true;
  };
  const drainHttpRequests = (): Promise<void> => {
    if (admissionDrain) return admissionDrain;
    admissionDrain =
      admittedRequests === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            resolveAdmissionDrain = resolve;
          });
    return admissionDrain;
  };

  if (options.staticDir) {
    await fastify.register(fastifyStatic, { root: options.staticDir });
  }

  fastify.get("/health", async () => ({ ok: true }));

  // Lazy transcript-image capability. Every failure is deliberately identical:
  // callers learn neither whether a session/ref exists nor why validation failed.
  fastify.get("/session-images/:sessionId/:imageId", async (request, reply) => {
    const { sessionId, imageId } = request.params as { sessionId: string; imageId: string };
    const token = (request.query as { token?: unknown }).token;
    const notFound = () =>
      reply
        .code(404)
        .headers({
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "referrer-policy": "no-referrer",
          "cross-origin-resource-policy": "same-origin",
        })
        .send();
    if (!sessionImages.validToken(token)) return notFound();
    const known = sessions.get(sessionId)?.meta ?? index.find((item) => item.id === sessionId);
    if (!known) return notFound();
    const image = sessionImages.read(sessionId, imageId);
    if (!image) return notFound();
    return reply
      .headers({
        "content-type": image.mimeType,
        "content-length": String(image.data.length),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
        "cross-origin-resource-policy": "same-origin",
      })
      .send(image.data);
  });

  // The MCP-server allowlist for a session: project assignment grants execution.
  // A plain session gets that assignment set; a named agent intersects its declared
  // mcpServers with the same set and can therefore narrow, never widen, trust.
  // Function declaration lets the earlier bridge-extension factory call it.
  function mcpAllowlistForSession(meta: SessionMeta): string[] {
    if (!meta.projectId) return [];
    const assigned = new Set(
      projects.find((project) => project.id === meta.projectId)?.assignedMcpServers ?? [],
    );
    if (!meta.agentName) return [...assigned];
    const agent = scanAgents(rootsFor(meta.projectId)).find(
      (a) => a.name === meta.agentName && !a.shadowed,
    );
    // Agent policy can narrow project-granted MCP capability, never grant it.
    return (agent?.mcpServers ?? []).filter((id) => assigned.has(id));
  }

  // WebSocket layer (wsHandler.ts): socket accept, subscribe/replay,
  // client-message dispatch. Set up before the route modules register so
  // `broadcast` is live when they capture it.
  // Slice 8a: per-session terminal PTYs, scope-owned through the runtime.
  // Held here (not just inside the WS layer) so close() can run the awaited
  // closeAll() sweep — terminal scopes are detached roots dispose() can't reap.
  const terminals = createTerminalGateway(effectRuntime);
  // Slice 11: editor detection + open-in-editor launches (editorLauncher.ts).
  const editors = createEditorLauncher();
  // Slice 13a: file-navigation endpoints (services/files.ts) — directory browse
  // + bounded file read, containment-gated to each session's project cwd.
  const files = createFileService();
  // Slice 15a: per-session project-script runs (dev servers) + port discovery,
  // scope-owned through the runtime. Held here (like terminals) so close() can
  // run the awaited closeAll() sweep — run scopes are detached roots.
  const scripts = createScriptRunnerGateway(effectRuntime);
  // Slice 18b: checkpoint rollback orchestrator. Its `reopen` relaunches an
  // ended session EXACTLY as the POST /sessions/:id/resume route does (same
  // env-derived fallback plan), so rollback reuses the one correct resume() path.
  const rollback = makeCheckpointRollback({
    sessions,
    checkpoints,
    receipts,
    reopen: (meta) => {
      const defaults = envDefaults();
      return sessions.resume(
        meta,
        {
          kind: "parent",
          resumeSessionPath: meta.piSessionFile,
          provider: defaults.provider,
          model: defaults.model,
          extensions: [...(defaults.extensions ?? []), ...(defaults.providerExtensions ?? [])],
        },
        defaults.env,
      );
    },
  });
  const {
    closeAdmission: closeWebSocketAdmission,
    drain: drainWebSocketOperations,
    close: closeWebSockets,
    broadcast: wsBroadcast,
    broadcastDiff: wsBroadcastDiff,
  } = setupWebSocket({
    fastify,
    sessions,
    terminals,
    diffs,
    editors,
    files,
    scripts,
    checkpoints,
    rollback,
    sessionImages,
    sessionPastes,
  });
  broadcast = wsBroadcast;
  broadcastDiff = wsBroadcastDiff;

  // Resource watcher: any change under the resource catalogs re-broadcasts so the UI refreshes.
  const resourceWatcher = watchResources({ home: resourceHome() }, () => {
    broadcast({ type: "resources_changed" });
  });
  const watchedProjects = new Set<string>();
  const watchProject = (projectPath: string): void => {
    if (watchedProjects.has(projectPath)) return;
    watchedProjects.add(projectPath);
    const dirs = projectWatchDirs(projectPath);
    // Register through addResourceWatchPaths (not a bare watcher.add): it records
    // the dirs as watch targets so the `ignored`/isRelevant predicate treats their
    // events as relevant — a bare add would be silently filtered out.
    if (dirs.length > 0) addResourceWatchPaths(resourceWatcher, dirs, projectPath);
  };
  for (const project of projects.list()) watchProject(project.path);

  // The skill catalog/authoring/version seam (ADR-0002 P3): reads stay agent-deck's
  // pi-shaped scanner; writes/recovery go to the shared @a-streetcoder skill engine
  // behind the same SkillStore interface. The engine owns storage now, so its addon is
  // required — loadSkillEngineNative() surfaces a clear, actionable error if it can't load.
  const skillStore = new EngineSkillStore({
    engine: await loadSkillEngineNative(),
    scanSkillsFor,
    home: resourceHome(),
    projectRootFor: (projectId) => rootsFor(projectId).projectPath,
  });

  // The shared context the route modules read (Slice 2 decomposition): one
  // object, assembled once, so every moved handler body reads exactly as it
  // did in the monolith.
  const ctx: ServerContext = {
    fastify,
    sessions,
    sessionImages,
    agentAvatars,
    sessionPastes,
    index,
    projects,
    settings,
    bridge,
    bridgeTokens,
    askUser,
    supervisor,
    childSupervisors,
    pendingSupervisor,
    loopEngine,
    providerLogin,
    mcp,
    mcpOAuth,
    reloadMcpConfig,
    reconcileProjectMcp,
    prepareProjectMcpSession,
    effectiveMcpConfigs,
    globalMcpConfigs,
    isMcpEnvOverride: (id) => mcpEnvConfigs.some((config) => config.id === id),
    oauthKey,
    memoryEnabled,
    memoryBaseDir,
    worktreesRoot,
    sessionWorktreeStore,
    recallMemories,
    resolveNamedAgent,
    extensionBridgeConflictAt,
    enabledExtensionPaths,
    resourceHome,
    rootsFor,
    scanSkillsFor,
    scanSkillCandidatesFor,
    createAgentWarningContext,
    skillStore,
    broadcast,
    watchProject,
    dropDiffCache: (sessionId) => diffs.drop(sessionId),
  };

  // Route modules. Fastify's router matches on method + path (never on
  // registration order), so grouping the routes by module preserves behavior;
  // within each module the original registration order is unchanged.
  registerResourceRoutes(ctx);
  registerMemoryRoutes(ctx);
  registerMcpRoutes(ctx);
  registerSettingsRoutes(ctx);
  registerGitRoutes(ctx);
  registerLoopRoutes(ctx);
  registerProjectRoutes(ctx);
  registerSessionRoutes(ctx);
  const bridgeRouteHandles = registerBridgeRoutes(ctx);
  ({ cancelChildSupervisorRequests } = bridgeRouteHandles);
  // This parent-only tool delegates to the route coordinator's exactly-once
  // settlement path. Register only after that coordinator and its handles exist.
  registerSupervisorAnswerBridgeTool(bridge, bridgeRouteHandles);

  await fastify.listen({ port: options.port ?? 0, host: options.host ?? "127.0.0.1" });
  const address = fastify.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  // Now that the port is bound, bridge extensions can target this server. The
  // pi subprocess is always local, so loopback is correct regardless of host.
  bridgeAddress.endpoint = `http://127.0.0.1:${port}/bridge`;

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      // Teardown is fault-tolerant: one failing subsystem must not stop the
      // rest from closing, and the Effect runtime's finalizers (scoped
      // services, Slice 4+) must run even when an earlier step throws — hence
      // per-step error collection plus `finally` around dispose().
      const errors: unknown[] = [];
      const step = async (run: () => unknown): Promise<void> => {
        try {
          await run();
        } catch (error) {
          errors.push(error);
        }
      };
      try {
        // Close both admission paths synchronously in one event-loop turn.
        // Existing sockets are asked to close and later frames/upgrades fail.
        closeHttpAdmission();
        closeWebSocketAdmission();
        await step(() => resourceWatcher.close());
        // Settle blocking bridge waits before draining their admitted requests.
        await step(() => askUser.close());
        // First pass stops every session visible when shutdown began. Session
        // teardown also settles child supervisor bridge calls.
        await step(() => sessions.stopAll());
        // Pre-admitted HTTP handlers and already-dispatched WS frames may now
        // finish rollback/publication without deadlocking on stopped sessions.
        await step(() => Promise.all([drainHttpRequests(), drainWebSocketOperations()]));
        // Catch a resume/rebind published after the first stopAll snapshot.
        await step(() => sessions.stopAll());
        await step(() => mcp.close());
        await step(() => closeWebSockets());
        // Deterministic terminal teardown (the sessions.stopAll() analogue):
        // socket-close teardown is fire-and-forget and terminal scopes are
        // detached roots, so await the PTY kills BEFORE dispose() below.
        await step(() => terminals.closeAll());
        // Same deterministic teardown for script runs (detached root scopes):
        // tree-kill every dev server before dispose().
        await step(() => scripts.closeAll());
        await step(() => fastify.close());
        // Sessions and the transport are stopped, so no new native filesystem
        // operations can begin. Release each held root independently before the
        // app-data owner is allowed to remove it (notably on Windows).
        await step(() => subagentRuns.close());
        await step(() => sessionWorktreeStore.close());
      } finally {
        // Dispose LAST, after the HTTP/WS surface is gone (see startServer).
        await effectRuntime.dispose();
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "agent-deck server close failed");
    })();
    return closePromise;
  };

  return {
    fastify,
    port,
    sessions,
    receipts,
    bridge,
    supervisor,
    askUser,
    runtime: effectRuntime,
    close,
  };
}
