import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * OpenAI Fast mode (SES-34), ported from the native app's
 * `PiNativeSubagentBridgeExtensions`.
 *
 * Pi has no per-model "priority tier" setting, so the feature is a generated
 * extension plus a config file: the user marks models Fast, we write the set to
 * disk, and a `before_provider_request` hook adds `service_tier: "priority"` to
 * requests for exactly those models. The extension reads the config path from
 * `AGENT_DECK_OPENAI_FAST_CONFIG` at request time, so a toggle takes effect on
 * the next turn without relaunching pi.
 *
 * Everything here is deliberately narrow, because the failure mode is spending
 * a user's money on a tier they did not choose: only `openai-codex` with a base
 * model of gpt-5.4/gpt-5.5, only when the model is listed in the config, and —
 * inside the extension, where the information exists — only under OAuth, never
 * API-key auth.
 */

const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";
const SUPPORTED_BASE_MODELS = new Set(["gpt-5.4", "gpt-5.5"]);
const CONFIG_FILE = "openai-fast-mode.json";
const EXTENSION_FILE = "openai-fast-mode.ts";

/** Everything before an optional `:suffix` (e.g. `gpt-5.4:thinking` → `gpt-5.4`). */
function baseModelId(id: string): string {
  return id.split(":", 1)[0] ?? id;
}

/** Native's `isOpenAIFastEligibleModel`: the only models the toggle may offer. */
export function isOpenAIFastEligible(provider: string, id: string): boolean {
  if (provider !== PROVIDER_ID || !id) return false;
  return SUPPORTED_BASE_MODELS.has(baseModelId(id));
}

/**
 * The key the EXTENSION looks for, which is not the key we persist: settings
 * store `provider:id` (matching `disabledModels`), while the config lists
 * `provider/baseModel`. Undefined for anything ineligible, so an unsupported
 * model can never reach the config.
 */
export function fastModeConfigKey(provider: string, id: string): string | undefined {
  return isOpenAIFastEligible(provider, id) ? `${PROVIDER_ID}/${baseModelId(id)}` : undefined;
}

/**
 * Whether a model row should read as Fast. Membership is by CONFIG key, not by
 * the stored key: the extension matches on base model, so marking
 * `gpt-5.4:thinking` also upgrades plain `gpt-5.4`. Reporting per stored key
 * would have the UI say "Standard" on a row that is in fact being upgraded
 * (Codex).
 */
export function isFastModeActive(
  storedKeys: readonly string[],
  provider: string,
  id: string,
): boolean {
  const key = fastModeConfigKey(provider, id);
  if (!key) return false;
  return storedKeys.some((stored) => {
    const separator = stored.indexOf(":");
    if (separator <= 0) return false;
    return fastModeConfigKey(stored.slice(0, separator), stored.slice(separator + 1)) === key;
  });
}

export function openAIFastConfigPath(dir: string): string {
  return path.join(dir, CONFIG_FILE);
}

export function openAIFastExtensionPath(dir: string): string {
  return path.join(dir, EXTENSION_FILE);
}

/**
 * Write the enabled set, translating persisted `provider:id` keys into the
 * `provider/baseModel` form the extension reads and dropping anything
 * ineligible. Rewrites only when the bytes differ, as native does — this runs on
 * every settings change and every launch.
 */
export function writeOpenAIFastConfig(dir: string, storedKeys: readonly string[]): string {
  const enabledModels = [
    ...new Set(
      storedKeys.flatMap((key) => {
        const separator = key.indexOf(":");
        if (separator <= 0) return [];
        const configKey = fastModeConfigKey(key.slice(0, separator), key.slice(separator + 1));
        return configKey ? [configKey] : [];
      }),
    ),
  ].sort();
  const file = openAIFastConfigPath(dir);
  const payload = `${JSON.stringify({ enabledModels }, null, 2)}\n`;
  writeIfChanged(file, payload);
  return file;
}

/**
 * Replace atomically, and only when the bytes differ. A partially written config
 * would read as "no models enabled" (fail-safe) but a partially written
 * extension would fail to load, and two windows sharing a data dir must never
 * observe a half-file (Codex).
 */
function writeIfChanged(file: string, payload: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  let existing: string | undefined;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing === payload) return;
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, payload, { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * The extension source, mirroring native's. It re-reads the config per request
 * so a toggle applies to a live session, and it refuses to touch a payload that
 * already carries a `service_tier` — the user's own choice wins.
 */
const EXTENSION_SOURCE = `import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "${PROVIDER_ID}";
const API_ID = "${API_ID}";
const FAST_SERVICE_TIER = "priority";
const SUPPORTED_MODELS = new Set([${[...SUPPORTED_BASE_MODELS].map((m) => `"${m}"`).join(", ")}]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseModelID(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(":", 1)[0];
}

function enabledModels(): Set<string> {
  const path = process.env.AGENT_DECK_OPENAI_FAST_CONFIG;
  if (!path || !existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed?.enabledModels)) return new Set();
    return new Set(parsed.enabledModels.map((item: unknown) => String(item)));
  } catch (error) {
    console.error(\`Warning: could not read the Agent Deck OpenAI Fast config: \${error}\`);
    return new Set();
  }
}

function isEligible(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  const id = baseModelID(model.id);
  if (!id) return false;
  if (model.provider !== PROVIDER_ID) return false;
  if (model.api !== API_ID) return false;
  if (!SUPPORTED_MODELS.has(id)) return false;
  if (!enabledModels().has(\`\${PROVIDER_ID}/\${id}\`)) return false;
  // Priority tier is a subscription capability: never apply it to API-key auth.
  return ctx.modelRegistry.isUsingOAuth(model);
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (!isEligible(ctx)) return undefined;
    if (!isRecord(event.payload)) return undefined;
    if (baseModelID(event.payload.model) !== baseModelID(ctx.model?.id)) return undefined;
    if ("service_tier" in event.payload) return undefined;
    return { ...event.payload, service_tier: FAST_SERVICE_TIER };
  });
}
`;

/** Write (or repair) the extension. Rewrites only when the bytes differ. */
export function writeOpenAIFastExtension(dir: string): string {
  const file = openAIFastExtensionPath(dir);
  writeIfChanged(file, EXTENSION_SOURCE);
  return file;
}
