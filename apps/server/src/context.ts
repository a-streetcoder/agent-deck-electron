import type { CatalogModel, SandboxProvider } from "@agent-deck/pi-host";
import type { Analytics } from "./analytics.ts";
import type { ComposerDraftStore } from "./composerDrafts.ts";
import type { SessionDraftGateway } from "./sessionDrafts.ts";
import nodePath from "node:path";
import type { ServerMessage, SessionMeta, UserIdentity } from "@agent-deck/contracts";
import type { AgentWarningContext, SkillInfo, SubagentExpectedOutcome } from "@agent-deck/domain";
import type {
  McpServerCatalog,
  ProviderLoginManager,
  ResourceRoots,
  SessionWorktreeStore,
} from "@agent-deck/resources";
import type { FastifyInstance } from "fastify";
import type { AskUserCoordinator } from "./askUserCoordinator.ts";
import type { AgentAvatarStore } from "./agentAvatars.ts";
import type { ProjectImageStore } from "./projectImages.ts";
import type { BridgeRegistry } from "./bridge.ts";
import type { LoopEngine } from "./loopEngine.ts";
import type { McpServerConfig, McpServerStatus } from "./mcpTools.ts";
import type { McpAssignmentStore } from "./mcpAssignments.ts";
import type { McpPolicyStore } from "./mcpPolicy.ts";
import type { McpDefinitionStore } from "./mcpDefinitions.ts";
import type { ProjectIndex, SessionIndex, SettingsStore } from "./persistence.ts";
import type { AgentSessionPlan, SessionManager } from "./SessionManager.ts";
import type { PlanEventServiceShape } from "./services/planEvents.ts";
import type { EventProducers } from "./eventProducers.ts";
import type { PlanDispatcher } from "./planDispatcher.ts";
import type { SessionImageStore } from "./sessionImages.ts";
import type { SessionPasteStore } from "./sessionPastes.ts";
import type { SessionAuthorStore } from "./sessionAuthors.ts";
import type { GitIdentityMap } from "./gitIdentity.ts";
import type { UserAgentDirs } from "./userAgentDirs.ts";
import type { GitHubConnections } from "./githubConnections.ts";
import type { DeploymentProfile } from "./profile.ts";
import type { gitCloneRepository } from "./git.ts";
import type { RpcEndpoint } from "./rpcHandler.ts";
import type { SkillStore } from "./skills/skillStore.ts";
import type { InjectedCommandStore } from "./injectedCommands.ts";
import type { SupervisorLog } from "./supervisor.ts";
import type { SemanticRecallCoordinator } from "./semanticRecall.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function asThinkingLevel(value: string | undefined): AgentSessionPlan["thinking"] {
  return value && THINKING_LEVELS.has(value) ? (value as AgentSessionPlan["thinking"]) : undefined;
}

/**
 * Session defaults from the server environment. The e2e harness (and any dev
 * setup) uses these to route UI-created sessions to the mock provider without
 * the UI knowing: AGENT_DECK_DEFAULT_PROVIDER, AGENT_DECK_DEFAULT_MODEL,
 * AGENT_DECK_DEFAULT_EXTENSIONS (path.delimiter-separated),
 * AGENT_DECK_PROVIDER_EXTENSIONS (provider-registration extensions only —
 * the ONLY extensions isolated helper launches may load),
 * AGENT_DECK_PI_ENV (JSON object merged into the pi subprocess env),
 * AGENT_DECK_DEFAULT_CWD (cwd for sessions created without a project/cwd —
 * a test seam like AGENT_DECK_TERMINAL_SHELL, so e2e default sessions run in
 * a hermetic temp dir instead of the server process's own checkout).
 */
export function envDefaults(): {
  provider?: string;
  model?: string;
  extensions?: string[];
  providerExtensions?: string[];
  env?: Record<string, string>;
  cwd?: string;
} {
  const extensions = process.env.AGENT_DECK_DEFAULT_EXTENSIONS?.split(nodePath.delimiter).filter(
    Boolean,
  );
  const providerExtensions = process.env.AGENT_DECK_PROVIDER_EXTENSIONS?.split(
    nodePath.delimiter,
  ).filter(Boolean);
  let env: Record<string, string> | undefined;
  if (process.env.AGENT_DECK_PI_ENV) {
    try {
      env = JSON.parse(process.env.AGENT_DECK_PI_ENV) as Record<string, string>;
    } catch {
      // Malformed JSON — ignore rather than break session creation.
    }
  }
  return {
    provider: process.env.AGENT_DECK_DEFAULT_PROVIDER,
    model: process.env.AGENT_DECK_DEFAULT_MODEL,
    extensions: extensions?.length ? extensions : undefined,
    providerExtensions: providerExtensions?.length ? providerExtensions : undefined,
    env,
    cwd: process.env.AGENT_DECK_DEFAULT_CWD || undefined,
  };
}

