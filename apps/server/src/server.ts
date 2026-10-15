import {
  FileComposerDraftStore,
  registerComposerDraftRoutes,
  type ComposerDraftStore,
} from "./composerDrafts.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath from "node:path";
import type { DiffPush, ServerMessage, SessionMeta } from "@agent-deck/contracts";
import { extensionBridgeConflict } from "@agent-deck/domain";
import {
  addResourceWatchPaths,
  appendSystemPromptPath,
  piAgentHome,
  projectWatchDirs,
  readMcpServerCatalog,
  resolveCodexPluginSkillRefs,
  scanAgents,
  API_KEY_ONLY_PROVIDERS,
  listProviders,
  runtimeEnvFiles,
  scanEnv,
  scanExtensions,
  scanSkillCandidates,
  scanSkills,
  watchResources,
  ProviderLoginManager,
  SessionWorktreeStore,
  type ProviderLoginFn,
  type ResourceRoots,
} from "@agent-deck/resources";
import {
  hasEffectiveEnvValue,
  sweepStaleBridgeExtensions,
  writeBridgeExtension,
} from "@agent-deck/pi-host";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { buildMemoryPreamble, injectableIndex, type Embedder } from "@agent-deck/memory";
import { writeOpenAIFastConfig, writeOpenAIFastExtension } from "./openaiFastMode.ts";
import { projectAllowsAgent } from "./agentCuration.ts";
import { resolveExplicitSkills } from "./agentSkillResolution.ts";
import { AskUserCoordinator } from "./askUserCoordinator.ts";
import { FileAgentAvatarStore } from "./agentAvatars.ts";
import { ProjectImageStore } from "./projectImages.ts";
import { registerAskUserBridgeTool } from "./askUserBridgeTool.ts";
import { BridgeRegistry } from "./bridge.ts";
import {
  asThinkingLevel,
  envDefaults,
  type NamedAgentLaunch,
  type ServerContext,
} from "./context.ts";
import { bridgeAvailable } from "./claudeTransport.ts";
import {
  registerDeckBridgeTools,
  registerSupervisorAnswerBridgeTool,
  registerSupervisorListBridgeTool,
} from "./bridgeTools.ts";
import { EngineSkillStore } from "./skills/engineSkillStore.ts";
import { loadSkillEngineNative } from "./skills/skillEngineNative.ts";
import {
  makeChildMemoryRecall,
  registerChildBridgeAccess,
  resolveMemoryProjectPath,
} from "./childMemory.ts";
import { createDiffGateway, sessionDiffBase } from "./diffGateway.ts";
import { resolveLaunchResources } from "./launchResources.ts";
import { createEditorLauncher } from "./editorLauncher.ts";
import { createScriptRunnerGateway } from "./scriptRunnerGateway.ts";
import { makeCheckpointRollback } from "./checkpointRollback.ts";
import { makeCheckpointService } from "./services/checkpoints.ts";
import { makePlanEventService } from "./services/planEvents.ts";
import { createFileService } from "./services/files.ts";
import { LoopEngine } from "./loopEngine.ts";
import {
  mcpEntryToConfig,
  mergeMcpServerConfigs,
  mcpServerConfigsFromEnv,
  probeMcpServer,
  type McpServerStatus,
} from "./mcpTools.ts";
import {
  LEGACY_MCP_GRANT,
  legacyMcpToolPrefix,
  mergeMcpServerNames,
  nativeMcpList,
  nativeMcpRefusal,
  nativeMcpToolPattern,
  storedMcpServerName,
} from "./mcpNative.ts";
import { FileMcpAssignmentStore, type McpAssignmentStore } from "./mcpAssignments.ts";
import { FileMcpPolicyStore, type McpPolicyStore } from "./mcpPolicy.ts";
import { FileMcpDefinitionStore, type McpDefinitionStore } from "./mcpDefinitions.ts";
import { registerMemoryTools } from "./memoryTools.ts";
import {
  defaultDataDir,
  ProjectIndex,
  SessionAuthorIndex,
  SessionIndex,
  SettingsStore,
} from "./persistence.ts";
import { InjectedCommandStore } from "./injectedCommands.ts";
import { ReceiptBus } from "./receipts.ts";
import { makeServerRuntime, type ServerRuntime } from "./runtime.ts";
import { registerBridgeRoutes } from "./routes/bridge.ts";
import { registerEventRoutes, startProjectEventNudges } from "./routes/events.ts";
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
import { SessionAuthorStore } from "./sessionAuthors.ts";
import { GitIdentityMap } from "./gitIdentity.ts";
import { UserAgentDirs, userRoots } from "./userAgentDirs.ts";
import { migrateAzureAuthFiles } from "./azureProviderRename.ts";
import {
  authenticateProxiedRequest,
  CloudflareAccessVerifier,
  requestUser,
  trustedProxyConfigFromEnv,
} from "./trustedProxy.ts";
import { LoopSessionSnapshotStore } from "./loopSessionSnapshots.ts";
import { SubagentRunStore } from "./subagentRunStore.ts";
import { createEventLog, disabledEventLog, type EventLog } from "./eventLog.ts";
import { resolveTrustedDataDir } from "./trustedDataDir.ts";
import { SupervisorLog } from "./supervisor.ts";
import { createTerminalGateway } from "./terminalGateway.ts";
import { setupWebSocket } from "./wsHandler.ts";
import { SemanticRecallCoordinator } from "./semanticRecall.ts";

