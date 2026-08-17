import {
  McpOAuthProvider,
  runMcpAuth,
  type McpOAuthStore,
  type OAuthClientMetadata,
} from "@agent-deck/mcp";
import { McpLoopbackServer, type McpLoopbackResult } from "./mcpLoopback.ts";

export type McpAuthFn = (
  provider: McpOAuthProvider,
  args: { serverUrl: string | URL; authorizationCode?: string },
) => Promise<"AUTHORIZED" | "REDIRECT">;

export interface McpAuthState {
  status: "unauthenticated" | "authorizing" | "authorized" | "error";
  authUrl?: string;
  error?: string;
  notice?: string;
  automatic?: boolean;
}

export interface McpOAuthRedirectMode {
  redirectUrl: string;
  automaticLoopback: boolean;
}

export interface McpOAuthOwner {
  projectId: string;
  serverId: string;
}

/** External redirects remain manual; loopback redirects use their stable configured port/path. */
export function resolveMcpOAuthRedirectMode(configured?: string): McpOAuthRedirectMode {
  const fallback = configured ?? "http://127.0.0.1:33418/mcp/oauth/callback";
  if (!configured) return { redirectUrl: fallback, automaticLoopback: true };
  try {
    const url = new URL(configured);
    const loopback =
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      Boolean(url.port);
    if (loopback) {
      url.hostname = "127.0.0.1";
      url.search = "";
      url.hash = "";
      return { redirectUrl: url.toString(), automaticLoopback: true };
    }
    return { redirectUrl: fallback, automaticLoopback: false };
  } catch {
    return { redirectUrl: fallback, automaticLoopback: false };
  }
}

type Completion = (state: McpAuthState) => void | Promise<void>;
interface ServerAuth {
  provider: McpOAuthProvider;
  state: McpAuthState;
  generation: number;
  owner?: McpOAuthOwner;
}
interface Attempt {
  key: string;
  owner?: McpOAuthOwner;
  serverUrl: string | URL;
  generation: number;
  provider: McpOAuthProvider;
  loopback?: McpLoopbackServer;
  claimed: boolean;
  completion?: Completion;
}

/** Owns project/server-scoped OAuth attempts, including listeners and exchanges. */
export class McpOAuthCoordinator {
  private readonly servers = new Map<string, ServerAuth>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly reservations = new Map<string, number>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly clearedLegacyOwners = new Set<string>();
  private readonly authFn: McpAuthFn;
  private readonly store: McpOAuthStore;
  private readonly redirectUrl: string;
  private readonly automaticLoopback: boolean;
  private generation = 0;
  private closing = false;
  private automaticReservation?: { key: string; generation: number };
  private loopbackRelease: Promise<void> = Promise.resolve();

