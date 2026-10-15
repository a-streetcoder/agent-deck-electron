import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { serverLog } from "./serverLog.ts";

/**
 * ANA-01: anonymous usage counts (PostHog). Only the events and property keys
 * below are ever sent; anything else is dropped here, so a call site cannot leak
 * a path, title or prompt by accident. Off on the shared server, under tests,
 * without a key, and when the user turned it off (Settings > Performance).
 */
const EVENTS = {
  app_started: [],
  session_created: ["provider", "model"],
  loop_started: [],
  subagent_spawned: [],
  session_moved: ["direction"],
  mcp_server_connected: ["transport"],
  settings_analytics_changed: ["enabled"],
} as const satisfies Record<string, readonly string[]>;

export type AnalyticsEvent = keyof typeof EVENTS;
type PropValue = string | boolean;

/** What the module hands to PostHog; posthog-node's client satisfies it. */
export interface AnalyticsTransport {
  capture(message: {
    distinctId: string;
    event: string;
    properties: Record<string, PropValue>;
  }): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface Analytics {
  /** A key is set and this is a local, non-test backend: the user's switch decides. */
  readonly available: boolean;
  /** available and switched on: worth computing an event's props. */
  active(): boolean;
  track(event: AnalyticsEvent, props?: Record<string, unknown>): void;
  /** Flush the queued batch; bounded so it never holds up shutdown for long. */
  shutdown(): Promise<void>;
}

export interface AnalyticsOptions {
  enabled(): boolean;
  key: string | undefined;
  dataDir: string;
  appVersion: string;
  sharedServer: boolean;
  /** Defaults to NODE_ENV === "test" or AGENT_DECK_TEST === "1". */
  testMode?: boolean;
  /** Defaults to posthog-node against eu.i.posthog.com. */
  transport?: (key: string) => AnalyticsTransport | Promise<AnalyticsTransport>;
  /** The HTTP fetch posthog-node sends with (tests). */
  fetch?: typeof fetch;
  /** Per-request limit, below the SDK's 10 s request deadline and the 2 s shutdown flush. */
  requestTimeoutMs?: number;
}

// A path, URL, `provider:model` key or free text: not a plain identifier, so not sent.
// `model` may hold `/` and `:` (launchModelProps admits only Pi's built-in ids),
// but never a backslash or whitespace.
const unsafe = (key: string, value: string): boolean =>
  key === "model" ? /[\\\s]/.test(value) : /[/\\:\s]/.test(value);

async function posthogTransport(
  key: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  requestTimeoutMs = 1500,
): Promise<AnalyticsTransport> {
  // Loaded on first use, so a backend that never sends never loads the SDK.
  const { PostHog } = await import("posthog-node");
  let logged = false;
  const logOnce = (error: unknown): void => {
    if (logged) return;
    logged = true;
    serverLog.info("analytics", "sending usage counts failed (not retried)", error);
  };
  const client = new PostHog(key, {
    host: "https://eu.i.posthog.com",
    disableGeoip: true,
    // The SDK console.errors every failed flush; a failure is logged once here
    // and answered with a synthetic success so the batch is dropped quietly.
    // Each request is bounded below the SDK's deadlines, so a blackholed
    // connection never reaches the SDK's retry or critical-timeout logging.
    fetch: async (url, init) => {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, requestTimeoutMs);
      });
      try {
        const signal = init.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal;
        const request = fetchImpl(url, { ...init, signal } as RequestInit);
        request.catch(() => undefined); // a late rejection after the timeout
        const response = await Promise.race([request, timedOut]);
        if (!response) {
          logOnce(new Error(`no answer within ${requestTimeoutMs} ms`));
        } else if (response.status < 400) {
          return response;
        } else {
          logOnce(new Error(`HTTP ${response.status}`));
          try {
            await response.body?.cancel();
          } catch {
            // The body is dropped either way.
          }
        }
      } catch (error) {
        logOnce(error);
      } finally {
        clearTimeout(timer);
      }
      return { status: 200, text: async () => "", json: async () => ({}) };
    },
  });
  client.on("error", logOnce);
  return {
    capture: ({ distinctId, event, properties }) =>
      // Never identified, so never a person profile.
      client.capture({
        distinctId,
        event,
        properties: { ...properties, $process_person_profile: false },
      }),
    shutdown: (timeoutMs) => client.shutdown(timeoutMs),
  };
}