/** Child-only tools must not leak into a parent agent's launch allowlist.
 * Parent bridge tools remain eligible because their bridge is actually exposed. */
const BRIDGE_ONLY_TOOLS = new Set(["contact_supervisor"]);
const CHILD_MEMORY_TOOL_NAMES = new Set([
  "agent_deck_memory_write",
  "agent_deck_memory_search",
  "agent_deck_memory_mark_stale",
]);
/** The bridge tools that start a child pi, withheld when delegation is off. */
const DELEGATION_TOOL_NAMES = new Set(["managed_subagent", "managed_parallel"]);

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
   * Supply a semantic-recall implementation (tests/alternate hosts). This does
   * not enable semantic recall; the live persisted preference owns enablement.
   */
  memoryEmbedder?: Embedder;
  /** Narrow durable MCP-assignment seam for tests and future synced storage. */
  mcpAssignmentStore?: McpAssignmentStore;
  /** Narrow authoritative global MCP policy seam. */
  mcpPolicyStore?: McpPolicyStore;
  /** Narrow durable MCP-definition mutation seam. */
  mcpDefinitionStore?: McpDefinitionStore;
  composerDraftStore?: ComposerDraftStore;
  /** Provider sign-in seam: tests assert which auth.json a login targets. */
  providerLoginFn?: ProviderLoginFn;
  /** PRV-01 seam: the host's Claude Code login state (default: `claude auth status`). */
  claudeCodeLoggedIn?: () => Promise<boolean>;
}

