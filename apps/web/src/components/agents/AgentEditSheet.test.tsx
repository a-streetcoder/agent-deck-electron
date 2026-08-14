// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInfo } from "@agent-deck/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/store.ts";
import { AgentEditSheet } from "./AgentEditSheet.tsx";

const builtin: AgentInfo = {
  name: "reviewer",
  description: "Review changes",
  whenToUse: "Before risky changes",
  thinking: "high",
  systemPromptMode: "replace",
  tools: ["read", "grep"],
  toolsExplicit: true,
  mcpDirectTools: ["search", "stale-tool"],
  skills: ["reviewing"],
  mcpServers: ["github"],
  defaultReads: ["AGENTS.md", "src/reviewer.ts"],
  defaultExpectedOutcome: "directProjectWrites",
  defaultProgress: true,
  interactive: true,
  maxSubagentDepth: 4,
  output: "Concise review summary",
  scope: "builtin",
  filePath: "/bundled/reviewer.md",
  body: "Builtin reviewer prompt.",
  shadowed: false,
  replacesBuiltin: false,
};

beforeEach(() => {
  useAppStore.setState({ currentProjectId: null, resourcesVersion: 0 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentEditSheet builtin replacement create mode", () => {
  it("seeds effective values from a builtin settings override", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <AgentEditSheet
        agent={null}
        createFromBuiltin={{
          ...builtin,
          overridden: true,
          description: "Effective overridden reviewer",
          whenToUse: undefined,
          tools: ["read"],
          defaultProgress: false,
          interactive: false,
          body: "Effective override prompt.",
        }}
        onClose={vi.fn()}
      />,
    );
    expect((screen.getByTestId("editor-description") as HTMLInputElement).value).toBe(
      "Effective overridden reviewer",
    );
    fireEvent.click(screen.getByTestId("editor-tab-tools"));
    expect((screen.getByTestId("editor-tools") as HTMLInputElement).value).toBe(
      "read, mcp:search, mcp:stale-tool",
    );
    expect(screen.getByText(/do not connect or grant access/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId("editor-tab-config"));
    expect((screen.getByTestId("editor-default-progress") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("editor-interactive") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId("editor-tab-prompt"));
    expect((screen.getByTestId("editor-body") as HTMLTextAreaElement).value).toBe(
      "Effective override prompt.",
    );
  });

  it("is globally scoped, seeded, focused, and cancel writes nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<AgentEditSheet agent={null} createFromBuiltin={builtin} onClose={onClose} />);

    expect(
      screen.getByRole("dialog", { name: "Create global replacement for reviewer" }),
    ).toBeTruthy();
    const nameInput = screen.getByTestId("editor-name") as HTMLInputElement;
    expect(nameInput.value).toBe("reviewer");
    expect(document.activeElement).toBe(nameInput);
    expect((screen.getByTestId("editor-scope") as HTMLInputElement).value).toBe("global");
    expect((screen.getByTestId("editor-description") as HTMLInputElement).value).toBe(
      "Review changes",
    );
    expect((screen.getByTestId("editor-default-reads") as HTMLTextAreaElement).value).toBe(
      "AGENTS.md\nsrc/reviewer.ts",
    );
    expect((screen.getByTestId("editor-default-outcome") as HTMLSelectElement).value).toBe(
      "directProjectWrites",
    );
    expect(screen.getByText(/neither adds nor removes configured tools/i)).toBeTruthy();
    expect(screen.getByText(/caller-selected worktree isolation/i)).toBeTruthy();
    expect(screen.getByText(/validated per-run output path/i)).toBeTruthy();
    expect((screen.getByTestId("editor-default-progress") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/portable metadata only/i)).toBeTruthy();
    expect(
      screen.getByText(/does not change progress reporting or child runtime behavior/i),
    ).toBeTruthy();
    expect((screen.getByTestId("editor-output") as HTMLInputElement).value).toBe(
      "Concise review summary",
    );
    expect(screen.getByText(/does not grant tools, authorize a path/i)).toBeTruthy();
    expect((screen.getByTestId("editor-interactive") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/compatibility metadata only/i)).toBeTruthy();
    expect(
      screen.getByText(/does not enable prompts or change agent runtime behavior/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the existing writer route with create-only builtin provenance and surfaces collision errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "A resource already exists at that catalog location." }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<AgentEditSheet agent={null} createFromBuiltin={builtin} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("editor-save"));
    await screen.findByText(/A resource already exists at that catalog location/);
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resources/agents");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({
      scope: "global",
      name: "reviewer",
      createFromBuiltin: "reviewer",
      edit: {
        description: "Review changes",
        whenToUse: "Before risky changes",
        thinking: "high",
        tools: ["read", "grep", "mcp:search", "mcp:stale-tool"],
        skills: ["reviewing"],
        mcpServers: ["github"],
        defaultReads: ["AGENTS.md", "src/reviewer.ts"],
        defaultExpectedOutcome: "directProjectWrites",
        defaultProgress: true,
        interactive: true,
        output: "Concise review summary",
        body: "Builtin reviewer prompt.",
      },
    });
  });

  it("edits direct adapter names in the native-compatible tools list and announces failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Save refused" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={null} createFromBuiltin={builtin} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("editor-tab-tools"));
    fireEvent.change(screen.getByTestId("editor-tools"), {
      target: { value: "read, mcp:fetch, mcp:legacy-name" },
    });
    fireEvent.click(screen.getByTestId("editor-save"));
    expect((await screen.findByRole("alert")).textContent).toContain("Save refused");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.edit.tools).toEqual(["read", "mcp:fetch", "mcp:legacy-name"]);
    expect(body.edit.mcpDirectTools).toBeUndefined();
  });

  it("keeps an effective false replacement seed false when saved unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AgentEditSheet
        agent={null}
        createFromBuiltin={{ ...builtin, defaultProgress: false, interactive: false }}
        onClose={vi.fn()}
      />,
    );
    expect((screen.getByTestId("editor-default-progress") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("editor-interactive") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const edit = JSON.parse(String(fetchMock.mock.calls[0]![1].body)).edit;
    expect(edit.defaultProgress).toBe(false);
    expect(edit.interactive).toBe(false);
  });

  it("edits and clears output advisory metadata on an existing custom agent", async () => {
    const custom: AgentInfo = {
      ...builtin,
      scope: "global",
      filePath: "/home/.pi/agent/agents/reviewer.md",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agents: [custom] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={custom} onClose={vi.fn()} />);

    const output = screen.getByTestId("editor-output") as HTMLInputElement;
    expect(output.value).toBe("Concise review summary");
    fireEvent.change(output, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).edit.output).toBe("");
  });

  it("edits interactive compatibility metadata on an existing custom agent", async () => {
    const custom: AgentInfo = {
      ...builtin,
      scope: "global",
      filePath: "/home/.pi/agent/agents/reviewer.md",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agents: [custom] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={custom} onClose={vi.fn()} />);

    const checkbox = screen.getByTestId("editor-interactive") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).edit.interactive).toBe(false);
  });

  it("edits and clears maximum subagent depth compatibility metadata", async () => {
    const custom: AgentInfo = {
      ...builtin,
      scope: "global",
      filePath: "/home/.pi/agent/agents/reviewer.md",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agents: [custom] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={custom} onClose={vi.fn()} />);

    const depth = screen.getByTestId("editor-max-subagent-depth") as HTMLInputElement;
    expect(depth.value).toBe("4");
    fireEvent.change(depth, { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).edit.maxSubagentDepth).toBe(0);
  });

  it("keeps builtin boolean metadata unmanaged when editing an override", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agents: [builtin] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={builtin} onClose={vi.fn()} />);
    expect(screen.queryByTestId("editor-default-progress")).toBeNull();
    expect(screen.queryByTestId("editor-interactive")).toBeNull();
    expect(screen.queryByTestId("editor-output")).toBeNull();
    expect(screen.queryByTestId("editor-max-subagent-depth")).toBeNull();
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const edit = JSON.parse(String(fetchMock.mock.calls[1]![1].body)).edit;
    expect(edit.defaultProgress).toBeUndefined();
    expect(edit.interactive).toBeUndefined();
    expect(edit.output).toBeUndefined();
    expect(edit.maxSubagentDepth).toBeUndefined();
  });

  it("saves a selected typed outcome", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={null} createFromBuiltin={builtin} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("editor-default-outcome"), {
      target: { value: "writeProjectFile" },
    });
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).edit.defaultExpectedOutcome).toBe(
      "writeProjectFile",
    );
  });

  it("uses the extension catalog picker while preserving removable stale values and explicit none", async () => {
    const custom: AgentInfo = {
      ...builtin,
      scope: "global",
      filePath: "/home/.pi/agent/agents/reviewer.md",
      extensions: ["/catalog/active.ts", "package:unsupported"],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/resources/extensions") {
        return new Response(
          JSON.stringify({
            loadingMode: "useMyExtensions",
            extensions: [
              {
                path: "/catalog/active.ts",
                name: "active.ts",
                exists: true,
                disabled: false,
                source: "discovered",
                scope: "global",
                bridgeConflict: null,
              },
              {
                path: "/catalog/disabled.ts",
                name: "disabled.ts",
                exists: true,
                disabled: true,
                source: "added",
                scope: "global",
                bridgeConflict: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/resources/agents?") && !init?.method) {
        return new Response(JSON.stringify({ agents: [custom] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={custom} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("editor-tab-extensions"));
    expect(
      await screen.findByText(/not in current catalog; preserved but not loaded/i),
    ).toBeTruthy();
    expect(screen.getByText(/disabled globally; not loaded/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId("editor-extension-0"));
    fireEvent.click(screen.getByTestId("editor-extension-2"));
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => url === "/resources/agents" && init?.method === "PUT",
        ),
      ).toBe(true),
    );
    const saveCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/resources/agents" && init?.method === "PUT",
    )!;
    expect(JSON.parse(String(saveCall[1]!.body)).edit.extensions).toEqual([]);
  });

  it("shows catalog loading without a false empty state and blocks save until settled", async () => {
    const custom: AgentInfo = {
      ...builtin,
      scope: "global",
      filePath: "/home/.pi/agent/agents/reviewer.md",
      extensions: [],
    };
    let resolveCatalog!: (response: Response) => void;
    const catalog = new Promise<Response>((resolve) => {
      resolveCatalog = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === "/resources/extensions") return catalog;
      return Promise.resolve(new Response(JSON.stringify({ agents: [custom] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={custom} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("editor-tab-extensions"));
    expect((await screen.findByRole("status")).textContent).toContain("Loading extension catalog");
    expect(screen.getByTestId("editor-extensions").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText(/No catalog extensions are available/i)).toBeNull();
    expect((screen.getByTestId("editor-save") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveCatalog(
        new Response(JSON.stringify({ loadingMode: "useMyExtensions", extensions: [] }), {
          status: 200,
        }),
      );
      await catalog;
    });
    await waitFor(() =>
      expect(screen.getByTestId("editor-extensions").getAttribute("aria-busy")).toBe("false"),
    );
    expect(screen.getByText(/No catalog extensions are available/i)).toBeTruthy();
    expect((screen.getByTestId("editor-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("refreshes the open extension catalog when resources change", async () => {
    const custom: AgentInfo = {
      ...builtin,
      scope: "global",
      filePath: "/home/.pi/agent/agents/reviewer.md",
      extensions: [],
    };
    let request = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/resources/extensions") {
        request += 1;
        const name = request === 1 ? "first.ts" : "refreshed.ts";
        return Promise.resolve(
          new Response(
            JSON.stringify({
              loadingMode: "useMyExtensions",
              extensions: [
                {
                  path: `/catalog/${name}`,
                  name,
                  exists: true,
                  disabled: false,
                  source: "discovered",
                  scope: "global",
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ agents: [custom] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={custom} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("editor-tab-extensions"));
    expect(await screen.findByText("first.ts")).toBeTruthy();

    act(() => useAppStore.setState({ resourcesVersion: 1 }));
    expect(await screen.findByText("refreshed.ts")).toBeTruthy();
    expect(screen.queryByText("first.ts")).toBeNull();
  });

  it("ignores a stale extension response after the project changes", async () => {
    const custom: AgentInfo = {
      ...builtin,
      scope: "global",
      filePath: "/home/.pi/agent/agents/reviewer.md",
      extensions: [],
    };
    useAppStore.setState({ currentProjectId: "project-a" });
    let resolveA!: (response: Response) => void;
    let resolveB!: (response: Response) => void;
    const responseA = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    const responseB = new Promise<Response>((resolve) => {
      resolveB = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === "/resources/extensions?projectId=project-a") return responseA;
      if (url === "/resources/extensions?projectId=project-b") return responseB;
      return Promise.resolve(new Response(JSON.stringify({ agents: [custom] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={custom} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("editor-tab-extensions"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/resources/extensions?projectId=project-a",
        expect.any(Object),
      ),
    );

    act(() => useAppStore.setState({ currentProjectId: "project-b" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/resources/extensions?projectId=project-b",
        expect.any(Object),
      ),
    );
    await act(async () => {
      resolveB(
        new Response(
          JSON.stringify({
            loadingMode: "useMyExtensions",
            extensions: [
              {
                path: "/project-b/new.ts",
                name: "new.ts",
                exists: true,
                disabled: false,
                source: "discovered",
                scope: "project",
              },
            ],
          }),
          { status: 200 },
        ),
      );
      await responseB;
    });
    expect(await screen.findByText("new.ts")).toBeTruthy();

    await act(async () => {
      resolveA(
        new Response(
          JSON.stringify({
            loadingMode: "useMyExtensions",
            extensions: [
              {
                path: "/project-a/old.ts",
                name: "old.ts",
                exists: true,
                disabled: false,
                source: "discovered",
                scope: "project",
              },
            ],
          }),
          { status: 200 },
        ),
      );
      await responseA;
    });
    expect(screen.queryByText("old.ts")).toBeNull();
    expect(screen.getByText("new.ts")).toBeTruthy();
  });

  it("loads project-aware skill diagnostics, preserves stale names, and ignores stale projects", async () => {
    const custom: AgentInfo = {
      ...builtin,
      scope: "global",
      filePath: "/home/.pi/agent/agents/reviewer.md",
      skills: ["missing", "disabled", "duplicate"],
    };
    useAppStore.setState({ currentProjectId: "project-a" });
    let resolveA!: (response: Response) => void;
    const responseA = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === "/resources/skills/visibility?projectId=project-a") return responseA;
      if (url === "/resources/skills/visibility?projectId=project-b") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              skills: [
                { name: "disabled", scope: "global", disabled: true },
                { name: "duplicate", scope: "global" },
                { name: "duplicate", scope: "project" },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ agents: [custom] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={custom} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("editor-tab-skills"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    act(() => useAppStore.setState({ currentProjectId: "project-b" }));

    expect(await screen.findByText(/stale name is preserved/i)).toBeTruthy();
    expect(screen.getByText(/Disabled in Skills/i)).toBeTruthy();
    expect(screen.getByText(/Ambiguous: 2 visible catalog entries/i)).toBeTruthy();
    expect((screen.getByTestId("editor-skills-input") as HTMLInputElement).value).toBe(
      "missing, disabled, duplicate",
    );

    await act(async () => {
      resolveA(
        new Response(JSON.stringify({ skills: [{ name: "missing", scope: "project" }] }), {
          status: 200,
        }),
      );
      await responseA;
    });
    expect(screen.getByText(/stale name is preserved/i)).toBeTruthy();
  });

  it("keeps the seeded name editable like native custom-agent drafts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    render(<AgentEditSheet agent={null} createFromBuiltin={builtin} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("editor-name"), { target: { value: "reviewer-custom" } });
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body));
    expect(body).toMatchObject({ name: "reviewer-custom", createFromBuiltin: "reviewer" });
  });
});