/** The random id for this install, created once in the data directory. */
function installId(dataDir: string): string {
  const file = nodePath.join(dataDir, "install-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Missing: create it below.
  }
  const id = randomUUID();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${id}\n`);
  return id;
}

export function createAnalytics(options: AnalyticsOptions): Analytics {
  const testMode =
    options.testMode ?? (process.env.NODE_ENV === "test" || process.env.AGENT_DECK_TEST === "1");
  const available = Boolean(options.key) && !testMode && !options.sharedServer;
  let transport: Promise<AnalyticsTransport | undefined> | undefined;
  let distinctId: string | undefined;
  let failed = false;
  const platform = `${process.platform}-${process.arch}`;
  // Analytics never fails a request: give up for this run, say so once.
  const fail = (error: unknown): undefined => {
    if (!failed) serverLog.info("analytics", "usage counts disabled for this run", error);
    failed = true;
    return undefined;
  };

  return {
    available,
    active: () => available && !failed && options.enabled(),
    track(event, props = {}) {
      if (!available || failed || !options.enabled()) return;
      try {
        distinctId ??= installId(options.dataDir);
        const properties: Record<string, PropValue> = {};
        for (const key of EVENTS[event] as readonly string[]) {
          const value = props[key];
          if (typeof value === "string" ? value && !unsafe(key, value) : typeof value === "boolean")
            properties[key] = value as PropValue;
        }
        properties.appVersion = options.appVersion;
        properties.platform = platform;
        const message = { distinctId, event, properties };
        transport ??= Promise.resolve()
          .then(() =>
            options.transport
              ? options.transport(options.key!)
              : posthogTransport(options.key!, options.fetch, options.requestTimeoutMs),
          )
          .catch(fail);
        void transport.then((ready) => {
          if (!ready || failed) return;
          try {
            ready.capture(message);
          } catch (error) {
            fail(error);
          }
        });
      } catch (error) {
        fail(error);
      }
    },
    async shutdown() {
      try {
        await (await transport)?.shutdown(2000);
      } catch {
        // Unsent counts are dropped on exit.
      }
    },
  };
}

// Pi's built-in providers plus Agent Deck's Claude Code bridge. Anything else
// (models.json, extensions) is user-named and reported as "custom".
const KNOWN_PROVIDERS = new Set<string>([...getBuiltinProviders(), "claude-bridge"]);
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** Pi's static built-in ids; claude-bridge serves the built-in Anthropic list. */
function builtinModelIds(provider: string): Set<string> {
  const source = provider === "claude-bridge" ? "anthropic" : provider;
  return new Set(
    getBuiltinModels(source as Parameters<typeof getBuiltinModels>[0]).map((model) => model.id),
  );
}

/**
 * provider and model of a launch, safe to send: a provider outside Pi's
 * built-ins, or a model outside Pi's static built-in list for that provider
 * (a models.json entry, even under a built-in provider), becomes "custom".
 */
export function launchModelProps(plan: unknown): { provider?: string; model?: string } {
  if (!plan || typeof plan !== "object") return {};
  const { provider, model } = plan as { provider?: unknown; model?: unknown };
  if (typeof provider !== "string" && typeof model !== "string") return {};
  if (typeof provider !== "string" || !KNOWN_PROVIDERS.has(provider))
    return { provider: "custom", model: "custom" };
  const id = typeof model === "string" ? model.replace(THINKING_SUFFIX, "") : undefined;
  if (id === undefined) return { provider };
  return { provider, model: builtinModelIds(provider).has(id) ? id : "custom" };
}
