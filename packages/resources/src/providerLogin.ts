import { randomUUID } from "node:crypto";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import { piAgentHome, type ResourceRoots } from "./paths.ts";

export type LoginEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  /** `manualCode`: a pasted OAuth code or redirect URL (Pi `manual_code`), the only way to
   * finish a browser sign-in when Pi's loopback callback is out of the browser's reach. */
  | {
      type: "prompt";
      message: string;
      placeholder?: string;
      secret?: boolean;
      manualCode?: boolean;
    }
  | {
      type: "select";
      message: string;
      options: Array<{ id: string; label: string; description?: string }>;
    }
  /** `links`: Pi 1.x `info` events (e.g. Bedrock/Vertex setup docs). */
  | { type: "progress"; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: "done"; ok: boolean; error?: string };

export type LoginStatus = "running" | "done" | "error";
export type ProviderLoginFn = (
  authPath: string,
  providerId: string,
  authType: AuthType,
  interaction: AuthInteraction,
) => Promise<void>;

const realLoginFn: ProviderLoginFn = async (authPath, providerId, authType, interaction) => {
  const runtime = await ModelRuntime.create({ authPath, allowModelNetwork: false });
  await runtime.login(providerId, authType, interaction);
};

interface PendingPrompt {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface LoginState {
  events: LoginEvent[];
  pending: PendingPrompt | null;
  status: LoginStatus;
  abort: AbortController;
  finishedAt?: number;
  /** Identity that started it (shared server); undefined on loopback. */
  ownerId?: string;
}

const MAX_RETAINED = 20;
const TERMINAL_TTL_MS = 5 * 60_000;

export class ProviderLoginManager {
  private readonly sessions = new Map<string, LoginState>();
  constructor(private readonly loginFn: ProviderLoginFn = realLoginFn) {}

  /** `ownerId` binds the login to its initiator: poll, respond and cancel from
   * any other identity see it as unknown (shared server, SRV-11 review3 R4). */
  start(roots: ResourceRoots, providerId: string, authType: AuthType, ownerId?: string): string {
    this.evictOld();
    const loginId = randomUUID();
    const abort = new AbortController();
    const state: LoginState = { events: [], pending: null, status: "running", abort, ownerId };
    this.sessions.set(loginId, state);

    const interaction: AuthInteraction = {
      signal: abort.signal,
      notify: (event) => {
        if (event.type === "auth_url") state.events.push(event);
        else if (event.type === "device_code") state.events.push(event);
        else if (event.type === "progress") {
          state.events.push({ type: "progress", message: event.message });
        } else if (event.type === "info") {
          const links = event.links?.map((link) => ({ url: link.url, label: link.label }));
          state.events.push({
            type: "progress",
            message: event.message,
            ...(links?.length ? { links } : {}),
          });
        }
      },
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          if (state.pending) state.pending.reject(new Error("A newer provider prompt replaced it"));
          if (prompt.signal?.aborted || abort.signal.aborted) {
            reject(new Error("Provider sign-in was cancelled"));
            return;
          }
          if (prompt.type === "select") {
            state.events.push({
              type: "select",
              message: prompt.message,
              options: prompt.options.map((option) => ({
                id: option.id,
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
              })),
            });
          } else {
            state.events.push({
              type: "prompt",
              message: prompt.message,
              placeholder: prompt.placeholder,
              secret: prompt.type === "secret",
              ...(prompt.type === "manual_code" ? { manualCode: true } : {}),
            });
          }
          const pending: PendingPrompt = { resolve, reject };
          state.pending = pending;
          const cancel = () => {
            if (state.pending !== pending) return;
            state.pending = null;
            reject(new Error("Provider sign-in was cancelled"));
          };
          prompt.signal?.addEventListener("abort", cancel, { once: true });
          abort.signal.addEventListener("abort", cancel, { once: true });
        }),
    };

    const authPath = path.join(piAgentHome(roots), "auth.json");
    void this.loginFn(authPath, providerId, authType, interaction)
      .then(() => {
        state.status = "done";
        state.events.push({ type: "done", ok: true });
        state.finishedAt = Date.now();
      })
      .catch((error) => {
        state.status = "error";
        state.events.push({
          type: "done",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        state.finishedAt = Date.now();
      });
    return loginId;
  }

  /** True when the login exists and `requesterId` started it. */
  owns(loginId: string, requesterId?: string): boolean {
    return this.owned(loginId, requesterId) !== undefined;
  }

  private owned(loginId: string, requesterId: string | undefined): LoginState | undefined {
    const state = this.sessions.get(loginId);
    return state && state.ownerId === requesterId ? state : undefined;
  }

  poll(loginId: string, since: number, requesterId?: string) {
    const state = this.owned(loginId, requesterId);
    if (!state) return undefined;
    return {
      events: state.events.slice(Math.max(0, since)),
      status: state.status,
      nextCursor: state.events.length,
    };
  }

  respond(loginId: string, value: string | undefined, requesterId?: string): boolean {
    const state = this.owned(loginId, requesterId);
    if (!state?.pending) return false;
    const pending = state.pending;
    state.pending = null;
    pending.resolve(value ?? "");
    return true;
  }

  cancel(loginId: string, requesterId?: string): void {
    const state = this.owned(loginId, requesterId);
    if (!state) return;
    state.abort.abort();
    if (state.pending) {
      const pending = state.pending;
      state.pending = null;
      pending.reject(new Error("Provider sign-in was cancelled"));
    }
  }

  private evictOld(): void {
    const now = Date.now();
    for (const [id, state] of this.sessions) {
      if (state.finishedAt && now - state.finishedAt > TERMINAL_TTL_MS) this.sessions.delete(id);
    }
    if (this.sessions.size < MAX_RETAINED) return;
    for (const [id, state] of this.sessions) {
      if (this.sessions.size < MAX_RETAINED) break;
      if (state.status !== "running") this.sessions.delete(id);
    }
  }
}
