// Namespace import so the corrupt-file backup can be made to fail in a test:
// a named import is a live binding a spy cannot replace, and the "we could not
// back it up, so leave the file alone" path is exactly the one worth pinning.
import * as fs from "node:fs";
import path from "node:path";
import { piAgentHome, type ResourceRoots } from "./paths.ts";

/**
 * Keeps the `neuralwatt` block of `~/.pi/agent/models.json` in step with the
 * user's sign-in state and NeuralWatt's live `/v1/models` catalog, the way the
 * native app's `NeuralWattCatalogSync` does.
 *
 * `models.json` is pi's own config file, not ours: pi's model registry reads it
 * at launch and for `--list-models`, so writing the block is what makes
 * NeuralWatt models appear. Nobody hand-edits it — every other provider in the
 * file is round-tripped untouched.
 *
 * Two rules carry the weight:
 *  - The block exists ONLY while a real NeuralWatt key is stored in auth.json.
 *    Pi treats the literal `apiKey` below as "configured", so a leftover block
 *    would advertise models the user cannot call. Signing out removes it.
 *  - Nothing here ever throws at the caller, and a failed fetch leaves what is
 *    on disk alone. Model refresh must not depend on a third party being up.
 */

const PROVIDER_ID = "neuralwatt";
const DISPLAY_NAME = "NeuralWatt";
const BASE_URL = "https://api.neuralwatt.com/v1";
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const API = "openai-completions";
/** Applied to every model; NeuralWatt serves a `system` role but no `developer` role. */
const PROVIDER_COMPAT = { supportsDeveloperRole: false } as const;
/** Pi's fallback when a catalog reports no context length. */
const DEFAULT_CONTEXT_WINDOW = 131072;
/**
 * Curated: a server can report `reasoning_effort: true` while being a
 * non-thinking tier, so this is an allowlist rather than a derivation from the
 * catalog's capabilities.
 */
const REASONING_EFFORT_MODEL_IDS = new Set(["glm-5.2", "glm-5.2-fast"]);

export interface NeuralWattReconcileOptions {
  /** Whether a real NeuralWatt api_key is stored in auth.json. */
  hasRealKey: boolean;
  /** Injected so tests never reach the network. */
  fetchCatalog?: () => Promise<unknown>;
}

