// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpImportPreview } from "@agent-deck/contracts";
import { useAppStore } from "../state/store.ts";
import { McpImportPanel } from "./McpImportPanel.tsx";

const preview: McpImportPreview = {
  projectId: null,
  sources: [{ label: "fixture", path: "/home/u/.claude.json", status: "found", scope: "user" }],
  entries: [
    {
      token: "opaque-token",
      name: "existing",
      source: "fixture",
      scope: "user",
      transport: "stdio",
      protectedCount: 1,
      diagnostics: [],
    },
    {
      name: "unsupported",
      source: "fixture",
      scope: "user",
      diagnostics: [
        {
          field: "[mcp_servers.unsupported]",
          reason: "declares both command and url",
          action: "Keep one transport in the source.",
          blocking: true,
        },
      ],
    },
  ],
};
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const discoverBody = (call: unknown[] | undefined): unknown =>
  JSON.parse(String((call?.[1] as RequestInit).body));
const project = {
  id: "project-1",
  name: "Project One",
  path: "/tmp/project-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  assignedMcpServers: [] as string[],
};

beforeEach(() => {
  useAppStore.setState({ projects: [], session: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MCP import approval", () => {
  it("discovers only on request, requires selection and duplicate confirmation, and imports through POST /mcp", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response({ ok: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const imported = vi.fn().mockResolvedValue(undefined);
    render(<McpImportPanel existingNames={["existing"]} onImported={imported} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discover local servers" }));
    const select = await screen.findByRole("checkbox", { name: "Import existing from fixture" });
    expect(fetchMock.mock.calls[0]).toEqual([
      "/mcp/import/discover",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ]);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Import unsupported from fixture",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    const submit = screen.getByRole("button", { name: "Import selected" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(select);
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm replacement/ }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(imported).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[1]).toEqual([
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importToken: "opaque-token", overwrite: true }),
      },
    ]);
    expect(screen.queryByRole("checkbox", { name: "Import existing from fixture" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Imported 1");
  });

  it("blocks same-name selections across sources and exposes safe conflict errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({
            ...preview,
            entries: [
              preview.entries[0],
              { ...preview.entries[0], token: "other", source: "other" },
            ],
          }),
        )
        .mockResolvedValueOnce(response({ error: "must-not-display-secret" }, 409)),
    );
    render(<McpImportPanel existingNames={[]} onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Discover local servers" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Import existing from fixture" }));
    const other = screen.getByRole("checkbox", { name: "Import existing from other" });
    fireEvent.click(other);
    expect(
      (screen.getByRole("button", { name: "Import selected" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("one source");
    fireEvent.click(other);
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("already exists"));
    expect(document.body.textContent).not.toContain("must-not-display-secret");
  });

  it("shows blocking diagnostics, notes, badges, provenance, settings, and source paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        response({
          ...preview,
          sources: [
            ...preview.sources,
            {
              label: "codex",
              path: "/home/u/.codex/config.toml",
              status: "missing",
              scope: "user",
            },
          ],
          entries: [
            preview.entries[1],
            {
              token: "plugin-token",
              name: "context7",
              source: "claude plugins",
              scope: "plugin",
              plugin: "context7@claude-plugins-official",
              transport: "http",
              disabledInSource: true,
              requiresAuth: true,
              settings: {
                startupTimeoutMs: 120_000,
                toolTimeoutMs: 300_000,
                toolApprovals: 2,
                envInterpolation: "claude",
              },
              diagnostics: [
                {
                  field: "oauth",
                  reason: "OAuth settings are not copied.",
                  action: "Sign in after assignment.",
                  blocking: false,
                },
              ],
            },
          ],
        }),
      ),
    );
    render(<McpImportPanel existingNames={[]} onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Discover local servers" }));
    const blocked = await screen.findByTestId("mcp-import-unsupported");
    expect(blocked.textContent).toContain("cannot be imported");
    expect(blocked.textContent).toContain(
      "[mcp_servers.unsupported]: declares both command and url",
    );
    expect(blocked.textContent).toContain("Keep one transport in the source.");
    const plugin = screen.getByTestId("mcp-import-context7");
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Import context7 from claude plugins",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    expect(plugin.textContent).toContain("Plugin context7@claude-plugins-official");
    expect(plugin.textContent).toContain("Disabled in source");
    expect(plugin.textContent).toContain("Sign-in required after assignment");
    expect(plugin.textContent).toContain(
      "startup 120s · tool 300s · 2 tool approval(s) · resolves ${VAR} at launch",
    );
    expect(plugin.textContent).toContain("1 note(s)");
    expect(plugin.textContent).toContain(
      "oauth: OAuth settings are not copied. Sign in after assignment.",
    );
    expect(document.body.textContent).toContain("/home/u/.claude.json");
    expect(document.body.textContent).not.toContain("/home/u/.codex/config.toml");
  });

  it("defaults the scope to the active session project, sends it on discover, and re-discovers on change", async () => {
    useAppStore.setState({
      projects: [project, { ...project, id: "project-2", name: "Project Two" }],
      session: { id: "s", projectId: "project-2" } as NonNullable<
        ReturnType<typeof useAppStore.getState>["session"]
      >,
    });
    const fetchMock = vi.fn().mockResolvedValue(response({ ...preview, entries: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<McpImportPanel existingNames={[]} onImported={vi.fn()} />);
    const scope = screen.getByRole("combobox", { name: "Import scope" }) as HTMLSelectElement;
    expect(scope.value).toBe("project-2");
    fireEvent.change(scope, { target: { value: "" } });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discover local servers" }));
    await screen.findByText("No server entries found.");
    expect(discoverBody(fetchMock.mock.calls[0])).toEqual({});
    fireEvent.change(scope, { target: { value: "project-1" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(discoverBody(fetchMock.mock.calls[1])).toEqual({ projectId: "project-1" });
  });

  it("continues past a failed import and reports both outcomes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          ...preview,
          entries: [
            { ...preview.entries[0], token: "a", name: "alpha" },
            { ...preview.entries[0], token: "b", name: "beta" },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ error: "hidden" }, 500))
      .mockResolvedValueOnce(response({ ok: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const imported = vi.fn().mockResolvedValue(undefined);
    render(<McpImportPanel existingNames={[]} onImported={imported} />);
    fireEvent.click(screen.getByRole("button", { name: "Discover local servers" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Import alpha from fixture" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Import beta from fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => expect(imported).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("Imported 1 server(s): beta.");
    expect(status).toContain("Not imported: alpha (failed, 500)");
    expect(status).not.toContain("hidden");
    expect(screen.getByRole("checkbox", { name: "Import alpha from fixture" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Import beta from fixture" })).toBeNull();
  });
});