export async function startServer(options: StartServerOptions = {}): Promise<AgentDeckServer> {
  // Effect runtime first: services composed in runtime.ts live for exactly the
  // server's lifetime (disposed last in close(), so scoped services from later
  // slices get their finalizers after the HTTP/WS surface is gone).
  const effectRuntime = makeServerRuntime();
  // Synchronous resources initServer opened before it failed (close() never exists then).
  const startupCleanups: Array<() => void> = [];
  try {
    return await initServer(options, effectRuntime, startupCleanups);
  } catch (error) {
    for (const cleanup of startupCleanups) {
      try {
        cleanup();
      } catch {
        // The startup error below is the one that matters.
      }
    }
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
  startupCleanups: Array<() => void>,
): Promise<AgentDeckServer> {
  const requestedDataDir = options.dataDir ?? defaultDataDir();
  // Establish and validate the trusted app-data directory before any persistence or native
  // capability opens it: create it if missing, reject a linked/reparse root, and resolve ancestor
  // links to one authoritative physical directory for all app-data services below.
  const dataDir = resolveTrustedDataDir(requestedDataDir);
  // Generated bridge extensions can embed resolved MCP credentials (PI-03b);
  // session exit removes them, this clears what a crash left.
  sweepStaleBridgeExtensions();
  // A1 event log: opened before the stores, whose constructors already write on load.
  // Not authoritative until A1d, so a log that cannot open must not stop the server.
  // projectOf is late-bound: the session index is created just below.
  let projectOfSession = (_sessionId: string): string | null => null;
  let eventLog: EventLog;
  try {
    eventLog = createEventLog(dataDir, { projectOf: (sessionId) => projectOfSession(sessionId) });
    console.info(`[events] log ${eventLog.logId} writable=${eventLog.writable}`);
  } catch (error) {
    console.warn("[events] event log disabled: could not open it", error);
    eventLog = disabledEventLog();
  }
  startupCleanups.push(() => eventLog.close());
  const receipts = new ReceiptBus(process.env.AGENT_DECK_TEST === "1");
  const index = new SessionIndex(dataDir);
  projectOfSession = (sessionId) =>
    index.find((session) => session.id === sessionId)?.projectId ?? null;
  const composerDrafts = options.composerDraftStore ?? new FileComposerDraftStore(dataDir);
  const settings = new SettingsStore(dataDir);
  const mcpPolicy = options.mcpPolicyStore ?? new FileMcpPolicyStore(settings);
  const mcpDefinitions = options.mcpDefinitionStore ?? new FileMcpDefinitionStore();
  const sessionImages = new SessionImageStore(dataDir);
  const agentAvatars = new FileAgentAvatarStore(dataDir);
  const projectImages = new ProjectImageStore(agentAvatars);
  const sessionPastes = new SessionPasteStore(dataDir);
  // Remote-server POC (docs/remote-server-poc.md): behind cloudflared + Access,
  // every request carries a verified identity; sessions and prompts record it.
  const trustedProxy = trustedProxyConfigFromEnv();
  const accessVerifier = trustedProxy ? new CloudflareAccessVerifier(trustedProxy) : undefined;
  const sessionAuthors = trustedProxy
    ? new SessionAuthorStore(new SessionAuthorIndex(dataDir))
    : undefined;
  sessionAuthors?.retainSessions(new Set(index.list().map((session) => session.id)));
  const gitIdentities = trustedProxy ? new GitIdentityMap(dataDir) : undefined;
  // SRV-11: each signed-in user's own Pi agent dir (credentials); the operator keeps ~/.pi/agent.
  // `rootsFor` is declared below; the lambda only runs after startup.
  const userAgentDirs = trustedProxy
    ? new UserAgentDirs(
        dataDir,
        () => piAgentHome(rootsFor()),
        process.env.AGENT_DECK_OPERATOR_EMAIL?.trim() || undefined,
      )
    : undefined;
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
  const childMemoryAuthorizations = new Map<string, { projectId: string; projectPath: string }>();
  const childMcpAssignments = new Map<
    string,
    {
      parentSessionId: string;
      agentName: string;
      projectId: string;
      serverIds: string[];
      /** Undefined grants every tool on assigned servers; otherwise legacy exact-tool names. */
      toolAllowlist?: string[];
    }
  >();
  const childAllowedTools = new Map<string, ReadonlySet<string>>();
  // Each session's MCP servers are embedded in its generated bridge extension
  // and hosted by Pi's own MCP client. A missing or hidden project gets none.
  const nativeMcpFor = (
    projectId: string,
    serverIds: readonly string[],
    toolAllowlist?: string[],
  ) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    return nativeMcpList(
      project && !project.hidden
        ? effectiveMcpConfigs(projectId).configs.filter((config) => serverIds.includes(config.id))
        : [],
      toolAllowlist,
    );
  };
  // The Pi name the session's current generated extension gave one server, for
  // `/mcp login <name>`: from the latest spawn's map, recomputed only for a
  // session spawned before that map existed.
  const nativeMcpNameFor = (meta: SessionMeta, serverId: string): string | undefined => {
    if (meta.mcpServerNamesCurrent)
      return storedMcpServerName(meta.mcpServerNamesCurrent, serverId);
    if (!meta.projectId) return undefined;
    const list = nativeMcpFor(meta.projectId, mcpAllowlistForSession(meta));
    return [...list.idMap].find(([, id]) => id === serverId)?.[0];
  };
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
  // The environment remains the hard compatibility capability. The persisted
  // preference can pause automation only while that capability exists; it can
  // never falsely re-enable a server launched with AGENT_DECK_MEMORY=0.
  const agentMemoryEnabled = (): boolean => memoryEnabled && settings.get().agentMemoryEnabled;
  const memoryBaseDir = nodePath.join(dataDir, "memory");
  // SES-34: the generated OpenAI Fast extension and the config it reads.
  // Written once at startup so every launch has them; the toggle route
  // rewrites the config, and the extension re-reads it per request, so a
  // change applies to a live session without relaunching pi.
  const openAIFastDir = nodePath.join(dataDir, "openai-fast");
  const openAIFastExtension = writeOpenAIFastExtension(openAIFastDir);
  // The extension resolves its config through this variable at REQUEST time, so
  // without it the whole feature silently no-ops (Codex caught exactly that).
  // Setting it on the server process reaches every pi child through one
  // chokepoint — PiProcess spawns with `{...process.env, ...options.env}` — so
  // parents, helpers and subagents all inherit it rather than each launch site
  // having to remember.
  process.env.AGENT_DECK_OPENAI_FAST_CONFIG = writeOpenAIFastConfig(
    openAIFastDir,
    settings.get().openAIFastModels,
  );
  // Construct the deletion authority once from trusted app data. Its held native
  // direct-child capability and authoritative physical path own ordinary session
  // worktrees for this server lifetime. Loop uses only the dedicated `loop`
  // child, which the ordinary-session leaf policy can never select.
  const sessionWorktreeStore = new SessionWorktreeStore(dataDir);
  const worktreesRoot = sessionWorktreeStore.rootPath;

  // The backend owns readiness, optional-runtime initialization, and truthful
  // per-recall fallback metadata. Construction and passive status reads do not
  // initialize the optional embedder; search or the explicit check does.
  const semanticRecall = new SemanticRecallCoordinator(
    () => settings.get().semanticMemoryEnabled,
    options.memoryEmbedder,
  );

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
  // SUB-14: durable plan history, kept off the meta broadcast path.
  const planEvents = makePlanEventService({ dataDir });
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
      if (meta.endedAt) diffs.drop(meta.id);
      // `broadcast` is initialized during startServer, before any meta changes.
      broadcast({ type: "session_meta", session: meta });
    },
    // The Fast extension is attached ONLY while at least one model is marked
    // Fast. It would be inert otherwise — it no-ops on an empty config — but
    // "inert" is not the same as "absent": adding an extension to every launch
    // changes what pi loads for every user and every test, and the real-pi suite
    // regressed on all three platforms the moment it went in unconditionally.
    // The cost of this guard is that enabling Fast reaches a session at its next
    // launch rather than its next turn; the config is still re-read per request,
    // so a session launched WITH the extension picks up a toggle immediately.
    () => [
      ...(envDefaults().providerExtensions ?? []),
      ...(settings.get().openAIFastModels.length > 0 ? [openAIFastExtension] : []),
    ],
    (meta) => {
      if (bridge.size === 0 || !bridgeAddress.endpoint) return undefined;
      const token = randomUUID();
      bridgeTokens.set(meta.id, token);
      // Per-session MCP scoping: project assignment is the execution trust grant.
      // Plain sessions see assigned servers; named-agent policy can only narrow that set.
      // Non-MCP bridge tools remain independently available.
      const scope = meta.projectId;
      // Delegation policy: don't ADVERTISE a tool this session would refuse.
      // The refusal itself lives at the SessionManager spawn chokepoint (that is
      // what makes it unbypassable); this only keeps the model from planning
      // around a capability it does not have.
      // Absence means ENABLED here too. `?? setting` then a truthiness test made
      // an UNDEFINED setting withhold the tools, which contradicts the runtime
      // guard (`=== false`) and the loader default — a settings object built
      // without this field would have silently stripped delegation from the
      // model while the runtime still permitted it.
      const delegationAllowed =
        meta.subagentsEnabled === undefined
          ? settings.get().subagentsEnabled !== false
          : meta.subagentsEnabled === true;
      const tools = bridge
        .specs()
        .filter((spec) => agentMemoryEnabled() || !spec.name.startsWith("agent_deck_memory_"))
        .filter((spec) => delegationAllowed || !DELEGATION_TOOL_NAMES.has(spec.name));
      const native = scope ? nativeMcpFor(scope, mcpAllowlistForSession(meta)) : undefined;
      // The transcript maps Pi server names back to Agent Deck ids, merged so
      // cells from earlier launches keep their label; sign-in uses this spawn's
      // map alone. Both persist with the meta the spawn publishes.
      if (native?.idMap.size)
        meta.mcpServerNames = mergeMcpServerNames(meta.mcpServerNames, native.idMap);
      meta.mcpServerNamesCurrent = Object.fromEntries(native?.idMap ?? []);
      return writeBridgeExtension({
        endpoint: bridgeAddress.endpoint,
        sessionId: meta.id,
        token,
        tools,
        ...(native?.servers.length ? { nativeMcp: { servers: native.servers } } : {}),
        // The generated bridge is appended after every provider/user extension.
        // Its single final hook applies recall first, then captures the exact
        // chained prompt Pi will use for this turn.
        recall: agentMemoryEnabled(),
        promptAudit: true,
      });
    },
    (cwd, home) => {
      // Parent system-prompt appends. While memory automation is paused, add
      // nothing and leave APPEND_SYSTEM discovery entirely to Pi. When active,
      // memory's explicit append suppresses that discovery, so put the resolved
      // APPEND_SYSTEM path FIRST and the memory block second. Both are passed as
      // FILE PATHS (pi reads a path entry as a file): a multi-line literal
      // --append value is truncated on Windows, where pi runs via a .cmd shim
      // through cmd.exe. `home` is the pi child's HOME so the global
      // APPEND_SYSTEM.md resolves where pi would find it.
      if (!agentMemoryEnabled()) return { appends: [] };
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
    // Purpose-scoped ordinary-child bridge: contact_supervisor plus the three
    // memory tools only when master memory is currently effective and the
    // parent's registered project is authoritative. The token gets an exact
    // dispatch allowlist; dispose removes every route/project/token mapping.
    async (childSessionId, route) => {
      if (!bridgeAddress.endpoint) return undefined;
      const token = randomUUID();
      const parent = sessions.get(route.parentSessionId)?.meta;
      const project = parent?.projectId
        ? projects.find((candidate) => candidate.id === parent.projectId)
        : undefined;
      const memorySpecs =
        agentMemoryEnabled() && project
          ? bridge.specs().filter((spec) => CHILD_MEMORY_TOOL_NAMES.has(spec.name))
          : [];
      // Hold the named assignment for this run, not the parent's MCP policy or
      // the child's cwd (which may be an isolated worktree).
      const serverIds =
        project && !project.hidden && route.agentName
          ? (route.mcpServers ?? []).filter((id) =>
              mcpAllowlistForSession({ ...parent!, agentName: route.agentName }).includes(id),
            )
          : [];
      // Unlike the always-added supervisor/memory channels, MCP remains
      // subject to an authored Pi tool allowlist (including explicit empty):
      // the legacy `mcp` grant keeps every assigned server, and older
      // mcp__server__tool names keep their exact restriction.
      const legacyPrefixes = serverIds.map(legacyMcpToolPrefix);
      const exactLegacyTools =
        route.tools?.filter((tool) => legacyPrefixes.some((prefix) => tool.startsWith(prefix))) ??
        [];
      const mcpAllowed =
        route.tools === undefined ||
        route.tools.includes(LEGACY_MCP_GRANT) ||
        exactLegacyTools.length > 0;
      const toolAllowlist =
        route.tools !== undefined && !route.tools.includes(LEGACY_MCP_GRANT)
          ? exactLegacyTools
          : undefined;
      const native =
        project && mcpAllowed ? nativeMcpFor(project.id, serverIds, toolAllowlist) : undefined;
      const tools = [CONTACT_SUPERVISOR_SPEC, ...memorySpecs];
      const toolNames = tools.map((tool) => tool.name);
      // Generate first; publish authentication/authorization only on success.
      const extension = writeBridgeExtension({
        endpoint: bridgeAddress.endpoint,
        sessionId: childSessionId,
        token,
        tools,
        ...(native?.servers.length ? { nativeMcp: { servers: native.servers } } : {}),
      });
      const disposeAccess = registerChildBridgeAccess({
        sessionId: childSessionId,
        token,
        // The policy hook's internal callback, never a model-facing tool.
        toolNames: native?.servers.length ? [...toolNames, "__mcp_authorize__"] : toolNames,
        ...(parent?.projectId && project
          ? { authorization: { projectId: parent.projectId, projectPath: project.path } }
          : {}),
        tokens: bridgeTokens,
        allowedTools: childAllowedTools,
        memoryAuthorizations: childMemoryAuthorizations,
      });
      childSupervisors.set(childSessionId, route);
      if (route.agentName && project && serverIds.length > 0) {
        childMcpAssignments.set(childSessionId, {
          parentSessionId: route.parentSessionId,
          agentName: route.agentName,
          projectId: project.id,
          serverIds,
          ...(toolAllowlist ? { toolAllowlist } : {}),
        });
      }
      return {
        extension,
        // Native MCP tools are not bridge tools; a pattern per granted server
        // keeps them through an authored --tools list (hidden exposure still
        // narrows a legacy exact-tool allowlist).
        toolNames: [
          ...toolNames,
          ...(native?.servers ?? []).map((s) => nativeMcpToolPattern(s.name)),
        ],
        dispose: async () => {
          cancelChildSupervisorRequests(childSessionId);
          disposeAccess();
          childSupervisors.delete(childSessionId);
          childMcpAssignments.delete(childSessionId);
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
        description: agent.description,
        model: agent.model,
        thinking: asThinkingLevel(agent.thinking),
        tools: agent.tools,
        mcpDirectTools: mcpPolicy.enabled() ? agent.mcpDirectTools : [],
        mcpServers: agent.mcpServers,
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
    // SES-18: the refresh needs BOTH preferences, exactly as native gates it.
    () => settings.get().autoTitle && settings.get().autoUpdateTitles,
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
      try {
        if (sessionAuthors)
          decorated = sessionAuthors.attachToUserCell(sessionId, decorated, rawContent);
      } catch {
        // Attribution is a label; losing it never drops the message.
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
    // PRJ-07: every session spawn layers the global + project .env files under
    // its explicit env (native EnvRuntimeEnvironment) — applied at the ONE
    // SessionManager chokepoint so resume/reopen/refresh can't miss it.
    (projectId) => runtimeEnvFiles(rootsFor(projectId)),
    makeChildMemoryRecall({
      memoryBaseDir,
      settings: {
        enabled: () => agentMemoryEnabled() && settings.get().agentMemorySubagentsEnabled,
        characterBudget: () => settings.get().agentMemoryInjectionCharacterBudget,
      },
      projectPath: (projectId) => projects.find((project) => project.id === projectId)?.path,
      recall: (store, query, limit) => semanticRecall.recall(store, query, limit),
    }),
    () => mcpPolicy.enabled(),
    planEvents,
    () => settings.get().subagentsEnabled,
    gitIdentities,
    userAgentDirs,
  );
  // Loop run engine (native single-agent loop). Each run's agent executor is
  // built per-run, bound to a parent session in the project cwd.
  const loopEngine = new LoopEngine({
    dataDir,
    warn: (message, error) => fastify.log.warn({ err: error }, message),
  });
  // Interactive provider OAuth login relay (native PiProviderLoginService).
  const providerLogin = new ProviderLoginManager(options.providerLoginFn);
  const projects = new ProjectIndex(dataDir);
  const mcpAssignments =
    options.mcpAssignmentStore ?? new FileMcpAssignmentStore(settings, projects);
  // App-owned command files are materialized under trusted app data at startup.
  // The store remains the sole scanner/mutator and supplies explicit extension
  // paths only to ordinary project parent sessions through launchResources.
  const injectedCommands = new InjectedCommandStore(dataDir, settings);
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
      // pluginRootsFor is initialized during startup, before any request reaches this handler
      candidates: scanSkillCandidates(roots, pluginRootsFor()),
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
        description: agent.description,
        systemPromptMode: agent.systemPromptMode,
        model: agent.model,
        thinking: agent.thinking,
        tools: agent.tools?.filter((tool) => !BRIDGE_ONLY_TOOLS.has(tool)),
        mcpDirectTools: mcpPolicy.enabled() ? agent.mcpDirectTools : [],
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
      (sessionId) =>
        resolveMemoryProjectPath({
          sessionId,
          childAuthorizations: childMemoryAuthorizations,
          projectPath: (projectId) => projects.find((project) => project.id === projectId)?.path,
          parentCwd: (id) => {
            const meta = sessions.get(id)?.meta;
            if (!meta) return undefined;
            return meta.projectId
              ? projects.find((project) => project.id === meta.projectId)?.path
              : meta.cwd;
          },
        }),
      (store, query, limit) => semanticRecall.recall(store, query, limit),
      () => semanticRecall.getStatus(),
      agentMemoryEnabled,
      () => settings.get().agentMemoryInjectionCharacterBudget,
      // MEM-11: attribute a memory to the DELEGATED RUN that wrote it. Only an
      // authorized child bridge counts — a parent's own write stays
      // unattributed even when the parent is a named-agent chat, which is the
      // line native draws (AppViewModel.swift:6303 vs :6297).
      (sessionId) =>
        childMemoryAuthorizations.has(sessionId)
          ? sessions.get(sessionId)?.meta.agentName
          : undefined,
      // MEM-19: the embedding half of the near-duplicate write guard, through
      // the same coordinator recall uses so one preference and one embedder
      // lifecycle govern both.
      (store, candidate) => semanticRecall.findDuplicate(store, candidate),
      // MEM-20: the launch-recall snapshot, so on-demand search adds to a
      // session's memory context instead of repeating it.
      {
        ids: (sessionId) => sessions.get(sessionId)?.meta.memoryRecall?.ids ?? [],
        add: (sessionId, ids) => {
          const meta = sessions.appendMemoryRecallIds(sessionId, ids);
          if (meta) index.upsert(meta);
        },
      },
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
  // PI-04: Pi 1.0.3 renamed the azure provider; rewrite the shared and per-user auth.json once.
  migrateAzureAuthFiles(piAgentHome(rootsFor()), dataDir, (message, error) =>
    console.warn(`[azure-provider-rename] ${message}`, error ?? ""),
  );
  // SKL-09: Codex plugin skill REFERENCES resolve against the plugin cache's active version
  // on every scan (version-follow, never copied) and join as read-only collection roots.
  const pluginRootsFor = (): string[] =>
    resolveCodexPluginSkillRefs(resourceHome(), settings.get().codexPluginSkillRefs).roots;
  const scanSkillsFor = (projectId?: string) => scanSkills(rootsFor(projectId), pluginRootsFor());
  const scanSkillCandidatesFor = (projectId?: string) =>
    scanSkillCandidates(rootsFor(projectId), pluginRootsFor());

  const createAgentWarningContext = (projectId?: string) => {
    const roots = rootsFor(projectId);
    const skillCandidateCounts = new Map<string, number>();
    for (const skill of scanSkillCandidatesFor(projectId)) {
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
  const mcpEnvConfigs = mcpServerConfigsFromEnv(process.env.AGENT_DECK_MCP_SERVERS, resourceHome());
  const mcpServerAllowedForSession = (sessionId: string, serverId: string): boolean => {
    const child = childMcpAssignments.get(sessionId);
    if (child) {
      const parent = sessions.get(child.parentSessionId)?.meta;
      return (
        !!parent &&
        parent.projectId === child.projectId &&
        !!projects.find((project) => project.id === child.projectId && !project.hidden) &&
        resolveNamedAgent(child.agentName, child.projectId).status === "ok" &&
        child.serverIds.includes(serverId) &&
        mcpAllowlistForSession({ ...parent, agentName: child.agentName }).includes(serverId)
      );
    }
    const meta = sessions.get(sessionId)?.meta;
    return meta ? mcpAllowlistForSession(meta).includes(serverId) : false;
  };
  // PI-03c: the live answer to a native MCP call (the bridge's __mcp_authorize__),
  // for the Agent Deck id the extension embedded at spawn.
  const nativeMcpRefusalFor = (
    sessionId: string,
    call: { serverId: string; server: string; toolName: string },
  ) => {
    const child = childMcpAssignments.get(sessionId);
    const meta = child ? undefined : sessions.get(sessionId)?.meta;
    const projectId = child ? child.projectId : meta?.projectId;
    const project = projects.find((candidate) => candidate.id === projectId);
    // A named parent's `tools:` list is read live too, so narrowing it applies
    // to the running session (a list with `mcp` grants every assigned server).
    const parent = meta?.agentName ? resolveNamedAgent(meta.agentName, meta.projectId) : undefined;
    const parentTools = parent?.status === "ok" ? parent.agent.tools : undefined;
    const legacyGrant = child?.toolAllowlist
      ? { tools: child.toolAllowlist, serverIds: child.serverIds }
      : meta && parentTools && !parentTools.includes(LEGACY_MCP_GRANT)
        ? { tools: parentTools, serverIds: mcpAllowlistForSession(meta) }
        : undefined;
    return nativeMcpRefusal({
      enabled: mcpPolicy.enabled(),
      projectVisible: !!project && !project.hidden,
      config: project
        ? effectiveMcpConfigs(project.id).configs.find((config) => config.id === call.serverId)
        : undefined,
      assigned: mcpServerAllowedForSession(sessionId, call.serverId),
      ...(legacyGrant ? { legacyGrant } : {}),
      server: call.server,
      toolName: call.toolName,
    });
  };
  const globalMcpConfigs = () => {
    const catalog = readMcpServerCatalog(rootsFor());
    const fromFile = catalog.servers.flatMap((entry) => mcpEntryToConfig(entry, resourceHome()));
    return {
      configs: mergeMcpServerConfigs(fromFile, mcpEnvConfigs),
      valid: catalog.valid,
      catalog,
    };
  };

  const effectiveMcpConfigs = (projectId: string) => {
    const catalog = readMcpServerCatalog(rootsFor(projectId));
    const fromFile = catalog.servers.flatMap((entry) => mcpEntryToConfig(entry, resourceHome()));
    return {
      configs: mergeMcpServerConfigs(fromFile, mcpEnvConfigs),
      valid: catalog.valid,
      catalog,
    };
  };

  const namedMcpIdsForProject = (projectId: string): string[] => {
    const project = projects.find((item) => item.id === projectId);
    return scanAgents(rootsFor(projectId))
      .filter((agent) => !agent.shadowed && !agent.disabled && projectAllowsAgent(project, agent))
      .flatMap((agent) => agent.mcpServers ?? []);
  };
  // The settings screen's last probe per project and server (mcpTools.ts
  // probeMcpServer); sessions never read it.
  const mcpProbes = new Map<string, McpServerStatus>();
  const mcpProbeKey = (projectId: string, serverId: string): string =>
    JSON.stringify([projectId, serverId]);
  // One probe per distinct effective config at a time, however many projects
  // share it; shutdown waits for them (each is capped at 15 s).
  const runningMcpProbes = new Map<string, Promise<McpServerStatus>>();
  // Bumped by every invalidation: a probe that started before one is dropped.
  let mcpProbeGeneration = 0;
  const grantedMcpConfig = (projectId: string, serverId: string) => {
    const project = projects.find((item) => item.id === projectId);
    // Same trust grant as a launch: a definition is inert until assigned.
    if (!mcpPolicy.enabled() || !project || project.hidden) return undefined;
    if (!projectHasEffectiveMcpGrant(projectId, serverId)) return undefined;
    return effectiveMcpConfigs(projectId).configs.find((item) => item.id === serverId);
  };
  const probeMcp = async (projectId: string, serverId: string): Promise<boolean> => {
    const config = grantedMcpConfig(projectId, serverId);
    if (!config) return false;
    const configKey = JSON.stringify(config);
    const generation = mcpProbeGeneration;
    let running = runningMcpProbes.get(configKey);
    if (!running) {
      running = probeMcpServer(config).finally(() => runningMcpProbes.delete(configKey));
      runningMcpProbes.set(configKey, running);
    }
    const status = await running;
    // Keep it only if nothing was invalidated meanwhile and the definition and
    // grant still match what was probed.
    const current = grantedMcpConfig(projectId, serverId);
    if (generation === mcpProbeGeneration && current && JSON.stringify(current) === configKey)
      mcpProbes.set(mcpProbeKey(projectId, serverId), status);
    return true;
  };
  const forgetMcpProbes = (match: (projectId: string, serverId: string) => boolean): void => {
    mcpProbeGeneration += 1;
    for (const key of mcpProbes.keys()) {
      const [projectId, serverId] = JSON.parse(key) as [string, string];
      if (match(projectId, serverId)) mcpProbes.delete(key);
    }
  };
  const projectHasEffectiveMcpGrant = (projectId: string, serverId: string): boolean => {
    const snapshot = effectiveMcpConfigs(projectId);
    if (!snapshot.valid || !snapshot.configs.some((config) => config.id === serverId)) return false;
    return (
      mcpAssignments.defaultServerNames().includes(serverId) ||
      mcpAssignments.projectServerNames(projectId).includes(serverId) ||
      namedMcpIdsForProject(projectId).includes(serverId)
    );
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

  if (accessVerifier) {
    // Trusted proxy: cloudflared (loopback) authenticated the person and attached
    // the Access assertion. Anything else is refused, except the health probe and
    // the local Pi subprocess calling its own per-session-token tool bridge.
    fastify.addHook("onRequest", async (request, reply) => {
      const route = request.routeOptions.url;
      if (route === "/health" || route === "/bridge") return;
      const result = await authenticateProxiedRequest(accessVerifier, request.raw);
      if (!result.user) {
        return reply.status(401).send({ code: "unauthenticated", error: result.reason });
      }
    });
  }
  // Who the server believes the caller is. `null` on a single-user loopback server.
  // SRV-13: `providersConnected` says whether the caller's own agent dir has any
  // signed-in or configured provider, so the web can warn before a start fails.
  fastify.get("/me", async (request) => {
    const user = requestUser(request.raw);
    if (!user) return { user: null };
    // Best-effort: a failing agent dir must not hide the identity (the web
    // would then treat the server as loopback); the field is just omitted.
    let providersConnected: boolean | undefined;
    try {
      // PRV-01: a usable transport: the host's Claude Code login (shared by every
      // owner), or a credential other than a refused Anthropic sign-in.
      providersConnected =
        (await bridgeAvailable(ctx)) ||
        (await listProviders(userRoots(rootsFor(), user, userAgentDirs))).some(
          (provider) =>
            (provider.signedIn || provider.configured) &&
            !(API_KEY_ONLY_PROVIDERS.has(provider.id) && provider.credentialType === "oauth"),
        );
    } catch (error) {
      request.log.warn({ err: error }, "providersConnected check failed");
    }
    return {
      user: {
        id: user.id,
        email: user.email,
        ...(user.name ? { name: user.name } : {}),
        ...(providersConnected === undefined ? {} : { providersConnected }),
      },
    };
  });
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

  // The MCP-server allowlist for a session. No-project chats receive none.
  // Ordinary project chats use All Projects union explicit project assignment;
  // a bound named agent instead uses exactly its own mcpServers declaration.
  // Both paths fail closed against the currently configured catalog.
  function mcpAllowlistForSession(meta: SessionMeta): string[] {
    if (!mcpPolicy.enabled() || !meta.projectId) return [];
    const snapshot = effectiveMcpConfigs(meta.projectId);
    if (!snapshot.valid) return [];
    const configured = new Set(snapshot.configs.map((config) => config.id));
    if (meta.agentName) {
      const resolved = resolveNamedAgent(meta.agentName, meta.projectId);
      if (resolved.status !== "ok") return [];
      return [...new Set(resolved.agent.mcpServers)].filter((id) => configured.has(id));
    }
    return [
      ...new Set([
        ...mcpAssignments.defaultServerNames(),
        ...mcpAssignments.projectServerNames(meta.projectId),
      ]),
    ].filter((id) => configured.has(id));
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
    isTrustedOrigin,
    closeAdmission: closeWebSocketAdmission,
    drain: drainWebSocketOperations,
    close: closeWebSockets,
    broadcast: wsBroadcast,
    broadcastDiff: wsBroadcastDiff,
  } = setupWebSocket({
    fastify,
    sessions,
    drafts: {
      find: (id) => ctx.sessionDrafts?.find(id),
      start: (id) => ctx.sessionDrafts!.start(id),
      setModel: (id, provider, modelId) => ctx.sessionDrafts!.setModel(id, provider, modelId),
      setThinking: (id, level) => ctx.sessionDrafts!.setThinking(id, level),
    },
    terminals,
    diffs,
    editors,
    files,
    scripts,
    checkpoints,
    rollback,
    sessionImages,
    sessionPastes,
    sessionAuthors,
    sharedServer: trustedProxy !== null,
    publicOrigin: trustedProxy?.publicOrigin,
    accessVerifier,
  });
  broadcast = (message) => {
    wsBroadcast(message);
    if (message.type === "resources_changed") sessions.queueResourceRefresh();
  };
  broadcastDiff = wsBroadcastDiff;

  // Browser-CSRF guard: a hostile page (or in-app browser content) can fire
  // requests at this server, but browsers stamp them with its Origin. Every
  // state-changing route, the server folder listing and the event log read apply the WebSocket
  // upgrade's own origin rule; non-browser clients send no Origin and pass.
  // That includes the desktop main process: Electron 43's
  // session.defaultSession.fetch (controlPlaneFetch) sends no Origin on POST,
  // while the renderer's fetches and WebSocket carry the page's own origin.
  const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  fastify.addHook("onRequest", async (request, reply) => {
    const guarded =
      mutatingMethods.has(request.method) ||
      request.routeOptions.url === "/fs/dirs" ||
      request.routeOptions.url === "/events";
    if (guarded && !isTrustedOrigin(request.headers.origin, request.headers.host)) {
      return reply.status(403).send({
        code: "untrusted_origin",
        error: "Request origin is not allowed.",
      });
    }
  });

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
    ...(options.claudeCodeLoggedIn ? { claudeCodeLoggedIn: options.claudeCodeLoggedIn } : {}),
    composerDrafts,
    fastify,
    sessions,
    planEvents,
    sessionImages,
    agentAvatars,
    projectImages,
    sessionPastes,
    sessionAuthors,
    gitIdentities,
    userAgentDirs,
    sharedServer: trustedProxy !== null,
    index,
    projects,
    settings,
    bridge,
    bridgeTokens,
    askUser,
    supervisor,
    childSupervisors,
    childMemoryAuthorizations,
    childAllowedTools,
    pendingSupervisor,
    loopEngine,
    providerLogin,
    mcpAssignments,
    mcpPolicy,
    mcpDefinitions,
    effectiveMcpConfigs,
    nativeMcpRefusal: nativeMcpRefusalFor,
    globalMcpConfigs,
    isMcpEnvOverride: (id) => mcpEnvConfigs.some((config) => config.id === id),
    nativeMcpNameFor,
    projectHasEffectiveMcpGrant,
    mcpProbe: (projectId, serverId) => mcpProbes.get(mcpProbeKey(projectId, serverId)),
    probeMcp,
    forgetMcpProbes,
    memoryEnabled,
    agentMemoryEnabled,
    memoryBaseDir,
    openAIFastDir,
    worktreesRoot,
    sessionWorktreeStore,
    semanticRecall,
    resolveNamedAgent,
    extensionBridgeConflictAt,
    enabledExtensionPaths,
    injectedCommands,
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

  sessions.configureResourceRefresh(
    (meta) => {
      const defaults = envDefaults();
      return resolveLaunchResources(
        ctx,
        { cwd: meta.cwd, projectId: meta.projectId, agentName: meta.agentName },
        {
          provider: defaults.provider,
          model: defaults.model,
          extensions: defaults.extensions,
        },
        meta.launchResourceConfig,
      );
    },
    () => envDefaults().env,
  );

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
  registerComposerDraftRoutes(ctx, composerDrafts);
  registerEventRoutes(fastify, eventLog);
  // A1c: coalesced project_events nudges to every client (same reach as resources_changed).
  const stopEventNudges = startProjectEventNudges(eventLog, broadcast);
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
        await step(() => Promise.allSettled([...runningMcpProbes.values()]));
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
        await step(() => stopEventNudges());
        await step(() => eventLog.close());
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