/** The public `/v1/models` catalog. NeuralWatt documents no auth for it, so no key is sent. */
async function fetchLiveCatalog(): Promise<unknown> {
  const response = await fetch(MODELS_ENDPOINT, {
    // Undici honours no-store through the header; the `cache` init field is not
    // in Node's RequestInit.
    headers: { "cache-control": "no-store" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`neuralwatt /v1/models responded ${response.status}`);
  return await response.json();
}

interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  maxTokens?: number;
  compat?: Record<string, boolean>;
}

function perMillion(pricing: Record<string, unknown>, key: string): number {
  const value = pricing[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parse the OpenAI-style `{ data: [{ id, metadata: { … } }] }` payload into the
 * per-model entries pi expects. An entry without an id is skipped rather than
 * failing the whole catalog.
 */
export function parseNeuralWattCatalog(payload: unknown): CatalogModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("neuralwatt catalog is not a model list");
  const models: CatalogModel[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const metadata = ((entry as { metadata?: unknown }).metadata ?? {}) as Record<string, unknown>;
    const capabilities = (metadata.capabilities ?? {}) as Record<string, unknown>;
    const limits = (metadata.limits ?? {}) as Record<string, unknown>;
    const pricing = (metadata.pricing ?? {}) as Record<string, unknown>;
    const model: CatalogModel = {
      id,
      name: typeof metadata.display_name === "string" ? metadata.display_name : id,
      reasoning: capabilities.reasoning === true,
      input: capabilities.vision === true ? ["text", "image"] : ["text"],
      contextWindow:
        typeof limits.max_context_length === "number" && limits.max_context_length > 0
          ? limits.max_context_length
          : DEFAULT_CONTEXT_WINDOW,
      cost: {
        input: perMillion(pricing, "input_per_million"),
        output: perMillion(pricing, "output_per_million"),
        cacheRead: perMillion(pricing, "cached_input_per_million"),
        cacheWrite: 0,
      },
    };
    // OMITTED when the endpoint reports no output cap: a reader then shows a dash
    // rather than inheriting pi's 16384 default, and a real limit flows through
    // here the moment NeuralWatt starts reporting one.
    if (typeof limits.max_output_tokens === "number" && limits.max_output_tokens > 0) {
      model.maxTokens = limits.max_output_tokens;
    }
    if (REASONING_EFFORT_MODEL_IDS.has(id)) model.compat = { supportsReasoningEffort: true };
    models.push(model);
  }
  return models;
}

function buildProviderBlock(models: CatalogModel[]): Record<string, unknown> {
  return {
    name: DISPLAY_NAME,
    baseUrl: BASE_URL,
    api: API,
    authHeader: true,
    // Pi rejects a custom provider that declares models with no apiKey field. It
    // is never sent: pi reads the real key from auth.json at a higher priority.
    apiKey: "placeholder",
    compat: { ...PROVIDER_COMPAT },
    models,
  };
}

function modelsFilePath(roots: ResourceRoots): string {
  return path.join(piAgentHome(roots), "models.json");
}

/** Read `providers`, apply `mutate`, write the file back atomically. */
function mutateProviders(
  roots: ResourceRoots,
  mutate: (providers: Record<string, unknown>) => void,
): void {
  const file = modelsFilePath(roots);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  let root: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    // Read OUTSIDE the try: only bytes we actually read and could not PARSE are
    // corrupt. A read that fails transiently — a lock, a permission, a directory
    // in the way — must abort rather than enter the backup-and-replace path,
    // which would otherwise rewrite a live file we never managed to see (Codex).
    const raw = fs.readFileSync(file, "utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      } else {
        throw new Error("models.json is not an object");
      }
    } catch {
      // Unreadable JSON: keep a copy before overwriting, so a corrupt file never
      // silently costs the user every other provider in it. If the copy FAILS we
      // abort — an unwritable backup used to be swallowed, and the reconcile then
      // replaced the original with a file containing only our block, destroying
      // whatever the user had in there with no way back (Codex). A throw here
      // reaches reconcile's catch, which leaves the file untouched.
      fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
      root = {};
    }
  }

  const existing = root.providers;
  // A `providers` value that is not an object is somebody else's data, not ours
  // to replace with an empty map — fail closed and leave the file alone (Codex).
  if (
    existing !== undefined &&
    (typeof existing !== "object" || existing === null || Array.isArray(existing))
  ) {
    throw new Error("models.json providers is not an object");
  }
  const providers: Record<string, unknown> = (existing ?? {}) as Record<string, unknown>;
  mutate(providers);
  root.providers = providers;

  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Bring the `neuralwatt` block in line with the user's sign-in state, returning
 * the model ids now advertised (empty when nothing was written). Best-effort by
 * design: every failure path leaves the file as it was.
 */
export async function reconcileNeuralWattCatalog(
  roots: ResourceRoots,
  options: NeuralWattReconcileOptions,
): Promise<string[]> {
  if (!options.hasRealKey) {
    // No key: remove any stale block WITHOUT contacting NeuralWatt. A user who
    // never signed in should generate no traffic to them at all.
    try {
      mutateProviders(roots, (providers) => {
        delete providers[PROVIDER_ID];
      });
    } catch {
      // Leave the file alone rather than fail a model refresh.
    }
    return [];
  }

  let models: CatalogModel[];
  try {
    models = parseNeuralWattCatalog(await (options.fetchCatalog ?? fetchLiveCatalog)());
  } catch {
    return [];
  }
  // An empty catalog reads as a transient outage, not as "the provider has no
  // models": replacing a working block with an empty one would strip the user's
  // models until the endpoint recovers.
  if (models.length === 0) return [];

  try {
    mutateProviders(roots, (providers) => {
      providers[PROVIDER_ID] = buildProviderBlock(models);
    });
  } catch {
    return [];
  }
  return models.map((model) => model.id);
}
