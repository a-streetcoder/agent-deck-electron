// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  mcpDirectTools: ["search", "stale-tool"],
  skills: ["reviewing"],
  mcpServers: ["github"],
  defaultExpectedOutcome: "directProjectWrites",
  defaultProgress: true,
  scope: "builtin",
  filePath: "/bundled/reviewer.md",
  body: "Builtin reviewer prompt.",
  shadowed: false,
  replacesBuiltin: false,
};

beforeEach(() => {
  useAppStore.setState({ currentProjectId: null });
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
        defaultExpectedOutcome: "directProjectWrites",
        defaultProgress: true,
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
        createFromBuiltin={{ ...builtin, defaultProgress: false }}
        onClose={vi.fn()}
      />,
    );
    expect((screen.getByTestId("editor-default-progress") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).edit.defaultProgress).toBe(false);
  });

  it("keeps builtin default progress unmanaged when editing an override", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agents: [builtin] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentEditSheet agent={builtin} onClose={vi.fn()} />);
    expect(screen.queryByTestId("editor-default-progress")).toBeNull();
    fireEvent.click(screen.getByTestId("editor-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]![1].body)).edit.defaultProgress,
    ).toBeUndefined();
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
