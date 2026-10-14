import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The pinned Pi's own MCP transports (@earendil-works/pi-mcp), imported by
 * absolute path because Pi does not expose them to extensions. */
function piMcpModuleUrl(): string {
  const piHostRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const root of [piHostRoot, path.resolve(piHostRoot, "..", "..")]) {
    const pi = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    if (!existsSync(pi)) continue;
    const real = realpathSync(pi);
    for (const candidate of [
      path.join(real, "..", "pi-mcp", "dist", "index.js"),
      path.join(real, "node_modules", "@earendil-works", "pi-mcp", "dist", "index.js"),
    ]) {
      if (existsSync(candidate)) return pathToFileURL(candidate).href;
    }
  }
  throw new Error("Native MCP: @earendil-works/pi-mcp was not found next to the pinned Pi.");
}

/**
 * The generated bridge extension: the shared substrate under the native
 * Memory, MCP-proxy, and subagent features. Each of those is, mechanically,
 * "expose an app-managed tool to pi and route its calls back to the app."
 *
 * pi's extension API runs a tool's execute() INSIDE the pi process, so a
 * generated extension can HTTP-POST every call back to our server on
 * 127.0.0.1 and return the response as the tool result. The endpoint URL and
 * a session id are baked into the generated file (exactly how the testkit
 * mock-provider extension bakes its provider baseUrl), and it loads under
 * --no-extensions via an explicit --extension, per the launch-flag contract.
 */

export interface BridgeToolSpec {
  /** Tool name the LLM calls, e.g. "agent_deck_memory_write". */
  name: string;
  /** Human-readable label for UI. */
  label: string;
  /** Description handed to the LLM. */
  description: string;
  /**
   * JSON-Schema object (`{ type: "object", properties, required }`) describing
   * the parameters. pi/typebox validate against the JSON-Schema shape, so a
   * plain object literal is sufficient — the extension needs no typebox import.
   */
  parameters: Record<string, unknown>;
  /** Optional one-line snippet for the system prompt's tool list. */
  promptSnippet?: string;
}

export interface BridgeExtensionOptions {
  /** URL each tool call POSTs to, e.g. "http://127.0.0.1:PORT/bridge". */
  endpoint: string;
  /** Opaque session id echoed to the app so it can correlate the call. */
  sessionId: string;
  /**
   * Per-session secret baked into the extension and sent with every call. The
   * app rejects calls whose token doesn't match the session's — so a local
   * caller can't invoke another session's (project/session-scoped) tools.
   */
  token: string;
  /** The app-managed tools this bridge exposes to pi. */
  tools: BridgeToolSpec[];
  /**
   * When true, also register a before_agent_start hook that asks the app (via
   * the same endpoint, tool `__recall__`) for the memories most relevant to the
   * user's message and appends them to the turn's system prompt. Off unless the
   * app has memory recall enabled for this session.
   */
  recall?: boolean;
  /**
   * Capture the exact prompt visible to this extension's final
   * before_agent_start handler. The app bridge is appended after user/provider
   * extensions, and recall runs first inside the same handler, so this is the
   * prompt Pi will use for the turn. The callback is internal, not model-callable.
   */
  promptAudit?: boolean;
  /**
   * Host Pi's native MCP inside this extension via createMcpExtension with a
   * fixed server list instead of <agentDir>/mcp.json. Every `mcp__` call and
   * result is checked live through the endpoint (tool `__mcp_authorize__`).
   */
  nativeMcp?: {
    /** `id` is the Agent Deck server id the policy hook sends back. */
    servers: Array<{ name: string; id: string; config: Record<string, unknown> }>;
  };
}

/** The request body the bridge endpoint receives for each tool call. */
export interface BridgeCallRequest {
  sessionId: string;
  /** The per-session secret; the app validates it before dispatching. */
  token: string;
  tool: string;
  toolCallId: string;
  params: Record<string, unknown>;
}

/** The response the bridge endpoint returns; mapped to the pi tool result. */
export interface BridgeCallResponse {
  /** Text content returned to the model. */
  content: string;
  /** Marks the result as an error to the model. */
  isError?: boolean;
  /** Arbitrary structured details for logs/UI (kept on the tool result). */
  details?: unknown;
}

