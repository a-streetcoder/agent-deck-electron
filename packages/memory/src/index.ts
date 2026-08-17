export {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type MemoryRecord,
  type MemorySearchHit,
  type MemoryStatus,
  type MemoryType,
  type MemoryWriteInput,
  type MemoryWriteResult,
} from "./types.ts";
export {
  deleteMemory,
  deleteMemoryIfStale,
  getMemory,
  injectableIndex,
  listMemories,
  markMemoriesUsed,
  markStale,
  searchMemories,
  semanticSearchMemories,
  semanticSearchMemoriesWithOutcome,
  setMemoryStatus,
  writeMemory,
  type MemoryStore,
  type SemanticSearchFailure,
  type SemanticSearchOutcome,
} from "./store.ts";
export { centeredCosineScores, cosineSimilarity, meanCenter, type Embedder } from "./semantic.ts";
export { createOnDeviceEmbedder, EmbedderUnavailableError } from "./embedder.ts";
export { projectMemoryDir, projectMemoryId, standardizeProjectPath } from "./paths.ts";
export {
  buildMemoryPreamble,
  buildRecalledMemories,
  renderRecalledMemories,
  type MemoryIndex,
  type RecalledMemoryRecord,
  type RecalledMemoryRender,
} from "./preamble.ts";
export { graphemeCount, truncateGraphemes } from "./graphemes.ts";
export { parseMemory, serializeMemory } from "./frontmatter.ts";
export { scanForSecrets, type SecretScanResult } from "./secrets.ts";
export {
  FUZZY_MIN_LEN,
  fuzzyMatchedTerms,
  informativeTerms,
  memoryTerms,
  overlapCoefficient,
  semanticInformativeTerms,
  semanticMemoryTerms,
  sharedTerms,
  withinOneEdit,
} from "./text.ts";
