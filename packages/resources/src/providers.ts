import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { piAgentHome, type ResourceRoots } from "./paths.ts";

export interface ProviderAuthInfo {
  id: string;
  name: string;
  configured: boolean;
  source?: string;
  label?: string;
  signedIn: boolean;
  supportsAPIKey: boolean;
  supportsOAuth: boolean;
  /** PRV-01: the credential Pi uses (a stored auth.json entry wins over env). */
  credentialType?: "api_key" | "oauth";
}

/** PRV-01: Pi's Anthropic OAuth sign-in impersonates Claude Code, which
 * Anthropic's consumer terms forbid. Claude goes through `claude-bridge`
 * (the real Claude Code); `anthropic` is offered with an API key only. */
export const API_KEY_ONLY_PROVIDERS = new Set(["anthropic"]);

/** The kind of credential Pi resolves for a provider, following
 * getProviderAuthStatus: runtime key, then the stored entry, then env/config.
 * For an API-key-only provider a subscription token counts as OAuth: Pi sends
 * Claude Code identity headers for any key containing `sk-ant-oat`, stored or
 * from ANTHROPIC_OAUTH_TOKEN / ANTHROPIC_API_KEY (pi-ai anthropic-messages). */
export async function providerCredentialType(
  models: ModelRuntime,
  providerId: string,
  credentials: readonly { providerId: string; type: "api_key" | "oauth" }[],
): Promise<"api_key" | "oauth" | undefined> {
  const status = models.getProviderAuthStatus(providerId);
  if (!status.configured) return undefined;
  const stored =
    status.source === "stored"
      ? credentials.find((credential) => credential.providerId === providerId)?.type
      : "api_key";
  if (stored !== "api_key" || !API_KEY_ONLY_PROVIDERS.has(providerId)) return stored;
  const resolved = await models.getAuth(providerId).catch(() => undefined);
  if (resolved?.source === "ANTHROPIC_OAUTH_TOKEN" || resolved?.auth.apiKey?.includes("sk-ant-oat"))
    return "oauth";
  return "api_key";
}

async function runtime(roots: ResourceRoots): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(piAgentHome(roots), "auth.json"),
    allowModelNetwork: false,
  });
}

/** Every provider advertised by the pinned Pi runtime, including API-key-only providers. */
export async function listProviders(roots: ResourceRoots): Promise<ProviderAuthInfo[]> {
  const models = await runtime(roots);
  const credentials = await models.listCredentials();
  const stored = new Set(credentials.map((credential) => credential.providerId));
  return Promise.all(
    models
      .getProviders()
      .filter((provider) => provider.auth?.apiKey || provider.auth?.oauth)
      .map(async (provider) => {
        const status = models.getProviderAuthStatus(provider.id);
        return {
          id: provider.id,
          name: provider.name || provider.id,
          configured: status.configured,
          source: status.source,
          label: status.label,
          signedIn: stored.has(provider.id),
          supportsAPIKey: Boolean(provider.auth?.apiKey?.login),
          supportsOAuth: Boolean(provider.auth?.oauth) && !API_KEY_ONLY_PROVIDERS.has(provider.id),
          credentialType: await providerCredentialType(models, provider.id, credentials),
        };
      }),
  );
}

export async function logoutProvider(roots: ResourceRoots, id: string): Promise<void> {
  await (await runtime(roots)).logout(id);
}