const BRIDGE_DIR_PREFIX = "agent-deck-bridge-ext-";

/**
 * Remove generated bridge folders a crash left behind: with native MCP they
 * hold resolved credentials. Only folders older than `maxAgeMs`, since another
 * Agent Deck instance (stable next to dev, tests) shares tmpdir() and its live
 * sessions own theirs. Returns how many were removed.
 */
export function sweepStaleBridgeExtensions(maxAgeMs = 60 * 60 * 1000): number {
  let removed = 0;
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(BRIDGE_DIR_PREFIX)) continue;
    const dir = path.join(tmpdir(), entry);
    try {
      if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Raced with its owner or locked: the next start retries.
    }
  }
  return removed;
}

/**
 * Write a pi extension that registers each spec'd tool and routes its calls to
 * `endpoint`. Returns the path to load with --extension. The generated file is
 * plain runtime JS (no type annotations) so pi's jiti loader runs it directly.
 */
export function writeBridgeExtension(opts: BridgeExtensionOptions): string {
  const dir = mkdtempSync(path.join(tmpdir(), BRIDGE_DIR_PREFIX));
  const file = path.join(dir, "bridge.ts");
  const endpoint = JSON.stringify(opts.endpoint);
  const sessionId = JSON.stringify(opts.sessionId);
  const token = JSON.stringify(opts.token);
  const tools = JSON.stringify(
    opts.tools.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: t.parameters,
      promptSnippet: t.promptSnippet,
    })),
  );
  const nativeMcp = opts.nativeMcp ? JSON.stringify(opts.nativeMcp) : undefined;
  writeFileSync(
    file,
    `${
      nativeMcp
        ? `import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { StdioTransport, StreamableHttpTransport } from ${JSON.stringify(piMcpModuleUrl())};
`
        : ""
    }export default function (pi) {
  const endpoint = ${endpoint};
  const sessionId = ${sessionId};
  const token = ${token};
  const tools = ${tools};
  // execute() has no way to set the error flag on its return, so a tool call
  // the app (or transport) reported as failed is recorded by id here and the
  // flag is flipped in the tool_result handler below — which preserves the
  // content and details the app returned (a plain throw would discard both).
  const errorCallIds = new Set();
  // Per-extension/runtime sequence. A resumed/rebound Pi loads a new extension
  // and starts again at one; the server fences only within that live owner.
  let promptAuditSequence = 0;
  // At most one turn's bounded recall evidence waits for Pi to begin its first
  // assistant message. before_agent_start always replaces/clears it before I/O.
  let pendingRecall;
  for (const t of tools) {
    pi.registerTool({
      name: t.name,
      label: t.label,
      description: t.description,
      promptSnippet: t.promptSnippet,
      parameters: t.parameters,
      execute: async (toolCallId, params, signal) => {
        let res;
        try {
          res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, token, tool: t.name, toolCallId, params }),
            signal,
          });
        } catch (err) {
          errorCallIds.add(toolCallId);
          return {
            content: [{ type: "text", text: "bridge unreachable: " + String(err) }],
            details: { bridgeError: true },
          };
        }
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          errorCallIds.add(toolCallId);
          return {
            content: [{ type: "text", text: "bridge error " + res.status + ": " + text }],
            details: { bridgeError: true, status: res.status },
          };
        }
        const data = await res.json();
        if (data.isError) errorCallIds.add(toolCallId);
        return {
          content: [{ type: "text", text: String(data.content == null ? "" : data.content) }],
          details: data.details == null ? {} : data.details,
        };
      },
    });
  }
  pi.on("tool_result", (event) => {
    if (errorCallIds.has(event.toolCallId)) {
      errorCallIds.delete(event.toolCallId);
      return { isError: true };
    }
  });
${
  nativeMcp
    ? `  // Pi's own MCP client, fed only the servers we list. updateConfig is
  // a no-op so /mcp over RPC can never rewrite an mcp.json.
  const nativeMcp = ${nativeMcp};
  // Pi's default stdio transport hands the server Pi's whole env (provider keys,
  // tokens). Spawn with the MCP SDK's safe list plus the server's own env, as the
  // proxy did. Values are used as given: Pi's env-reference and !cmd resolution only runs
  // in its default transport, and ours are already resolved.
  const SAFE_ENV = process.platform === "win32"
    ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE"]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
  const safeEnv = () => {
    const env = {};
    for (const key of SAFE_ENV) {
      const value = process.env[key];
      if (value !== undefined && !value.startsWith("()")) env[key] = value;
    }
    return env;
  };
  createMcpExtension({
    loadConfig: () => ({
      servers: nativeMcp.servers.map((s) => ({ name: s.name, config: s.config, source: "agent-deck" })),
      errors: [],
      autoEnableCodemode: false,
    }),
    updateConfig: () => {},
    // /mcp login: never open a browser on the host (a shared server has none);
    // the sign-in URL reaches the user through Pi's notify card instead.
    openUrl: () => {},
    createTransport: ({ config }, cwd, authProvider) =>
      "url" in config
        ? new StreamableHttpTransport({ url: config.url, headers: config.headers, authProvider })
        : new StdioTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd ?? cwd,
            env: { ...safeEnv(), ...config.env },
            inheritEnv: false,
            stderr: "pipe",
          }),
  })(pi);
  // PI-03c: policy stays in Agent Deck. Every MCP call, resource tools
  // included, asks the bridge (__mcp_authorize__, internal like __recall__)
  // about the server id embedded here before it runs and again on its result;
  // no answer counts as a refusal (fail closed). The owning server comes from
  // the tool's namespace (Pi sets aliases: [server]), never from the name.
  const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
  const isMcpCall = (name) => name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(name);
  const mcpRefusal = async (event, ctx) => {
    const resource = MCP_RESOURCE_TOOLS.has(event.toolName);
    const serverName = resource
      ? event.input && event.input.server
      : (pi.getAllTools().find((t) => t.name === event.toolName)?.namespace?.aliases ?? [])[0];
    const entry = nativeMcp.servers.find((s) => s.name === serverName);
    if (!entry) {
      // A resource listing without a server would reach every server at once.
      return { reason: resource
        ? "Name one MCP server in the server argument: Agent Deck checks each server separately."
        : "Agent Deck cannot tell which MCP server " + event.toolName + " belongs to." };
    }
    const timeout = AbortSignal.timeout(10000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, token, tool: "__mcp_authorize__", toolCallId: event.toolCallId, params: {
          serverId: entry.id,
          server: entry.name,
          toolName: event.toolName,
        } }),
        signal: ctx && ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
      });
      if (!res.ok) return { reason: "Agent Deck policy check failed (" + res.status + ").", failed: true };
      const data = await res.json();
      return data && data.allow === true ? undefined : { reason: String((data && data.reason) || "Refused by Agent Deck policy.") };
    } catch (err) {
      return { reason: "Agent Deck policy check failed: " + String(err), failed: true };
    }
  };
  pi.on("tool_call", async (event, ctx) => {
    if (!isMcpCall(event.toolName)) return;
    const refusal = await mcpRefusal(event, ctx);
    if (refusal) return { block: true, reason: refusal.reason };
  });
  // The call already ran: withholding the result is all that is left when the
  // policy changed meanwhile or the bridge cannot answer.
  pi.on("tool_result", async (event, ctx) => {
    let text;
    if (isMcpCall(event.toolName)) {
      const refusal = await mcpRefusal(event, ctx);
      if (refusal) {
        text = refusal.failed
          ? "The call ran; its result was withheld because Agent Deck could not be reached. Do not repeat the call."
          : "Result withheld by Agent Deck policy.";
      }
    }
    if (text) return { content: [{ type: "text", text }], details: {}, isError: true };
  });
