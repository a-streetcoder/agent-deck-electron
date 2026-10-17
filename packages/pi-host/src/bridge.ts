import {
  existsSync,
  mkdirSync,
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
  // Bundled builds (desktop, server image) locate Pi through AGENT_DECK_PI_CLI
  // (`<pi package>/dist/cli.js`); the source-relative roots cover workspace runs.
  const cli = process.env.AGENT_DECK_PI_CLI?.trim();
  const piDirs = [
    ...(cli ? [path.resolve(path.dirname(cli), "..")] : []),
    ...[piHostRoot, path.resolve(piHostRoot, "..", "..")].map((root) =>
      path.join(root, "node_modules", "@earendil-works", "pi-coding-agent"),
    ),
  ];
  for (const pi of piDirs) {
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
 * pi's extension API runs a tool's execute() INSIDE the pi process. Every
 * call rides on Pi's own stdio (ADR 0007, amendment 2): the extension opens an
 * `input` dialog titled {@link BRIDGE_UI_TITLE} with the call as JSON in the
 * placeholder, Pi writes it as an `extension_ui_request` and blocks the call
 * until the matching `extension_ui_response`, whose value is a
 * {@link BridgeReply} as JSON. The server knows the session from the process
 * the line came from: no endpoint, token or socket, inside or outside a
 * sandbox. The file loads under --no-extensions via an explicit --extension,
 * per the launch-flag contract.
 */

/** The dialog title that marks an extension_ui_request as a bridge call. */
export const BRIDGE_UI_TITLE = "agent-deck-bridge/1";

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
  /** The folder the generated extension's own folder is created in
   * (default: the OS temp folder). The server uses the session's
   * `<dataDir>/sandbox/<sessionId>`. */
  dir?: string;
  /** The app-managed tools this bridge exposes to pi. */
  tools: BridgeToolSpec[];
  /**
   * When true, also register a before_agent_start hook that asks the app (via
   * the same bridge, tool `__recall__`) for the memories most relevant to the
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
   * result is checked live through the bridge (tool `__mcp_authorize__`).
   */
  nativeMcp?: {
    /** `id` is the Agent Deck server id the policy hook sends back. */
    servers: Array<{ name: string; id: string; config: Record<string, unknown> }>;
  };
}

/** One call as the extension sends it (the dialog's placeholder). */
export interface BridgeWireCall {
  tool: string;
  toolCallId: string;
  params: Record<string, unknown>;
}

/** A call as the app dispatches it: the wire call plus the session it came
 * from and that session's current bridge generation (server-side only). */
export interface BridgeCallRequest extends BridgeWireCall {
  sessionId: string;
  token: string;
}

/** The answer to one call (the dialog's value): an HTTP-like status and body. */
export interface BridgeReply {
  status: number;
  body: unknown;
}

/** A bridge call read from Pi's stdout. */
export interface BridgeUiRequest {
  /** The dialog id to answer. */
  id: string;
  /** The parsed call, or undefined when the placeholder was not a call. */
  call: BridgeWireCall | undefined;
  /** Pi resolves the dialog on its own after this long. */
  timeoutMs?: number;
}

/**
 * The bridge call in a Pi event, or undefined when the event is anything else
 * (a genuine extension dialog included: only the title marks a bridge call).
 */
export function parseBridgeUiRequest(event: unknown): BridgeUiRequest | undefined {
  const e = event as {
    type?: unknown;
    id?: unknown;
    method?: unknown;
    title?: unknown;
    placeholder?: unknown;
    timeout?: unknown;
  };
  if (
    !e ||
    e.type !== "extension_ui_request" ||
    e.method !== "input" ||
    e.title !== BRIDGE_UI_TITLE ||
    typeof e.id !== "string"
  ) {
    return undefined;
  }
  const timeoutMs = typeof e.timeout === "number" && e.timeout > 0 ? e.timeout : undefined;
  let call: BridgeWireCall | undefined;
  try {
    const raw = JSON.parse(String(e.placeholder)) as Partial<BridgeWireCall>;
    if (
      raw &&
      typeof raw.tool === "string" &&
      typeof raw.toolCallId === "string" &&
      (raw.params === undefined || (typeof raw.params === "object" && raw.params !== null))
    ) {
      call = { tool: raw.tool, toolCallId: raw.toolCallId, params: raw.params ?? {} };
    }
  } catch {
    // Not JSON: answered as a bad request.
  }
  return { id: e.id, call, ...(timeoutMs ? { timeoutMs } : {}) };
}

/** The extension_ui_response line that answers a bridge call. */
export const bridgeUiResponse = (
  id: string,
  reply: BridgeReply,
): { type: "extension_ui_response"; id: string; value: string } => ({
  type: "extension_ui_response",
  id,
  value: JSON.stringify(reply),
});

/** The response a bridge tool handler returns; mapped to the pi tool result. */
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
 * sessions own theirs. `root` is the folder they were generated in (default
 * the OS temp folder; a missing root has nothing to sweep). Returns how many
 * were removed.
 */
export function sweepStaleBridgeExtensions(maxAgeMs = 60 * 60 * 1000, root = tmpdir()): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(BRIDGE_DIR_PREFIX)) continue;
    const dir = path.join(root, entry);
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
 * the app over Pi's stdio. Returns the path to load with --extension. The
 * generated file is plain runtime JS (no type annotations) so pi's jiti loader
 * runs it directly.
 */
