import type { DeploymentProfile } from "@agent-deck/contracts";
import { trustedProxyConfigFromEnv, type TrustedProxyConfig } from "./trustedProxy.ts";

/**
 * ADR 0008: the one deployment profile this process runs under, resolved once
 * at startup from the environment. Every behaviour that differs between the
 * desktop app and the shared server derives from it (the `sharedServer`
 * boolean, the record side, the sandbox rules, the web's capabilities), so
 * the divergence has one source and one list (the ADR's matrix).
 *
 * - `desktop`: one person, their own machine, no identity on requests.
 * - `shared-server`: behind a trusted proxy that verifies every request's
 *   identity (today Cloudflare Access); several people, per-user state.
 */
export type { DeploymentProfile };

export interface ResolvedProfile {
  profile: DeploymentProfile;
  /** The proxy configuration a shared server verifies identities with. */
  trustedProxy: TrustedProxyConfig | null;
  /** ADR 0006: which side the records this process creates live on. */
  side: "server" | "local";
}

export function resolveProfile(env: NodeJS.ProcessEnv = process.env): ResolvedProfile {
  const trustedProxy = trustedProxyConfigFromEnv(env);
  const profile: DeploymentProfile = trustedProxy ? "shared-server" : "desktop";
  return { profile, trustedProxy, side: profile === "shared-server" ? "server" : "local" };
}
