import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_UI_TITLE,
  bridgeUiResponse,
  parseBridgeUiRequest,
  sweepStaleBridgeExtensions,
  writeBridgeExtension,
} from "../src/bridge.ts";

/** A bridge dialog value: the app's 200 reply with this body. */
const reply = (body: unknown): string => JSON.stringify({ status: 200, body });

type Tool = {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

/** Load a generated extension against a fake Pi API; returns its tools and handlers. */
function load(file: string) {
  const source = readFileSync(file, "utf8");
  const extension = new Function(
    source.replace("export default function (pi)", "return function (pi)"),
  )() as (pi: unknown) => void;
  const tools: Tool[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  extension({
    registerTool: (tool: Tool) => tools.push(tool),
    appendEntry: vi.fn(),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(event, handler),
  });
  return { tools, handlers };
}

describe("stdio bridge transport", () => {
  const spec = {
    name: "agent_deck_echo",
    label: "Echo",
    description: "Echo",
    parameters: { type: "object", properties: {} },
  };

  it("sends a tool call as a marked input dialog and maps the reply", async () => {
    const file = writeBridgeExtension({ tools: [spec] });
    try {
      const { tools, handlers } = load(file);
      const input = vi.fn(async (_title: string, _placeholder: string) =>
        reply({ content: "pong" }),
      );
      const result = await tools[0]!.execute("call-1", { message: "ping" }, undefined, undefined, {
        ui: { input },
      });
      expect(result.content[0]!.text).toBe("pong");
      expect(input.mock.calls[0]![0]).toBe(BRIDGE_UI_TITLE);
      expect(JSON.parse(input.mock.calls[0]![1])).toEqual({
        tool: "agent_deck_echo",
        toolCallId: "call-1",
        params: { message: "ping" },
      });

      // A refusal and a missing answer are tool errors, not throws.
      input.mockResolvedValueOnce(JSON.stringify({ status: 403, body: { error: "no" } }));
      const refused = await tools[0]!.execute("call-2", {}, undefined, undefined, {
        ui: { input },
      });
      expect(refused.content[0]!.text).toBe('bridge error 403: {"error":"no"}');
      expect(handlers.get("tool_result")!({ toolCallId: "call-2" }, {})).toEqual({ isError: true });
      input.mockResolvedValueOnce(undefined as unknown as string);
      const silent = await tools[0]!.execute("call-3", {}, undefined, undefined, { ui: { input } });
      expect(silent.content[0]!.text).toContain("bridge unreachable");
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it("reads only marked input dialogs as bridge calls", () => {
    const request = {
      type: "extension_ui_request",
      id: "ui-1",
      method: "input",
      title: BRIDGE_UI_TITLE,
      placeholder: JSON.stringify({ tool: "t", toolCallId: "c", params: { a: 1 } }),
      timeout: 2000,
    };
    expect(parseBridgeUiRequest(request)).toEqual({
      id: "ui-1",
      call: { tool: "t", toolCallId: "c", params: { a: 1 } },
      timeoutMs: 2000,
    });
    expect(parseBridgeUiRequest({ ...request, placeholder: "not json" })).toEqual({
      id: "ui-1",
      call: undefined,
      timeoutMs: 2000,
    });
    // A genuine dialog, another method, or another event is not a bridge call.
    expect(parseBridgeUiRequest({ ...request, title: "Enter a value" })).toBeUndefined();
    expect(parseBridgeUiRequest({ ...request, method: "editor" })).toBeUndefined();
    expect(parseBridgeUiRequest({ type: "agent_end" })).toBeUndefined();
    expect(bridgeUiResponse("ui-1", { status: 200, body: { ok: 1 } })).toEqual({
      type: "extension_ui_response",
      id: "ui-1",
      value: '{"status":200,"body":{"ok":1}}',
    });
  });

  it("writes the extension inside the given folder", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-dir-"));
    try {
      const file = writeBridgeExtension({ dir: join(root, "sandbox", "s-1"), tools: [] });
      expect(dirname(dirname(file))).toBe(join(root, "sandbox", "s-1"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("generated recall bridge", () => {
  it("persists only versioned recalled source metadata after a nonempty recall", () => {
    const file = writeBridgeExtension({
      tools: [],
      recall: true,
    });
    try {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("pendingRecall = { version: 1, memories: recalled };");
      expect(source).toContain("recalledRaw.length <= 5");
      expect(source).toContain('pi.appendEntry("agent-deck.memory-recall", recall);');
      expect(source).toContain("if (block)");
      expect(source).toContain("if (recalled.length > 0)");
      expect(source).toContain(
        'if (!event.message || event.message.role !== "assistant" || !pendingRecall) return;',
      );
      const append = source.match(/pi\.appendEntry\([^;]+;/)?.[0] ?? "";
      expect(append).not.toMatch(/query|body|path|projectId/);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it("preserves a nonempty prompt block but skips the entry for malformed metadata", async () => {
    const file = writeBridgeExtension({
      tools: [],
      recall: true,
    });
    try {
      const source = readFileSync(file, "utf8");
      const extension = new Function(
        source.replace("export default function (pi)", "return function (pi)"),
      )() as (pi: {
        registerTool(): void;
        appendEntry: ReturnType<typeof vi.fn>;
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
      }) => void;
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const appendEntry = vi.fn();
      extension({
        registerTool: vi.fn(),
        appendEntry,
        on: (event, handler) => handlers.set(event, handler),
      });
      const input = vi.fn(async () =>
        reply({
          content: "recall-block",
          recalled: [
            { id: "decision-a", title: "Decision A", type: "decision", body: "forbidden" },
          ],
        }),
      );

      const result = (await handlers.get("before_agent_start")!(
        { messageType: "user", prompt: "question", systemPrompt: "base" },
        { getSystemPrompt: () => "base", ui: { input } },
      )) as { systemPrompt: string };

      expect(result.systemPrompt).toBe("base\n\nrecall-block");
      expect(result.systemPrompt.split("recall-block")).toHaveLength(2);
      await handlers.get("message_start")!({ message: { role: "assistant" } }, {});
      expect(appendEntry).not.toHaveBeenCalled();
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it("appends valid pending evidence once before the first assistant entry and clears stale data", async () => {
    const file = writeBridgeExtension({
      tools: [],
      recall: true,
    });
    try {
      const source = readFileSync(file, "utf8");
      const extension = new Function(
        source.replace("export default function (pi)", "return function (pi)"),
      )() as (pi: {
        registerTool(): void;
        appendEntry: ReturnType<typeof vi.fn>;
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
      }) => void;
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const appendEntry = vi.fn();
      extension({
        registerTool: vi.fn(),
        appendEntry,
        on: (event, handler) => handlers.set(event, handler),
      });
      const input = vi.fn(
        async (): Promise<string | undefined> =>
          reply({
            content: "recall-block",
            recalled: [{ id: "decision-a", title: "Decision A", type: "decision" }],
          }),
      );

      const result = (await handlers.get("before_agent_start")!(
        { messageType: "user", prompt: "question", systemPrompt: "base" },
        { getSystemPrompt: () => "base", ui: { input } },
      )) as { systemPrompt: string };
      expect(result.systemPrompt).toBe("base\n\nrecall-block");
      expect(result.systemPrompt.split("recall-block")).toHaveLength(2);
      expect(appendEntry).not.toHaveBeenCalled();

      await handlers.get("message_start")!({ message: { role: "user" } }, {});
      expect(appendEntry).not.toHaveBeenCalled();
      await handlers.get("message_start")!({ message: { role: "assistant" } }, {});
      await handlers.get("message_start")!({ message: { role: "assistant" } }, {});
      expect(appendEntry).toHaveBeenCalledTimes(1);
      expect(appendEntry).toHaveBeenCalledWith("agent-deck.memory-recall", {
        version: 1,
        memories: [{ id: "decision-a", title: "Decision A", type: "decision" }],
      });

      // A later before_agent_start clears any unconsumed prior payload before
      // asking. If that call fails, a later turn cannot append stale data.
      await handlers.get("before_agent_start")!(
        { messageType: "user", prompt: "queued", systemPrompt: "base" },
        { getSystemPrompt: () => "base", ui: { input } },
      );
      input.mockResolvedValueOnce(undefined); // no answer: the app went away
      await handlers.get("before_agent_start")!(
        { messageType: "user", prompt: "replacement", systemPrompt: "base" },
        { getSystemPrompt: () => "base", ui: { input } },
      );
      await handlers.get("message_start")!({ message: { role: "assistant" } }, {});
      expect(appendEntry).toHaveBeenCalledTimes(1);

      // Pi 1.x custom-message runs carry no prompt: no recall call, prompt unchanged.
      const inputCalls = input.mock.calls.length;
      expect(
        await handlers.get("before_agent_start")!(
          { messageType: "custom", message: {}, systemPrompt: "base" },
          { getSystemPrompt: () => "base", ui: { input } },
        ),
      ).toBeUndefined();
      expect(input).toHaveBeenCalledTimes(inputCalls);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });
});

describe("native MCP transports", () => {
  it("resolves pi-mcp beside the Pi that AGENT_DECK_PI_CLI points at (bundled layout)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-runtime-")));
    const scope = join(root, "node_modules", "@earendil-works");
    const cli = join(scope, "pi-coding-agent", "dist", "cli.js");
    const mcp = join(scope, "pi-mcp", "dist", "index.js");
    for (const file of [cli, mcp]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
    vi.stubEnv("AGENT_DECK_PI_CLI", cli);
    let file: string | undefined;
    try {
      file = writeBridgeExtension({
        tools: [],
        nativeMcp: { servers: [] },
      });
      expect(readFileSync(file, "utf8")).toContain(JSON.stringify(pathToFileURL(mcp).href));
    } finally {
      vi.unstubAllEnvs();
      if (file) rmSync(dirname(file), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stale bridge sweep", () => {
  it("removes generated folders older than the limit and keeps fresh ones", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-sweep-"));
    const stale = dirname(writeBridgeExtension({ dir: root, tools: [] }));
    const fresh = dirname(writeBridgeExtension({ dir: root, tools: [] }));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    try {
      expect(sweepStaleBridgeExtensions(undefined, root)).toBe(1);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(stale, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
