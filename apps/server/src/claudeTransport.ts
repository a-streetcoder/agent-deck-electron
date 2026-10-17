import { execFile } from "node:child_process";
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
import { bundledClaudeBridgeExtension, resolveClaudeCodeExecutable } from "@agent-deck/pi-host";
import { envDefaults, type ServerContext } from "./context.ts";
import { userRoots } from "./userAgentDirs.ts";

/**
 * PRV-01: Pi's Anthropic OAuth sign-in impersonates Claude Code, which
 * Anthropic's consumer terms forbid. An API-key-only provider (anthropic) whose
 * credential is an OAuth sign-in is neither offered nor launched: Claude goes
 * through `claude-bridge` (the real Claude Code) instead. The credential stays
 * in auth.json.
 */
export const ANTHROPIC_NEEDS_API_KEY =
  "Claude through the Anthropic sign-in is not used. Add an Anthropic API key under Settings > Providers, pick the Claude model without the API badge, or refresh Models.";
const BRIDGE = "claude-bridge";

type Ctx = Pick<
  ServerContext,
  | "rootsFor"
  | "userAgentDirs"
  | "settings"
  | "discoveredModels"
  | "discoverModels"
  | "claudeCodeLoggedIn"
>;

/** `claude auth status --json` under the env Pi (and so the bridge) spawns with. */
function claudeAuthStatus(): Promise<boolean> {
  const env = { ...process.env, ...envDefaults().env };
  const claude = resolveClaudeCodeExecutable(env);
  if (!claude || !bundledClaudeBridgeExtension(env)) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(claude, ["auth", "status", "--json"], { env, timeout: 15_000 }, (error, stdout) => {
      try {
        resolve(!error && (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true);
      } catch {
        resolve(false);
      }
    });
  });
}

const BRIDGE_STATUS_TTL_MS = 60_000;
const bridgeStatus = new WeakMap<Ctx, { at: number; value: Promise<boolean> }>();

/**
 * PRV-01 single source of truth for claude-bridge: the bundled bridge, a Claude
 * Code executable and a logged-in Claude Code. It is the host's login, which
 * ADR 0003 shares, so it is the same for every owner (no per-user credential).
 * Cached for a minute; `ctx.claudeCodeLoggedIn` is the test seam.
 */
export function bridgeAvailable(ctx: Ctx): Promise<boolean> {
  if (ctx.claudeCodeLoggedIn) return ctx.claudeCodeLoggedIn();
  const cached = bridgeStatus.get(ctx);
  if (cached && Date.now() - cached.at < BRIDGE_STATUS_TTL_MS) return cached.value;
  const value = claudeAuthStatus();
  bridgeStatus.set(ctx, { at: Date.now(), value });
  return value;
}

/** Lazy discovery: one in-flight run shared by concurrent launches, and at most
 * one attempt per window whatever the outcome (no Claude Code means no bridge). */
const DISCOVERY_RETRY_MS = 5 * 60_000;
const discovery = new WeakMap<Ctx, { inFlight?: Promise<void>; attemptedAt?: number }>();

/** claude-bridge models come from extension discovery, which otherwise runs
 * only when someone opens Models; a launch that needs a bridge twin runs it. */
export async function ensureBridgeCatalog(ctx: Ctx): Promise<void> {
  if (!ctx.discoverModels) return;
  if (ctx.discoveredModels?.some((model) => model.provider === BRIDGE)) return;
  if (!(await bridgeAvailable(ctx))) return;
  const state = discovery.get(ctx) ?? {};
  discovery.set(ctx, state);
  if (!state.inFlight) {
    if (state.attemptedAt !== undefined && Date.now() - state.attemptedAt < DISCOVERY_RETRY_MS)
      return;
    state.attemptedAt = Date.now();
    state.inFlight = ctx
      .discoverModels(undefined, { reconcile: false })
      .then(
        () => undefined,
        () => undefined, // best effort: the guard then refuses with the 409
      )
      .finally(() => {
        state.inFlight = undefined;
      });
  }
  await state.inFlight;
}

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

