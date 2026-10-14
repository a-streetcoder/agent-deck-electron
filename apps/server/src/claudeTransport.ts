import { readFileSync } from "node:fs";
import nodePath from "node:path";
import type { SessionModelInfo, UserIdentity } from "@agent-deck/contracts";
import { API_KEY_ONLY_PROVIDERS, piAgentHome, providerCredentialType } from "@agent-deck/resources";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  migrateSessionEntries,
  ModelRuntime,
  parseSessionEntries,
  type SessionEntry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ServerContext } from "./context.ts";
import { userRoots } from "./userAgentDirs.ts";

/**
 * PRV-01: Pi's Anthropic OAuth sign-in impersonates Claude Code, which
 * Anthropic's consumer terms forbid. An API-key-only provider (anthropic) whose
 * credential is an OAuth sign-in is neither offered nor launched: Claude goes
 * through `claude-bridge` (the real Claude Code) instead. The credential stays
 * in auth.json.
 */
export const ANTHROPIC_NEEDS_API_KEY =
  "Claude through the Anthropic sign-in is not used. Add an Anthropic API key under Settings > Providers, or pick the Claude model without the API badge.";
const BRIDGE = "claude-bridge";

type Ctx = Pick<ServerContext, "rootsFor" | "userAgentDirs" | "settings" | "discoveredModels">;

const refusal = () => Object.assign(new Error(ANTHROPIC_NEEDS_API_KEY), { statusCode: 409 });

function ownerAgentDir(ctx: Ctx, owner: UserIdentity | undefined): string {
  return piAgentHome(userRoots(ctx.rootsFor(), owner, ctx.userAgentDirs));
}

/** The owner's own credentials over the shared operator models.json (SRV-11). */
export function ownerRuntime(ctx: Ctx, owner: UserIdentity | undefined): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: nodePath.join(ownerAgentDir(ctx, owner), "auth.json"),
    modelsPath: nodePath.join(piAgentHome(ctx.rootsFor()), "models.json"),
    allowModelNetwork: false,
  });
}

export async function oauthOnlyProviders(runtime: ModelRuntime): Promise<Set<string>> {
  const credentials = await runtime.listCredentials();
  return new Set(
    [...API_KEY_ONLY_PROVIDERS].filter(
      (id) => providerCredentialType(runtime, id, credentials) === "oauth",
    ),
  );
}

/** SRV-11/SRV-13: the models an owner's credentials unlock, without refused providers. */
export async function ownerCatalog(
  ctx: Ctx,
  owner: UserIdentity | undefined,
): Promise<SessionModelInfo[]> {
  const runtime = await ownerRuntime(ctx, owner);
  const refused = await oauthOnlyProviders(runtime);
  const disabled = new Set(ctx.settings.get().disabledModels);
  const models: SessionModelInfo[] = (await runtime.getAvailable())
    .filter((model) => !refused.has(model.provider))
    .map((model) => ({
      ...model,
      supportedThinkingLevels: getSupportedThinkingLevels(model),
      disabled: disabled.has(`${model.provider}:${model.id}`),
    }));
  // Extension-defined providers can be selected after an explicit Models
  // refresh. Reuse that catalog without launching any process for this draft.
  // SRV-13: the catalog is the operator's discovery (anyone may refresh it), so
  // an owner only gets the models whose provider their own dir has auth for.
  for (const model of ctx.discoveredModels ?? []) {
    if (owner && !runtime.getProviderAuthStatus(model.provider).configured) continue;
    if (refused.has(model.provider)) continue;
    if (!models.some((entry) => entry.provider === model.provider && entry.id === model.id)) {
      models.push({ ...model, disabled: disabled.has(`${model.provider}:${model.id}`) });
    }
  }
  return models;
}

/** A refused `anthropic/<m>` becomes `claude-bridge/<m>` when offered, else 409. */
export function claudeChoice(
  provider: string,
  modelId: string,
  refused: ReadonlySet<string>,
  available: readonly { provider: string; id: string }[],
): { provider: string; modelId: string } {
  if (!refused.has(provider)) return { provider, modelId };
  if (available.some((model) => model.provider === BRIDGE && model.id === modelId))
    return { provider: BRIDGE, modelId };
  throw refusal();
}

/** The model a Pi session file was last on (what a resume restores). */
function sessionFileModel(file: string): { provider: string; modelId: string } | null {
  try {
    const entries = parseSessionEntries(readFileSync(file, "utf8"));
    migrateSessionEntries(entries);
    return buildSessionContext(
      entries.filter((entry): entry is SessionEntry => entry.type !== "session"),
    ).model;
  } catch {
    return null;
  }
}

/**
 * Launch guard: the model a new session would run on, as Pi picks it (explicit
 * choice, else the resumed session file, else Pi settings). Returns the model to
 * pin instead, or undefined when the launch is fine as is; throws the 409 when a
 * refused model has no bridge twin. Only acts for an owner whose anthropic
 * credential is OAuth-only.
 */
export async function claudeLaunchModel(
  ctx: Ctx,
  owner: UserIdentity | undefined,
  chosen: { provider?: string; model?: string },
  where: { cwd: string; sessionFile?: string },
): Promise<{ provider: string; model: string } | undefined> {
  const refused = await oauthOnlyProviders(await ownerRuntime(ctx, owner));
  if (refused.size === 0) return undefined;
  let { provider, model } = chosen;
  if (!model && where.sessionFile) {
    const restored = sessionFileModel(where.sessionFile);
    provider = restored?.provider;
    model = restored?.modelId;
  }
  if (!model) {
    const settings = SettingsManager.create(where.cwd, ownerAgentDir(ctx, owner));
    provider = settings.getDefaultProvider();
    model = settings.getDefaultModel();
  }
  const slash = model?.indexOf("/") ?? -1;
  if (!provider && model && slash > 0 && refused.has(model.slice(0, slash))) {
    provider = model.slice(0, slash);
    model = model.slice(slash + 1);
  }
  const available = await ownerCatalog(ctx, owner);
  if (!model) {
    // ponytail: Pi's own fallback ranks anthropic early, so pin the first Claude
    // (else the first offered) model rather than replicate Pi's private ranking.
    const pin = available.find((entry) => entry.provider === BRIDGE) ?? available[0];
    return pin ? { provider: pin.provider, model: pin.id } : undefined;
  }
  if (!provider) {
    // A bare id resolves across providers in Pi; pin a non-refused match.
    const match =
      available.find((entry) => entry.provider === BRIDGE && entry.id === model) ??
      available.find((entry) => entry.id === model);
    return match ? { provider: match.provider, model: match.id } : undefined;
  }
  if (!refused.has(provider)) return undefined;
  const choice = claudeChoice(provider, model, refused, available);
  return { provider: choice.provider, model: choice.modelId };
}
