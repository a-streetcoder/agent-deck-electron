import { randomUUID } from "node:crypto";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import { piAgentHome, type ResourceRoots } from "./paths.ts";

export type LoginEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "prompt"; message: string; placeholder?: string; secret?: boolean }
  | { type: "select"; message: string; options: Array<{ id: string; label: string }> }
  | { type: "progress"; message: string }
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

interface LoginState {
  events: LoginEvent[];
  pending: ((value: string | undefined) => void) | null;
  status: LoginStatus;
  abort: AbortController;
  finishedAt?: number;
}

const MAX_RETAINED = 20;
const TERMINAL_TTL_MS = 5 * 60_000;

export class ProviderLoginManager {
  private readonly sessions = new Map<string, LoginState>();
  constructor(private readonly loginFn: ProviderLoginFn = realLoginFn) {}

  start(roots: ResourceRoots, providerId: string, authType: AuthType): string {
    this.evictOld();
    const loginId = randomUUID();
    const abort = new AbortController();
    const state: LoginState = { events: [], pending: null, status: "running", abort };
    this.sessions.set(loginId, state);

    const interaction: AuthInteraction = {
      signal: abort.signal,
      notify: (event) => {
        if (event.type === "auth_url") state.events.push(event);
        else if (event.type === "device_code") state.events.push(event);
        else if (event.type === "progress" || event.type === "info") {
          state.events.push({ type: "progress", message: event.message });
        }
      },
      prompt: (prompt) =>
        new Promise<string>((resolve) => {
          if (prompt.type === "select") {
            state.events.push({
              type: "select",
              message: prompt.message,
              options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
            });
          } else {
            state.events.push({
              type: "prompt",
              message: prompt.message,
              placeholder: prompt.placeholder,
              secret: prompt.type === "secret",
            });
          }
          state.pending = (value) => resolve(value ?? "");
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

  poll(loginId: string, since: number) {
    const state = this.sessions.get(loginId);
    if (!state) return undefined;
    return {
      events: state.events.slice(Math.max(0, since)),
      status: state.status,
      nextCursor: state.events.length,
    };
  }

  respond(loginId: string, value: string | undefined): boolean {
    const state = this.sessions.get(loginId);
    if (!state?.pending) return false;
    const resolve = state.pending;
    state.pending = null;
    resolve(value);
    return true;
  }

  cancel(loginId: string): void {
    const state = this.sessions.get(loginId);
    if (!state) return;
    state.abort.abort();
    if (state.pending) {
      const resolve = state.pending;
      state.pending = null;
      resolve(undefined);
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