/** What an owner's credentials and the host's Claude Code make usable now. */
export interface Transport {
  /** API-key-only providers whose credential is an OAuth sign-in or token. */
  refused: Set<string>;
  /** API-key-only providers with a real API key. */
  apiKey: Set<string>;
  bridge: boolean;
}

/** The credential half of Transport: no Claude Code probe. */
export async function credentialTransport(
  runtime: ModelRuntime,
): Promise<Omit<Transport, "bridge">> {
  const credentials = await runtime.listCredentials();
  const refused = new Set<string>();
  const apiKey = new Set<string>();
  for (const id of API_KEY_ONLY_PROVIDERS) {
    const kind = await providerCredentialType(runtime, id, credentials);
    if (kind === "oauth") refused.add(id);
    if (kind === "api_key") apiKey.add(id);
  }
  return { refused, apiKey };
}

export async function ownerTransport(ctx: Ctx, runtime: ModelRuntime): Promise<Transport> {
  return { ...(await credentialTransport(runtime)), bridge: await bridgeAvailable(ctx) };
}

/**
 * Whether an operator-discovered model is usable by this owner: claude-bridge
 * only with the host's Claude Code login (every owner alike); an API-key-only
 * provider only with a current API key, owner or not (a cached discovery must
 * not outlive the key); anything else, SRV-13, when the owner's own dir has auth
 * for it (`ownerConfigured` undefined: no owner, the operator's catalog).
 */
export function discoveredUsable(
  provider: string,
  transport: Transport,
  ownerConfigured: ((provider: string) => boolean) | undefined,
): boolean {
  if (provider === BRIDGE) return transport.bridge;
  if (API_KEY_ONLY_PROVIDERS.has(provider)) return transport.apiKey.has(provider);
  return !ownerConfigured || ownerConfigured(provider);
}

/** SRV-11/SRV-13: the models an owner's credentials unlock, without refused providers. */
export async function ownerCatalog(
  ctx: Ctx,
  owner: UserIdentity | undefined,
): Promise<SessionModelInfo[]> {
  const runtime = await ownerRuntime(ctx, owner);
  const transport = await ownerTransport(ctx, runtime);
  const disabled = new Set(ctx.settings.get().disabledModels);
  const models: SessionModelInfo[] = (await runtime.getAvailable())
    .filter((model) => !transport.refused.has(model.provider))
    .map((model) => ({
      ...model,
      supportedThinkingLevels: getSupportedThinkingLevels(model),
      disabled: disabled.has(`${model.provider}:${model.id}`),
    }));
  // Extension-defined providers can be selected after a Models refresh (or the
  // lazy one below). Reuse that catalog without launching any process here.
  const configured = owner
    ? (provider: string) => runtime.getProviderAuthStatus(provider).configured
    : undefined;
  for (const model of ctx.discoveredModels ?? []) {
    if (!discoveredUsable(model.provider, transport, configured)) continue;
    if (!models.some((entry) => entry.provider === model.provider && entry.id === model.id)) {
      models.push({ ...model, disabled: disabled.has(`${model.provider}:${model.id}`) });
    }
  }
  return models;
}

/** A live session's own catalog under the same rules: refused providers out,
 * claude-bridge only while Claude Code is logged in. */
export function liveUsable<T extends { provider: string }>(
  models: readonly T[],
  transport: Transport,
): T[] {
  return models.filter(
    (model) =>
      !transport.refused.has(model.provider) && (model.provider !== BRIDGE || transport.bridge),
  );
}

/** A refused `anthropic/<m>` becomes `claude-bridge/<m>` when offered, else 409. */
export function claudeChoice(
  provider: string,
  modelId: string,
  refused: ReadonlySet<string>,
  available: readonly { provider: string; id: string }[],
): { provider: string; modelId: string } {
  if (!refused.has(provider)) return { provider, modelId };
  // A dated id (claude-opus-4-5-20251101) matches its undated bridge alias.
  const undated = modelId.replace(/-\d{8}$/, "");
  const twin =
    available.find((model) => model.provider === BRIDGE && model.id === modelId) ??
    available.find((model) => model.provider === BRIDGE && model.id === undated);
  if (twin) return { provider: BRIDGE, modelId: twin.id };
  throw refusal();
}