export function writeBridgeExtension(opts: BridgeExtensionOptions): string {
  const parent = opts.dir ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, BRIDGE_DIR_PREFIX));
  const file = path.join(dir, "bridge.ts");
  const title = JSON.stringify(BRIDGE_UI_TITLE);
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
  const tools = ${tools};
  // Every call is an input dialog with this title and the call as JSON; the
  // app answers with { status, body } as JSON. No answer (an abort, the
  // timeout, Pi or the app going away) resolves undefined and throws here.
  const bridgeCall = async (ctx, tool, toolCallId, params, signal, timeout) => {
    if (!ctx || !ctx.ui) throw new Error("no extension UI to reach Agent Deck");
    const raw = await ctx.ui.input(${title}, JSON.stringify({ tool, toolCallId, params }), { signal, timeout });
    if (raw === undefined) throw new Error(signal && signal.aborted ? "aborted" : "no answer from Agent Deck");
    const reply = JSON.parse(raw);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: reply.body };
  };
  const replyText = (res) => typeof res.body === "string" ? res.body : JSON.stringify(res.body);
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
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        let res;
        try {
          res = await bridgeCall(ctx, t.name, toolCallId, params, signal);
        } catch (err) {
          errorCallIds.add(toolCallId);
          return {
            content: [{ type: "text", text: "bridge unreachable: " + String(err) }],
            details: { bridgeError: true },
          };
        }
        if (!res.ok) {
          errorCallIds.add(toolCallId);
          return {
            content: [{ type: "text", text: "bridge error " + res.status + ": " + replyText(res) }],
            details: { bridgeError: true, status: res.status },
          };
        }
        const data = res.body || {};
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
    try {
      const res = await bridgeCall(ctx, "__mcp_authorize__", event.toolCallId, {
        serverId: entry.id,
        server: entry.name,
        toolName: event.toolName,
      }, ctx && ctx.signal, 10000);
      if (!res.ok) return { reason: "Agent Deck policy check failed (" + res.status + ").", failed: true };
      const data = res.body;
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
    // later turn. A successful bridge call below may install one fresh bounded value.
    pendingRecall = undefined;
    // Pi 1.x: before_agent_start is a union on messageType; custom-message
    // runs (sendMessage with triggerTurn) carry no prompt, so there is nothing
    // to recall against.
    if (event.messageType === "user") {
    // Recall is best-effort and bounded: a broken bridge must not stall or
    // otherwise alter the turn.
    try {
      const res = await bridgeCall(ctx, "__recall__", "recall", { query: event.prompt }, undefined, 5000);
      if (res.ok) {
        const data = res.body;
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
    }
    }
`
    : ""
}${
            opts.promptAudit
              ? `    // Sensitive, internal audit callback. The app accepts it only from this
    // session's own Pi process and it is never a model-facing tool.
    const sequence = ++promptAuditSequence;
    // Await a bounded acknowledgement so a normal turn's capture is durable
    // before its provider call. Failure leaves the previous successful capture
    // untouched; the monotonic sequence fences late writes.
    try {
      await bridgeCall(ctx, "__prompt_audit__", "prompt-audit", { systemPrompt: finalSystemPrompt, sequence }, undefined, 2000);
    } catch (err) {
      // Auditing is best-effort and must never prevent the Pi turn.
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
    { flag: "wx" },
  );
  return file;
}