`
    : ""
}${
      opts.recall
        ? `  // Pi 0.82 emits extension message_end before persisting that message,
  // and turn_start can also precede user persistence. The first assistant
  // message_start is the deterministic boundary after the user entry and before
  // assistant persistence/output. Clearing first makes retries idempotent.
  pi.on("message_start", (event) => {
    if (!event.message || event.message.role !== "assistant" || !pendingRecall) return;
    const recall = pendingRecall;
    pendingRecall = undefined;
    pi.appendEntry("agent-deck.memory-recall", recall);
  });
`
        : ""
    }${
      opts.recall || opts.promptAudit
        ? `  // This extension is appended after every provider/user extension. Pi runs
  // before_agent_start handlers in extension order, so this is the last prompt
  // observer. Recall (when enabled) is applied before the audit in this SAME
  // handler; the captured value is therefore exactly the value returned to Pi.
  pi.on("before_agent_start", async (event, ctx) => {
    let finalSystemPrompt = event.systemPrompt ?? ctx.getSystemPrompt();
${
  opts.recall
    ? `    // Never let an aborted/failed previous prompt leak evidence into a
    // later turn. A successful fetch below may install one fresh bounded value.
    pendingRecall = undefined;
    // Pi 1.x: before_agent_start is a union on messageType; custom-message
    // runs (sendMessage with triggerTurn) carry no prompt, so there is nothing
    // to recall against.
    if (event.messageType === "user") {
    // Recall is best-effort and bounded: a broken bridge must not stall or
    // otherwise alter the turn.
    const recallController = new AbortController();
    const recallTimer = setTimeout(() => recallController.abort(), 5000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, token, tool: "__recall__", toolCallId: "recall", params: { query: event.prompt } }),
        signal: recallController.signal,
      });
      if (res.ok) {
        const data = await res.json();
        const block = data && typeof data.content === "string" ? data.content : "";
        // Persist only bounded, payload-free source metadata. Bodies, query,
        // filesystem paths and project identity never enter the Pi entry.
        const recalledRaw = data && Array.isArray(data.recalled) ? data.recalled : [];
        const memoryTypes = new Set(["context", "decision", "runbook", "failure", "preference"]);
        const recalled = recalledRaw.length <= 5 && recalledRaw.every((memory) =>
          memory && typeof memory === "object" &&
          Object.keys(memory).every((key) => key === "id" || key === "title" || key === "type") &&
          typeof memory.id === "string" && memory.id.length > 0 && memory.id.length <= 256 &&
          typeof memory.title === "string" && memory.title.trim().length > 0 && memory.title.length <= 256 &&
          memoryTypes.has(memory.type)
        ) && new Set(recalledRaw.map((memory) => memory.id)).size === recalledRaw.length
          ? recalledRaw.map(({ id, title, type }) => ({ id, title, type }))
          : [];
        if (block) {
          if (recalled.length > 0) {
            pendingRecall = { version: 1, memories: recalled };
          }
          // Prompt injection is independent from optional transcript metadata:
          // a malformed/legacy bridge response must not silently drop recall.
          finalSystemPrompt += "\\n\\n" + block;
        }
      }
    } catch (err) {
      // Best-effort: leave the prompt unchanged.
    } finally {
      clearTimeout(recallTimer);
    }
    }
`
    : ""
}${
            opts.promptAudit
              ? `    // Sensitive, internal audit callback. It is authenticated by this
    // session's bridge token and is never registered as a model-facing tool.
    const sequence = ++promptAuditSequence;
    const auditController = new AbortController();
    // Await a credible bounded loopback acknowledgement so a normal turn's
    // capture is durable before its provider call. Failure leaves the previous
    // successful capture untouched; the monotonic sequence fences late writes.
    const auditTimer = setTimeout(() => auditController.abort(), 2000);
    auditTimer.unref?.();
    try {
      const auditResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, token, tool: "__prompt_audit__", toolCallId: "prompt-audit", params: { systemPrompt: finalSystemPrompt, sequence } }),
        signal: auditController.signal,
      });
      if (!auditResponse.ok) {
        // A rejected/stale write is not a capture for this turn.
        await auditResponse.body?.cancel().catch(() => {});
      }
    } catch (err) {
      // Auditing is best-effort and must never prevent the Pi turn.
    } finally {
      clearTimeout(auditTimer);
    }
`
              : ""
          }    return finalSystemPrompt === (event.systemPrompt ?? ctx.getSystemPrompt())
      ? undefined
      : { systemPrompt: finalSystemPrompt };
  });
`
        : ""
    }}
`,
  );
  return file;
}