/** The model a Pi session file was last on (what a resume restores), or the one
 * in force at `entryId` (what a fork from that message restores). */
function sessionFileModel(
  file: string,
  entryId?: string,
): { provider: string; modelId: string } | null {
  try {
    const entries = parseSessionEntries(readFileSync(file, "utf8"));
    migrateSessionEntries(entries);
    return buildSessionContext(
      entries.filter((entry): entry is SessionEntry => entry.type !== "session"),
      entryId,
    ).model;
  } catch {
    return null;
  }
}

/** Where a launch resumes: the session file, and for a fork from a message, its entry. */
type LaunchWhere = { cwd: string; sessionFile?: string; entryId?: string };

/** The model Pi would pick for a launch: explicit choice, else the resumed
 * session file, else Pi settings; a refused `provider/model` id is split. */
function launchChoice(
  ctx: Ctx,
  owner: UserIdentity | undefined,
  chosen: { provider?: string; model?: string },
  where: LaunchWhere,
  refused: ReadonlySet<string>,
): { provider?: string; model?: string } {
  let { provider, model } = chosen;
  if (!model && where.sessionFile) {
    const restored = sessionFileModel(where.sessionFile, where.entryId);
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
  return { provider, model };
}

/** The app's default model (`provider:id` or a bare id, Settings) when the
 * owner's catalog offers it: what a pinned launch should land on before the
 * first offered entry, which may be one the owner's account cannot use. */
export function preferredPin(
  ctx: Pick<Ctx, "settings">,
  available: readonly { provider: string; id: string }[],
): { provider: string; id: string } | undefined {
  const raw = ctx.settings.get().defaultModel;
  if (!raw) return undefined;
  const separator = raw.indexOf(":");
  const provider = separator > 0 ? raw.slice(0, separator) : undefined;
  const id = separator > 0 ? raw.slice(separator + 1) : raw;
  return available.find((entry) => entry.id === id && (!provider || entry.provider === provider));
}

/** The model to run among `available` (the owner's catalog), or undefined when
 * it is not resolvable here; throws the 409 when a refused model has no twin. */
function pinLaunchModel(
  provider: string | undefined,
  model: string | undefined,
  refused: ReadonlySet<string>,
  available: readonly { provider: string; id: string }[],
  preferred?: { provider: string; id: string },
): { provider: string; id: string } | undefined {
  if (!model) {
    // Pi's own fallback, unless it would land on a refused sign-in.
    if (refused.size === 0) return undefined;
    // ponytail: Pi's own fallback ranks anthropic early, so pin the app default,
    // else the first Claude (else the first offered) model rather than replicate
    // Pi's private ranking. With nothing offered Pi would fall back to the
    // sign-in itself: refuse.
    const pin = preferred ?? available.find((entry) => entry.provider === BRIDGE) ?? available[0];
    if (!pin) throw refusal();
    return { provider: pin.provider, id: pin.id };
  }
  if (!provider) {
    // A bare id resolves across providers in Pi; pin a non-refused match.
    const match =
      available.find((entry) => entry.provider === BRIDGE && entry.id === model) ??
      available.find((entry) => entry.id === model);
    return match && { provider: match.provider, id: match.id };
  }
  const choice = claudeChoice(provider, model, refused, available);
  return { provider: choice.provider, id: choice.modelId };
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
  where: LaunchWhere,
): Promise<{ provider: string; model: string } | undefined> {
  const { refused } = await credentialTransport(await ownerRuntime(ctx, owner));
  if (refused.size === 0) return undefined;
  const { provider, model } = launchChoice(ctx, owner, chosen, where, refused);
  // A claude-bridge choice without Claude Code on this host: Pi cannot register
  // the provider (no bridge extension) and falls back to its own default, the
  // refused sign-in. Pin as if no model were chosen.
  const bridgeless = provider === BRIDGE && !(await bridgeAvailable(ctx));
  if (provider && model && !refused.has(provider) && !bridgeless) return undefined;
  await ensureBridgeCatalog(ctx);
  // The twin is looked up by id; the thinking choice stays on the pinned model.
  const parts = model === undefined || bridgeless ? undefined : modelParts(provider, model);
  const available = await ownerCatalog(ctx, owner);
  const pinned = pinLaunchModel(
    bridgeless ? undefined : provider,
    parts?.id,
    refused,
    available,
    preferredPin(ctx, available),
  );
  const thinking = parts?.thinking ? `:${parts.thinking}` : "";
  return pinned && { provider: pinned.provider, model: `${pinned.id}${thinking}` };
}

/** A `--model` pattern split from its `:<thinking>` suffix, and without a
 * redundant `<provider>/` prefix when the provider is given separately. */
function modelParts(provider: string | undefined, model: string) {
  const thinking = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(model)?.[1];
  const id = thinking ? model.slice(0, -thinking.length - 1) : model;
  const bare = provider && id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
  return { id: bare, literal: id, thinking };
}

/**
 * SRV-15a: the model a fork would run on (as Pi picks it), as `provider/model`,
 * when the owner's catalog (`available`) lacks it. Lenient like a new session:
 * only a concrete model of a provider Pi knows without a Models refresh is
 * named; a fuzzy `--model` pattern or an extension provider (claude-bridge
 * included) is left to Pi.
 */
export async function unofferedLaunchModel(
  ctx: Ctx,
  owner: UserIdentity | undefined,
  chosen: { provider?: string; model?: string },
  where: LaunchWhere,
  available: readonly { provider: string; id: string }[],
): Promise<string | undefined> {
  const choice = launchChoice(ctx, owner, chosen, where, new Set());
  if (!choice.model) return undefined;
  const { id: bare, literal } = modelParts(choice.provider, choice.model);
  const slash = literal.indexOf("/");
  const provider = choice.provider ?? (slash > 0 ? literal.slice(0, slash) : undefined);
  if (!provider) return undefined;
  // Exact provider/id, read either way: `openrouter` + `openrouter/meta/llama`
  // may be the id `meta/llama`, or a literal id; a bare `a/b` may be a whole id.
  const ids = choice.provider ? [...new Set([literal, bare])] : [literal.slice(slash + 1)];
  const offered = available.some(
    (entry) =>
      (entry.provider === provider && ids.includes(entry.id)) ||
      (!choice.provider && entry.id === literal),
  );
  if (offered) return undefined;
  const runtime = await ownerRuntime(ctx, owner);
  const known = ids.find((id) => runtime.getModel(provider, id));
  return known && `${provider}/${known}`;
}

/**
 * The model a draft's launch will run on (claudeLaunchModel's choice, without
 * bridge discovery), among `available` (the owner's catalog). Null when nothing
 * is resolvable before the launch (Pi's own fallback, an unmatched bare id, a
 * refused model without a twin yet).
 */
export async function previewLaunchModel(
  ctx: Ctx,
  owner: UserIdentity | undefined,
  chosen: { provider?: string; model?: string },
  where: { cwd: string },
  available: readonly { provider: string; id: string }[],
): Promise<{ provider: string; id: string } | null> {
  const { refused } = await credentialTransport(await ownerRuntime(ctx, owner));
  const { provider, model } = launchChoice(ctx, owner, chosen, where, refused);
  // Outside the catalog (an extension provider before a Models refresh) a
  // non-refused explicit model still launches as named.
  if (provider && model && !refused.has(provider)) return { provider, id: model };
  try {
    return pinLaunchModel(provider, model, refused, available) ?? null;
  } catch {
    return null;
  }
}