export interface McpConfigSnapshot {
  configs: McpServerConfig[];
  valid: boolean;
  /** File definitions used to derive configs, captured by the same catalog read. */
  catalog: McpServerCatalog;
}

export interface NamedAgentLaunch {
  body: string;
  description?: string;
  systemPromptMode: "replace" | "append";
  model?: string;
  thinking?: string;
  /** Real pi tools the agent declares (bridge-only tools filtered out). */
  tools?: string[];
  /** Ordered external adapter names; never part of Pi's `--tools` allowlist. */
  mcpDirectTools?: string[];
  /** Resolved skill base dirs, disabled skills removed. */
  skillDirs: string[];
  extensions: string[];
  mcpServers?: string[];
  defaultReads?: string[];
  defaultExpectedOutcome?: SubagentExpectedOutcome;
  /** Advisory output metadata for named children; never a capability grant. */
  output?: string;
}

/**
 * Everything a route module needs from the composition root. Assembled once in
 * startServer (server.ts) and handed to each register function; the modules
 * destructure what they use, so the moved handler bodies read exactly as they
 * did in the monolith.
 */
export interface ServerContext {
  /** Last model discovery; draft reads never spawn Pi to fill it (only a launch
   * guard that needs claude-bridge does, claudeTransport.ts). */
  discoveredModels?: CatalogModel[];
  /** PRV-01 test seam: whether the host's Claude Code is logged in (claudeTransport.ts). */
  claudeCodeLoggedIn?: () => Promise<boolean>;
  /** The discovery behind `POST /runtime/models/discover`; stores `discoveredModels`. */
  discoverModels?: (
    signal?: AbortSignal,
    options?: { reconcile?: boolean },
  ) => Promise<CatalogModel[]>;
  fastify: FastifyInstance;
  /** DOC-01/02 test seam: run a doctor fix command / the pi self-update in the
   * user's terminal. Omitted in production — the settings routes construct the
   * real launcher. */
  fixTerminal?: { run(command: string): Promise<void>; runPiUpdate(): Promise<void> };
  sessions: SessionManager;
  sessionDrafts?: SessionDraftGateway;
  composerDrafts?: ComposerDraftStore;
  /** SUB-14: durable per-session plan history (read side + delete cleanup). */
  planEvents: PlanEventServiceShape;
  /** A5: re-evaluate live plans (the delegation setting changed); A10: retry an item. */
  planDispatcher?: Pick<PlanDispatcher, "evaluateAll" | "retry" | "checkRetry">;
  /** A1 event log producers (tests: createEventProducers(disabledEventLog())). */
  events: EventProducers;
  sessionImages: SessionImageStore;
  agentAvatars: AgentAvatarStore;
  projectImages: ProjectImageStore;
  sessionPastes: SessionPasteStore;
  /** Remote-server POC: who sent each user message; absent without a trusted proxy. */
  sessionAuthors?: SessionAuthorStore;
  /** Remote-server POC: session-owner git identity (gitIdentity.ts); absent without a trusted proxy. */
  gitIdentities?: GitIdentityMap;
  /** SRV-11: per-user Pi agent dirs (userAgentDirs.ts); absent without a trusted proxy. */
  userAgentDirs?: UserAgentDirs;
  /** SRV-06: per-user GitHub connections (githubConnections.ts); absent without a trusted proxy. */
  githubConnections?: GitHubConnections;
  /** ADR 0008: the deployment profile this process runs under (profile.ts). Every
   * product difference reads it; the matrix in the ADR lists them. */
  profile: DeploymentProfile;
  /** ADR 0007: the process sandbox provider sessions run in (absent: none). */
  sandboxProvider?: SandboxProvider;
  /** CRB-03 (shared server): the credential broker, for Doctor. */
  credentialBroker?: { readonly address: string; readonly listening: boolean };
  /** ADR 0007: why a folder cannot hold a sandboxed session (a reserved part
   * of the data dir, the agent dir); undefined when it can or under none. */
  sandboxRootProblem?: (root: string) => string | undefined;
  /** ANA-01: anonymous usage counts (analytics.ts); absent in hand-built test contexts. */
  analytics?: Analytics;
  /** SRV-12c1: the fork's model check (SRV-15a), reused by the session import. */
  sessionModelGate?: {
    pin(meta: SessionMeta, owner: UserIdentity | undefined): Promise<SessionMeta>;
    /** `localCatalog` (SRV-12c3, a returned session): check this machine's own
     * catalog even without an owner. */
    refusal(
      meta: SessionMeta,
      owner: UserIdentity | undefined,
      localCatalog?: boolean,
    ): Promise<string | undefined>;
  };
  /** SRV-12c1: where an imported session's Pi transcript is written. */
  importedSessionsDir?: string;
  /** SRV-12a test seams: the GitHub API fetch and the clone behind POST /projects { repo }. */
  repoProjectSeams?: { fetch?: typeof fetch; clone?: typeof gitCloneRepository };
  /** SRV-15b: copies of the metas with their computed `activity`; absent in narrow tests. */
  withActivity?: (metas: readonly SessionMeta[]) => SessionMeta[];
  /** SRV-12c2: one prompt through the RPC dispatch, as the requester; absent in narrow tests. */
  promptSession?: RpcEndpoint["prompt"];
  index: SessionIndex;
  projects: ProjectIndex;
  settings: SettingsStore;
  bridge: BridgeRegistry;
  /** Each session's current bridge generation (never sent to Pi; see server.ts). */
  bridgeTokens: Map<string, string>;
  askUser: AskUserCoordinator;
  supervisor: SupervisorLog;
  childSupervisors: Map<string, { parentSessionId: string; cellId: string }>;
  /** Canonical project ownership for child memory tools; removed with bridge disposal. */
  childMemoryAuthorizations: Map<string, { projectId: string; projectPath: string }>;
  /** Exact app bridge tools each child token may dispatch. */
  childAllowedTools: Map<string, ReadonlySet<string>>;
  pendingSupervisor: Map<
    string,
    {
      parentSessionId: string;
      childSessionId: string;
      settle: (result: { content: string; isError?: boolean }) => void;
    }
  >;
  loopEngine: LoopEngine;
  providerLogin: ProviderLoginManager;
  mcpAssignments: McpAssignmentStore;
  mcpPolicy: McpPolicyStore;
  mcpDefinitions: McpDefinitionStore;
  effectiveMcpConfigs(projectId: string): McpConfigSnapshot;
  /** PI-03c: why a native MCP call or its result is refused right now, if it is. */
  nativeMcpRefusal(
    sessionId: string,
    call: { serverId: string; server: string; toolName: string },
  ): string | undefined;
  globalMcpConfigs(): McpConfigSnapshot;
  isMcpEnvOverride(id: string): boolean;
  /** PI-03d: the Pi server name a session uses for an Agent Deck server id, if it has it. */
  nativeMcpNameFor(meta: SessionMeta, serverId: string): string | undefined;
  projectHasEffectiveMcpGrant(projectId: string, serverId: string): boolean;
  /** The settings screen's last probe of a server in a project, if any. */
  mcpProbe(projectId: string, serverId: string): McpServerStatus | undefined;
  /** Probe a server assigned to a visible project; false when it is not (nothing ran). */
  probeMcp(projectId: string, serverId: string): Promise<boolean>;
  /** Drop cached probes the predicate matches (edit, delete, pause, reload). */
  forgetMcpProbes(match: (projectId: string, serverId: string) => boolean): void;
  /** Hard server capability controlled by AGENT_DECK_MEMORY=0. */
  memoryEnabled: boolean;
  /** Live effective parent-agent automation preference (capability && setting). */
  agentMemoryEnabled(): boolean;
  memoryBaseDir: string;
  /** SES-34: where the OpenAI Fast config + generated extension live. */
  openAIFastDir: string;
  worktreesRoot: string;
  sessionWorktreeStore: SessionWorktreeStore;
  semanticRecall: SemanticRecallCoordinator;
  resolveNamedAgent(
    name: string,
    projectId?: string,
  ):
    | { status: "ok"; agent: NamedAgentLaunch }
    | { status: "not_found" }
    | { status: "disabled" }
    | { status: "invalid"; error: string };
  extensionBridgeConflictAt(filePath: string): string | null;
  enabledExtensionPaths(projectId?: string, allowlist?: readonly string[]): string[];
  injectedCommands: InjectedCommandStore;
  resourceHome(): string;
  rootsFor(projectId?: string): ResourceRoots;
  scanSkillsFor(projectId?: string): SkillInfo[];
  scanSkillCandidatesFor(projectId?: string): SkillInfo[];
  createAgentWarningContext(projectId?: string): AgentWarningContext;
  /** The skill catalog/authoring/version seam (ADR-0002 P1b). Consumers should
   *  prefer this over the raw scan/writer functions so the shared engine can later
   *  replace it behind the same interface. */
  skillStore: SkillStore;
  broadcast(message: ServerMessage): void;
  watchProject(projectPath: string): void;
  /**
   * Drop a session's cached changed-file set (the Slice-9 SessionDiff cache), so
   * the next `diff_files` refetch recomputes from disk instead of replaying a
   * stale set. HTTP routes that mutate the worktree out-of-band from the turn
   * loop (e.g. the merge route, which auto-commits + merges all worktree work)
   * call this so a resubscribe before the next turn boundary can't resurrect the
   * pre-mutation diff. Mirrors the `diffs.drop` the session-meta hook already
   * fires when a session ends.
   */
  dropDiffCache(sessionId: string): void;
}
