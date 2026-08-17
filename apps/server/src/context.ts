import nodePath from "node:path";
import type { ServerMessage } from "@agent-deck/contracts";
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
import type { BridgeRegistry } from "./bridge.ts";
import type { LoopEngine } from "./loopEngine.ts";
import type { McpManager, McpServerConfig } from "./mcpTools.ts";
import type { McpOAuthCoordinator } from "./mcpOAuth.ts";
import type { McpAssignmentStore } from "./mcpAssignments.ts";
import type { McpPolicyStore } from "./mcpPolicy.ts";
import type { ProjectIndex, SessionIndex, SettingsStore } from "./persistence.ts";
import type { AgentSessionPlan, SessionManager } from "./SessionManager.ts";
import type { SessionImageStore } from "./sessionImages.ts";
import type { SessionPasteStore } from "./sessionPastes.ts";
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
  fastify: FastifyInstance;
  /** DOC-01/02 test seam: run a doctor fix command / the pi self-update in the
   * user's terminal. Omitted in production — the settings routes construct the
   * real launcher. */
  fixTerminal?: { run(command: string): Promise<void>; runPiUpdate(): Promise<void> };
  sessions: SessionManager;
  sessionImages: SessionImageStore;
  agentAvatars: AgentAvatarStore;
  sessionPastes: SessionPasteStore;
  index: SessionIndex;
  projects: ProjectIndex;
  settings: SettingsStore;
  bridge: BridgeRegistry;
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
  mcp: McpManager;
  mcpOAuth: McpOAuthCoordinator;
  mcpAssignments: McpAssignmentStore;
  mcpPolicy: McpPolicyStore;
  reloadMcpConfig(projectId?: string): Promise<{ ok: true } | { ok: false; error: string }>;
  reconcileProjectMcp(
    projectId: string,
    extraIds?: readonly string[],
  ): Promise<{ ok: true; missing: string[] } | { ok: false; error: string }>;
  prepareProjectMcpSession(
    projectId: string,
    serverIds: readonly string[],
  ): Promise<{
    result: { ok: true; missing: string[] } | { ok: false; error: string };
    release(): Promise<void>;
  }>;
  effectiveMcpConfigs(projectId: string): McpConfigSnapshot;
  globalMcpConfigs(): McpConfigSnapshot;
  isMcpEnvOverride(id: string): boolean;
  oauthKey(scope: string, id: string): string;
  projectHasEffectiveMcpGrant(projectId: string, serverId: string): boolean;
  /** Hard server capability controlled by AGENT_DECK_MEMORY=0. */
  memoryEnabled: boolean;
  /** Live effective parent-agent automation preference (capability && setting). */
  agentMemoryEnabled(): boolean;
  memoryBaseDir: string;
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
