export {
  agentCatalogDirs,
  appendSystemPromptPath,
  BUILTIN_AGENTS_DIR,
  builtinPromptsDir,
  defaultRoots,
  extensionCatalogDirs,
  piAgentHome,
  projectWatchDirs,
  promptCatalogDirs,
  skillCatalogDirs,
  watchDirs,
  type AgentCatalogDir,
  type ExtensionCatalogDir,
  type PromptCatalogDir,
  type ResourceRoots,
  type SkillCatalogDir,
} from "./paths.ts";
export {
  deleteMcpServer,
  isValidHttpMcpUrl,
  isValidMcpServerName,
  mcpConfigPath,
  McpConfigError,
  readMcpServerCatalog,
  readMcpServers,
  writeMcpServer,
  type McpConfigScope,
  type McpServerCatalog,
  type McpServerEntry,
  type McpServerInput,
  type McpTransport,
} from "./mcp.ts";
export {
  EXTERNAL_PROMPT_EXTENSIONS,
  isExternalPromptFileName,
  parseAgentFile,
  scanAgents,
  scanExtensions,
  scanPrompts,
  scanSkillCandidates,
  scanSkills,
  type DiscoveredExtension,
} from "./scanner.ts";
export {
  addResourceWatchPaths,
  ensureDirs,
  removeResourceWatchPaths,
  watchResources,
} from "./watcher.ts";
export {
  applyAgentOverride,
  computeBuiltinOverride,
  EDITABLE_OVERRIDE_KEYS,
  mergeWithUnmanagedOverrideFields,
  readAgentOverrides,
  writeBuiltinAgentOverride,
  type AgentEdit,
  type AgentOverride,
} from "./overrides.ts";
export { materializeBuiltinAgentOverrideContent } from "./agentReplacement.ts";
export {
  writeAgentFile,
  writeSkillFile,
  writePromptFile,
  deleteAgentFile,
  setAgentDisabledFile,
  deleteSkillDir,
  deletePromptFile,
  renamePromptFile,
  renameAgentFile,
  renameSkillDir,
  importSkillFile,
  importSkillsFromClone,
  replaceSkillTreeFromEntries,
  materializeSkillTreeEntries,
  durableMaterializeSkillTreeEntries,
  discoverImportSkillRoots,
  discoverSkillRoots,
  catalogSkillTreeFingerprint,
  skillMdHash,
  type DiscoveredSkillRoot,
  type ImportSkillRoot,
  type SkillImportFilter,
  type SkillImportResult,
  type WritableScope,
} from "./writer.ts";
export {
  acknowledgeResourceRecovery,
  listResourceRecoveries,
  resourceRecoveryPath,
  restoreResourceRecovery,
  rollbackResourceRecovery,
  type ResourceRecovery,
} from "@agent-deck/loop-catalog-native";
export {
  isSkillTreeFingerprint,
  MISSING_SKILL_TREE_FINGERPRINT,
  SKILL_TREE_FINGERPRINT_PREFIX,
  skillTreeFingerprint,
  skillTreeSnapshot,
  SkillTreeFingerprintError,
  type SkillTreeEntry,
  type SkillTreeSnapshot,
} from "./skillTreeFingerprint.ts";
export { scanEnv, writeEnvVar, type EnvEntry, type EnvScope } from "./env.ts";
export { resolveSkillSource, type RemoteSkillSource } from "./skillSource.ts";
export {
  scanPackagePromptLocations,
  scanPackageSkillLocations,
  type PackagePromptLocation,
  type PackagePromptScanResult,
  type PackageSkillLocation,
  type PackageSkillScanResult,
} from "./packageSkills.ts";
export {
  enumerateCodexPluginSkills,
  resolveCodexPluginSkillRefs,
  type CodexPluginScanResult,
  type CodexPluginSkillItem,
  type CodexPluginSkillRef,
} from "./codexPluginSkills.ts";
export {
  detectProjectType,
  discoverProjects,
  discoverProjectsInRoot,
  type DiscoveryCandidate,
} from "./discovery.ts";
export { listProjectFiles, type ListProjectFilesOptions } from "./files.ts";
export { listProviders, logoutProvider, type ProviderAuthInfo } from "./providers.ts";
export {
  ProviderLoginManager,
  type LoginEvent,
  type LoginStatus,
  type ProviderLoginFn,
} from "./providerLogin.ts";
export {
  LoopCatalogCapabilityError,
  ManagedSkillRepositoryStore,
  ResourceCatalogCapabilityError,
  SessionWorktreeCapabilityError,
  SessionWorktreeStore,
  type ResourceCatalogErrorCode,
  type SessionWorktreeErrorCode,
} from "@agent-deck/loop-catalog-native";
export {
  loopsDir,
  loopSlug,
  parseLoopFile,
  scanLoops,
  writeLoopFile,
  deleteLoopFile,
  duplicateLoop,
  LoopDefinitionInvalidError,
  LoopStructureNotRunnableError,
  type LoopEdit,
} from "./loops.ts";
