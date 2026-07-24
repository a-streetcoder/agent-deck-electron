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
  return models
    .getProviders()
    .filter((provider) => provider.auth?.apiKey || provider.auth?.oauth)
    .map((provider) => {
      const status = models.getProviderAuthStatus(provider.id);
      return {
        id: provider.id,
        name: provider.name || provider.id,
        configured: status.configured,
        source: status.source,
        label: status.label,
        signedIn: stored.has(provider.id),
        supportsAPIKey: Boolean(provider.auth?.apiKey?.login),
        supportsOAuth: Boolean(provider.auth?.oauth),
      };
    });
}

export async function logoutProvider(roots: ResourceRoots, id: string): Promise<void> {
  await (await runtime(roots)).logout(id);
}