  constructor(options: {
    store: McpOAuthStore;
    redirectUrl: string;
    automaticLoopback?: boolean;
    authFn?: McpAuthFn;
  }) {
    this.store = options.store;
    this.redirectUrl = options.redirectUrl;
    this.automaticLoopback = options.automaticLoopback ?? false;
    this.authFn = options.authFn ?? (runMcpAuth as unknown as McpAuthFn);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation),
    );
    return operation;
  }

  private clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Agent Deck",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  private makeProvider(
    key: string,
    generation: number,
    serverUrl: string | URL,
    owner?: McpOAuthOwner,
  ): McpOAuthProvider {
    if (owner) {
      const ownerKey = JSON.stringify([owner.projectId, owner.serverId]);
      if (!this.clearedLegacyOwners.has(ownerKey)) {
        // V1 used an ambiguous delimiter key and had no URL provenance. Never
        // migrate or trust those credentials; remove them on first V2 bind.
        this.store.clear(`${owner.projectId}::${owner.serverId}`);
        this.clearedLegacyOwners.add(ownerKey);
      }
    }
    const provider = new McpOAuthProvider({
      serverKey: key,
      store: this.store,
      redirectUrl: this.redirectUrl,
      clientMetadata: this.clientMetadata(),
      canPersist: () => this.reservations.get(key) === generation && !this.closing,
      onRedirect: (url) => {
        const entry = this.servers.get(key);
        if (entry?.generation !== generation) return;
        const existing = entry.state;
        entry.state = {
          status: "authorizing",
          authUrl: url.toString(),
          automatic: this.attempts.get(key)?.loopback !== undefined,
          ...(existing.notice ? { notice: existing.notice } : {}),
        };
      },
    });
    provider.bindServerUrl(serverUrl);
    return provider;
  }

  providerFor(key: string, serverUrl: string | URL, owner?: McpOAuthOwner): McpOAuthProvider {
    const normalized = new URL(String(serverUrl)).toString();
    const existing = this.servers.get(key);
    if (existing && this.reservations.get(key) === existing.generation) {
      existing.provider.bindServerUrl(normalized);
      existing.owner = owner ?? existing.owner;
      if (!this.attempts.has(key)) {
        existing.state = {
          status: existing.provider.isAuthorized() ? "authorized" : "unauthenticated",
        };
      }
      return existing.provider;
    }
    const generation = ++this.generation;
    this.reservations.set(key, generation);
    const provider = this.makeProvider(key, generation, normalized, owner);
    this.servers.set(key, {
      provider,
      generation,
      owner,
      state: { status: provider.isAuthorized() ? "authorized" : "unauthenticated" },
    });
    return provider;
  }

  state(key: string): McpAuthState {
    return this.servers.get(key)?.state ?? { status: "unauthenticated" };
  }

  isAuthorized(key: string): boolean {
    return this.servers.get(key)?.provider.isAuthorized() ?? false;
  }

  beginAuth(
    key: string,
    serverUrl: string | URL,
    completion?: Completion,
    owner?: McpOAuthOwner,
  ): Promise<McpAuthState> {
    if (this.closing) return Promise.resolve({ status: "error", error: "OAuth is shutting down" });
    // Reserve synchronously, before listener startup yields. A later call owns a
    // higher generation and an older start can only close its own listener. A
    // stable loopback port has one global owner, so a new interactive flow also
    // displaces any older listener before it can capture the wrong callback.
    const generation = ++this.generation;
    if (this.automaticLoopback && this.automaticReservation) {
      this.reservations.delete(this.automaticReservation.key);
      const displaced = this.attempts.get(this.automaticReservation.key);
      if (displaced) {
        this.attempts.delete(displaced.key);
        displaced.claimed = true;
        const entry = this.servers.get(displaced.key);
        if (entry) entry.state = { status: "unauthenticated" };
        this.loopbackRelease = this.loopbackRelease.then(async () => displaced.loopback?.close());
      }
    }
    if (this.automaticLoopback) this.automaticReservation = { key, generation };
    this.reservations.set(key, generation);
    const previous = this.attempts.get(key);
    if (previous) {
      this.attempts.delete(key);
      previous.claimed = true;
    }
    const provider = this.makeProvider(key, generation, serverUrl, owner);
    const attempt: Attempt = {
      key,
      owner,
      serverUrl,
      generation,
      provider,
      claimed: false,
      completion,
    };
    // Publish the complete login generation before listener startup yields, so
    // reconciliation cannot replace it through providerFor.
    this.attempts.set(key, attempt);
    this.servers.set(key, {
      provider,
      generation,
      owner,
      state: { status: "authorizing", automatic: false },
    });
    return this.track(this.beginReserved(attempt, previous));
  }

  private async beginReserved(
    attempt: Attempt,
    previous: Attempt | undefined,
  ): Promise<McpAuthState> {
    const { key, serverUrl, generation, provider } = attempt;
    await previous?.loopback?.close();
    await this.loopbackRelease;
    if (this.closing || this.reservations.get(key) !== generation) return this.state(key);

    if (this.automaticLoopback) {
      const loopback = new McpLoopbackServer(this.redirectUrl);
      attempt.loopback = loopback;
      try {
        await loopback.start();
      } catch {
        await loopback.close();
        attempt.loopback = undefined;
        this.servers.get(key)!.state = {
          status: "authorizing",
          automatic: false,
          notice: "Automatic callback unavailable. Enter the authorization code manually.",
        };
      }
    }
    if (!this.isCurrent(attempt)) {
      await attempt.loopback?.close();
      return this.state(key);
    }

    try {
      const result = await this.authFn(provider, { serverUrl });
      if (!this.isCurrent(attempt)) return this.state(key);
      if (result === "AUTHORIZED") return await this.finish(attempt, { status: "authorized" });
      const expectedState = provider.expectedState();
      if (attempt.loopback && expectedState) attempt.loopback.setExpectedState(expectedState);
      const state = this.state(key);
      if (state.status !== "authorizing" || !state.authUrl) {
        return await this.finish(attempt, {
          status: "error",
          error: "authorization did not produce a URL",
        });
      }
      if (attempt.loopback) this.track(this.awaitAutomatic(attempt));
      return state;
    } catch (error) {
      if (!this.isCurrent(attempt)) return this.state(key);
      return await this.finish(attempt, this.errorState(error));
    }
  }

  private async awaitAutomatic(attempt: Attempt): Promise<void> {
    const result = await attempt.loopback!.waitForCallback();
    if (!this.isCurrent(attempt)) return;
    await this.completeAttempt(attempt, result);
  }

  submitCode(
    key: string,
    serverUrl: string | URL,
    code: string,
    callbackState?: string,
  ): Promise<McpAuthState> {
    const attempt = this.attempts.get(key);
    if (
      !attempt ||
      new URL(String(attempt.serverUrl)).toString() !== new URL(String(serverUrl)).toString()
    ) {
      return Promise.resolve({
        status: "error",
        error: "sign-in attempt is no longer active — restart sign-in",
      });
    }
    return this.track(this.completeAttempt(attempt, { code, state: callbackState }));
  }

  private async completeAttempt(
    attempt: Attempt,
    callback: McpLoopbackResult,
  ): Promise<McpAuthState> {
    if (!this.isCurrent(attempt) || attempt.claimed) {
      return { status: "error", error: "sign-in attempt was already completed or superseded" };
    }
    attempt.claimed = true;
    await attempt.loopback?.close();
    const expected = attempt.provider.expectedState();
    const internalError =
      callback.error === "authorization cancelled" ||
      callback.error === "timed out waiting for the authorization redirect";
    if (!internalError && (!expected || expected !== callback.state)) {
      return await this.finish(attempt, {
        status: "error",
        error: "state mismatch (possible CSRF) — restart sign-in",
      });
    }
    if (callback.error) {
      return await this.finish(attempt, {
        status: "error",
        error: internalError
          ? callback.error
          : `authorization failed: ${callback.error.slice(0, 120)}`,
      });
    }
    if (!callback.code) {
      return await this.finish(attempt, {
        status: "error",
        error: "no authorization code returned",
      });
    }
    try {
      const result = await this.authFn(attempt.provider, {
        serverUrl: attempt.serverUrl,
        authorizationCode: callback.code,
      });
      if (!this.isCurrent(attempt))
        return { status: "error", error: "sign-in attempt was superseded" };
      return await this.finish(
        attempt,
        result === "AUTHORIZED" || attempt.provider.isAuthorized()
          ? { status: "authorized" }
          : { status: "error", error: "code exchange did not authorize" },
      );
    } catch (error) {
      if (!this.isCurrent(attempt))
        return { status: "error", error: "sign-in attempt was superseded" };
      return await this.finish(attempt, this.errorState(error));
    }
  }

  private async finish(attempt: Attempt, state: McpAuthState): Promise<McpAuthState> {
    if (!this.isCurrent(attempt)) return state;
    this.attempts.delete(attempt.key);
    await attempt.loopback?.close();
    if (
      this.automaticReservation?.key === attempt.key &&
      this.automaticReservation.generation === attempt.generation
    ) {
      this.automaticReservation = undefined;
    }
    const entry = this.servers.get(attempt.key);
    if (entry?.generation === attempt.generation) entry.state = state;
    try {
      if (!this.closing) await attempt.completion?.(state);
    } catch (error) {
      const failed = this.errorState(error);
      if (entry?.generation === attempt.generation) entry.state = failed;
      return failed;
    }
    return state;
  }

  private isCurrent(attempt: Attempt): boolean {
    return (
      !this.closing &&
      this.reservations.get(attempt.key) === attempt.generation &&
      this.attempts.get(attempt.key) === attempt &&
      this.servers.get(attempt.key)?.generation === attempt.generation
    );
  }

  async cancel(key: string): Promise<void> {
    this.reservations.delete(key);
    if (this.automaticReservation?.key === key) this.automaticReservation = undefined;
    const attempt = this.attempts.get(key);
    if (attempt) {
      this.attempts.delete(key);
      attempt.claimed = true;
      await attempt.loopback?.close();
    }
    const entry = this.servers.get(key);
    if (entry) entry.state = { status: "unauthenticated" };
  }

  ownedServerIds(projectId: string): string[] {
    return [
      ...new Set(
        [...this.servers.values()]
          .filter((entry) => entry.owner?.projectId === projectId)
          .map((entry) => entry.owner!.serverId),
      ),
    ];
  }

  async cancelProject(projectId: string): Promise<void> {
    await Promise.all(
      [...this.servers.entries()]
        .filter(([, entry]) => entry.owner?.projectId === projectId)
        .map(([key]) => this.cancel(key)),
    );
  }

  async cancelServer(serverId: string): Promise<void> {
    await Promise.all(
      [...this.servers.entries()]
        .filter(([, entry]) => entry.owner?.serverId === serverId)
        .map(([key]) => this.cancel(key)),
    );
  }

  async clearProject(projectId: string): Promise<void> {
    await Promise.all(
      [...this.servers.entries()]
        .filter(([, entry]) => entry.owner?.projectId === projectId)
        .map(([key]) => this.clear(key)),
    );
  }

  async clearServer(serverId: string): Promise<void> {
    await Promise.all(
      [...this.servers.entries()]
        .filter(([, entry]) => entry.owner?.serverId === serverId)
        .map(([key]) => this.clear(key)),
    );
  }

  async clear(key: string): Promise<void> {
    await this.cancel(key);
    this.store.clear(key);
    this.servers.delete(key);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.servers.keys()].map((key) => this.cancel(key)));
    await Promise.all([...this.inFlight]);
  }

  private errorState(error: unknown): McpAuthState {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
