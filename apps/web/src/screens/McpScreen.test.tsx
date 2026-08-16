// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { McpScreen } from "./McpScreen.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({
    resourcesVersion: 0,
    error: null,
    toasts: [],
    projects: [],
    projectsLoaded: true,
    currentProjectId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MCP configuration reload", () => {
  it("explicitly reloads disk configuration and replaces the visible catalog", async () => {
    let reloaded = false;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/mcp/reload" && init?.method === "POST") {
        reloaded = true;
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (String(input) === "/mcp") {
        return Promise.resolve(
          jsonResponse({
            servers: [
              {
                id: reloaded ? "after-edit" : "before-edit",
                transport: "stdio",
                connected: false,
                toolNames: [],
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    render(<McpScreen />);
    expect(await screen.findByTestId("mcp-before-edit")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mcp-reload"));

    await waitFor(() => expect(screen.queryByTestId("mcp-before-edit")).toBeNull());
    expect(screen.getByTestId("mcp-after-edit")).toBeTruthy();
  });

  it("shows an actionable malformed-config error and clears it after a repaired reload", async () => {
    let attempts = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/mcp/reload" && init?.method === "POST") {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? jsonResponse(
                {
                  error: "MCP configuration is not valid JSON; current connections were preserved.",
                },
                422,
              )
            : jsonResponse({ ok: true }),
        );
      }
      if (String(input) === "/mcp") {
        return Promise.resolve(jsonResponse({ servers: [] }));
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");

    fireEvent.click(screen.getByTestId("mcp-reload"));
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe(
        "MCP configuration is not valid JSON; current connections were preserved.",
      ),
    );

    fireEvent.click(screen.getByTestId("mcp-reload"));
    await waitFor(() => expect(useAppStore.getState().error).toBeNull());
  });

  it("does not report reload success when the refreshed catalog cannot be loaded", async () => {
    let catalogLoads = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/mcp/reload" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (String(input) === "/mcp") {
        catalogLoads += 1;
        return Promise.resolve(
          catalogLoads === 1
            ? jsonResponse({ servers: [] })
            : new Response("catalog unavailable", { status: 503 }),
        );
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-reload"));

    await waitFor(() => expect(useAppStore.getState().error).toContain("catalog unavailable"));
    expect(useAppStore.getState().toasts).toEqual([]);
  });

  it("waits for a broadcast-superseding catalog load before reporting success", async () => {
    let catalogLoads = 0;
    let resolveExplicit!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/mcp/reload" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (String(input) === "/mcp") {
        catalogLoads += 1;
        if (catalogLoads === 2) {
          return new Promise<Response>((resolve) => {
            resolveExplicit = resolve;
          });
        }
        return Promise.resolve(jsonResponse({ servers: [] }));
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-reload"));
    await waitFor(() => expect(catalogLoads).toBe(2));

    // Simulate the resources_changed broadcast launching a newer catalog load
    // while the button's explicit load is still pending.
    useAppStore.setState({ resourcesVersion: 1 });
    await waitFor(() => expect(catalogLoads).toBe(3));
    expect(useAppStore.getState().toasts).toEqual([]);
    resolveExplicit(jsonResponse({ servers: [] }));

    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)?.message).toBe("Reloaded MCP configuration"),
    );
  });
});

describe("project MCP assignments", () => {
  it("shows trust/source state and persists an assignment from an accessible checkbox", async () => {
    useAppStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          name: "A very long project name used to verify overflow behavior",
          path: "/tmp/project-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedMcpServers: [],
        },
      ],
    });
    let assigned = false;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp?projectId=project-1")
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: assigned ? ["repository-server-with-a-very-long-name"] : [],
            missingAssignedServerIds: [],
            servers: [
              {
                id: "repository-server-with-a-very-long-name",
                transport: "stdio",
                source: "project",
                editable: false,
                connected: assigned,
                toolNames: assigned ? ["mcp__repository_server__echo"] : [],
              },
            ],
          }),
        );
      if (url === "/projects/project-1" && init?.method === "PATCH") {
        assigned = true;
        expect(JSON.parse(String(init.body))).toEqual({
          assignedMcpServers: ["repository-server-with-a-very-long-name"],
        });
        return Promise.resolve(jsonResponse({ project: {} }));
      }
      if (url === "/projects")
        return Promise.resolve(
          jsonResponse({
            projects: [
              {
                id: "project-1",
                name: "A very long project name used to verify overflow behavior",
                path: "/tmp/project-1",
                createdAt: "2026-01-01T00:00:00.000Z",
                assignedMcpServers: assigned ? ["repository-server-with-a-very-long-name"] : [],
              },
            ],
          }),
        );
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    const checkbox = await screen.findByRole("checkbox", {
      name: /assign repository-server-with-a-very-long-name/i,
    });
    expect(screen.getByTestId("mcp-trust-copy").textContent).toContain(
      "repository-controlled commands",
    );
    expect(screen.getByText("project config · read only")).toBeTruthy();
    expect(screen.queryByTestId("mcp-remove-repository-server-with-a-very-long-name")).toBeNull();
    fireEvent.click(checkbox);
    await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(true));
  });

  it("renders a keyboard-removable missing assignment and project empty state", async () => {
    useAppStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          name: "Project",
          path: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedMcpServers: ["missing-server"],
        },
      ],
    });
    let missing = true;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp?projectId=project-1")
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: missing ? ["missing-server"] : [],
            missingAssignedServerIds: missing ? ["missing-server"] : [],
            servers: [],
          }),
        );
      if (url === "/projects/project-1" && init?.method === "PATCH") {
        missing = false;
        return Promise.resolve(jsonResponse({ project: {} }));
      }
      if (url === "/projects")
        return Promise.resolve(
          jsonResponse({
            projects: [
              {
                id: "project-1",
                name: "Project",
                path: "/tmp/project",
                createdAt: "2026-01-01T00:00:00.000Z",
                assignedMcpServers: [],
              },
            ],
          }),
        );
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    expect(await screen.findByTestId("mcp-missing-missing-server")).toBeTruthy();
    const remove = screen.getByRole("checkbox", { name: /remove missing MCP assignment/i });
    remove.focus();
    fireEvent.click(remove);
    await screen.findByTestId("mcp-empty");
    expect(screen.getByTestId("mcp-empty").textContent).toContain("No configured MCP servers");
  });
});

describe("project MCP assignment saving state", () => {
  const project = {
    id: "project-save",
    name: "Save project",
    path: "/tmp/save-project",
    createdAt: "2026-01-01T00:00:00.000Z",
    assignedMcpServers: [] as string[],
  };

  it("is optimistic, id-locked/aria-busy while saving, and preserves focus", async () => {
    useAppStore.setState({ currentProjectId: project.id, projects: [project] });
    let resolvePatch!: () => void;
    let patchCount = 0;
    let catalogLoads = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/mcp?projectId=${project.id}`) {
        catalogLoads += 1;
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: patchCount ? ["server"] : [],
            missingAssignedServerIds: [],
            servers: [{ id: "server", transport: "stdio", connected: false, toolNames: [] }],
          }),
        );
      }
      if (url === `/projects/${project.id}` && init?.method === "PATCH") {
        patchCount += 1;
        return new Promise<Response>((resolve) => {
          resolvePatch = () => resolve(jsonResponse({ project: {} }));
        });
      }
      if (url === "/projects")
        return Promise.resolve(
          jsonResponse({ projects: [{ ...project, assignedMcpServers: ["server"] }] }),
        );
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    const checkbox = await screen.findByTestId("mcp-assign-server");
    checkbox.focus();
    expect(screen.getByTestId("mcp-status-server").textContent).toBe("available");
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("mcp-server").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Saving…")).toBeTruthy();
    fireEvent.click(checkbox);
    expect(patchCount).toBe(1);
    expect(screen.getByTestId("mcp-server")).toBeTruthy();

    resolvePatch();
    await waitFor(() => expect((checkbox as HTMLInputElement).disabled).toBe(false));
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Assigned")).toBeTruthy();
    expect(screen.getByTestId("mcp-status-server").textContent).toBe("disconnected");

    const beforeBroadcastLoads = catalogLoads;
    useAppStore.setState({ resourcesVersion: 1 });
    await waitFor(() => expect(catalogLoads).toBeGreaterThan(beforeBroadcastLoads));
    expect(screen.getByTestId("mcp-assign-server")).toBe(checkbox);
    expect(document.activeElement).toBe(checkbox);
  });

  it("serializes different server assignments without losing the first", async () => {
    useAppStore.setState({ currentProjectId: project.id, projects: [project] });
    let assigned: string[] = [];
    let releaseFirst!: () => void;
    const patchBodies: string[][] = [];
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/mcp?projectId=${project.id}`)
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: assigned,
            missingAssignedServerIds: [],
            servers: ["one", "two"].map((id) => ({
              id,
              transport: "stdio",
              connected: false,
              toolNames: [],
            })),
          }),
        );
      if (url === `/projects/${project.id}` && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { assignedMcpServers: string[] };
        patchBodies.push(body.assignedMcpServers);
        if (patchBodies.length === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirst = () => {
              assigned = body.assignedMcpServers;
              resolve(jsonResponse({ project: {} }));
            };
          });
        }
        assigned = body.assignedMcpServers;
        return Promise.resolve(jsonResponse({ project: {} }));
      }
      if (url === "/projects")
        return Promise.resolve(
          jsonResponse({ projects: [{ ...project, assignedMcpServers: assigned }] }),
        );
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    const one = await screen.findByTestId("mcp-assign-one");
    const two = screen.getByTestId("mcp-assign-two");
    fireEvent.click(one);
    expect((two as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(two);
    expect(patchBodies).toEqual([["one"]]);

    releaseFirst();
    await waitFor(() => expect((two as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(two);
    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toEqual(["one", "two"]);
    await waitFor(() => expect((two as HTMLInputElement).disabled).toBe(false));
    expect((one as HTMLInputElement).checked).toBe(true);
    expect((two as HTMLInputElement).checked).toBe(true);
  });

  it("reconciles a failed save, rolls back, and surfaces the server error", async () => {
    useAppStore.setState({ currentProjectId: project.id, projects: [project] });
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/mcp?projectId=${project.id}`)
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: [],
            missingAssignedServerIds: [],
            servers: [{ id: "server", transport: "stdio", connected: false, toolNames: [] }],
          }),
        );
      if (url === `/projects/${project.id}` && init?.method === "PATCH")
        return Promise.resolve(jsonResponse({ error: "Assignment refused" }, 409));
      if (url === "/projects") return Promise.resolve(jsonResponse({ projects: [project] }));
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    const checkbox = await screen.findByTestId("mcp-assign-server");
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(false));
    expect(useAppStore.getState().error).toContain("Assignment refused");
    expect(screen.getByTestId("mcp-server")).toBeTruthy();
  });

  it("shows loading and no-project catalog semantics without assignment controls", async () => {
    let resolveCatalog!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    render(<McpScreen />);
    expect(screen.getByTestId("mcp-loading")).toBeTruthy();
    expect(screen.getByTestId("mcp-list").getAttribute("aria-busy")).toBe("true");
    resolveCatalog(
      jsonResponse({
        servers: [{ id: "global", transport: "stdio", connected: false, toolNames: [] }],
      }),
    );
    expect(await screen.findByTestId("mcp-global")).toBeTruthy();
    expect(screen.queryByTestId("mcp-assign-global")).toBeNull();
    expect(screen.getByTestId("mcp-status-global").textContent).toBe("disconnected");
  });
});

describe("MCP add form", () => {
  function mockCatalog(servers: Array<Partial<Record<string, unknown>>> = []) {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }, 201));
      }
      if (url === "/mcp") {
        return Promise.resolve(
          jsonResponse({
            servers: servers.map((server) => ({
              id: "existing",
              transport: "stdio",
              connected: false,
              toolNames: [],
              ...server,
            })),
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
  }

  it("posts a stdio server as { name, command, args }", async () => {
    mockCatalog();
    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.change(screen.getByTestId("mcp-name"), { target: { value: "filesystem" } });
    fireEvent.change(screen.getByTestId("mcp-command"), {
      target: { value: "npx" },
    });
    fireEvent.change(screen.getByTestId("mcp-args"), {
      target: { value: "-y @modelcontextprotocol/server-filesystem /tmp" },
    });
    fireEvent.click(screen.getByTestId("mcp-add-confirm"));

    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([input, init]) => {
        return String(input) === "/mcp" && init?.method === "POST";
      });
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]?.body))).toEqual({
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      });
    });
  });

  it("posts a remote HTTP server as { name, url }", async () => {
    mockCatalog();
    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.click(screen.getByRole("radio", { name: "Remote (HTTP)" }));
    fireEvent.change(screen.getByTestId("mcp-name"), { target: { value: "remote" } });
    fireEvent.change(screen.getByTestId("mcp-url"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    fireEvent.click(screen.getByTestId("mcp-add-confirm"));

    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([input, init]) => {
        return String(input) === "/mcp" && init?.method === "POST";
      });
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]?.body))).toEqual({
        name: "remote",
        url: "https://mcp.example.com/mcp",
      });
    });
  });

  it("does not POST an invalid HTTP URL", async () => {
    mockCatalog();
    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.click(screen.getByRole("radio", { name: "Remote (HTTP)" }));
    fireEvent.change(screen.getByTestId("mcp-name"), { target: { value: "remote" } });
    fireEvent.change(screen.getByTestId("mcp-url"), { target: { value: "not-a-url" } });
    expect((screen.getByTestId("mcp-add-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("mcp-add-hint").textContent).toContain("http:// or https://");
    fireEvent.click(screen.getByTestId("mcp-add-confirm"));
    fireEvent.submit(screen.getByTestId("mcp-add-form"));
    expect(
      vi.mocked(fetch).mock.calls.some(([input, init]) => {
        return String(input) === "/mcp" && init?.method === "POST";
      }),
    ).toBe(false);
  });

  it("names add-form fields and submits from the name field", async () => {
    mockCatalog();
    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-add"));
    expect(screen.getByLabelText("Name")).toBe(screen.getByTestId("mcp-name"));
    expect(screen.getByLabelText("Command")).toBe(screen.getByTestId("mcp-command"));
    fireEvent.click(screen.getByRole("radio", { name: "Remote (HTTP)" }));
    expect(screen.getByLabelText("URL")).toBe(screen.getByTestId("mcp-url"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "remote" } });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    fireEvent.submit(screen.getByTestId("mcp-add-form"));
    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([input, init]) => {
          return String(input) === "/mcp" && init?.method === "POST";
        }),
      ).toBe(true);
    });
  });

  it("swaps command and URL fields when the transport type changes", async () => {
    mockCatalog();
    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.change(screen.getByTestId("mcp-name"), { target: { value: "draft" } });
    fireEvent.change(screen.getByTestId("mcp-command"), { target: { value: "npx" } });
    fireEvent.change(screen.getByTestId("mcp-args"), { target: { value: "echo" } });
    fireEvent.click(screen.getByRole("radio", { name: "Remote (HTTP)" }));
    expect(screen.queryByTestId("mcp-command")).toBeNull();
    expect(screen.getByTestId("mcp-url")).toBeTruthy();
    fireEvent.change(screen.getByTestId("mcp-url"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Local (stdio)" }));
    expect(screen.queryByTestId("mcp-url")).toBeNull();
    expect((screen.getByTestId("mcp-command") as HTMLInputElement).value).toBe("npx");
    expect((screen.getByTestId("mcp-args") as HTMLInputElement).value).toBe("echo");
    fireEvent.click(screen.getByRole("radio", { name: "Remote (HTTP)" }));
    expect((screen.getByTestId("mcp-url") as HTMLInputElement).value).toBe(
      "https://mcp.example.com/mcp",
    );
    expect((screen.getByTestId("mcp-name") as HTMLInputElement).value).toBe("draft");
  });

  it("disables Add when the name matches an existing server id", async () => {
    mockCatalog([{ id: "filesystem" }]);
    render(<McpScreen />);
    await screen.findByTestId("mcp-filesystem");
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.change(screen.getByTestId("mcp-name"), { target: { value: "filesystem" } });
    fireEvent.change(screen.getByTestId("mcp-command"), { target: { value: "npx" } });
    fireEvent.change(screen.getByTestId("mcp-args"), { target: { value: "echo" } });
    expect((screen.getByTestId("mcp-add-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Remote (HTTP)" }));
    fireEvent.change(screen.getByTestId("mcp-url"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    expect((screen.getByTestId("mcp-add-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("mcp-add-hint").textContent).toContain("already exists");
    expect(
      vi.mocked(fetch).mock.calls.some(([input, init]) => {
        return String(input) === "/mcp" && init?.method === "POST";
      }),
    ).toBe(false);
  });

  it("keeps the form open and surfaces an actionable add error", async () => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: "invalid MCP server name: remote" }, 400));
      }
      if (url === "/mcp") return Promise.resolve(jsonResponse({ servers: [] }));
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.click(screen.getByRole("radio", { name: "Remote (HTTP)" }));
    fireEvent.change(screen.getByTestId("mcp-name"), { target: { value: "remote" } });
    fireEvent.change(screen.getByTestId("mcp-url"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    fireEvent.click(screen.getByTestId("mcp-add-confirm"));

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("invalid MCP server name: remote"),
    );
    expect(screen.getByTestId("mcp-add-form")).toBeTruthy();
    expect((screen.getByTestId("mcp-name") as HTMLInputElement).value).toBe("remote");
    expect((screen.getByTestId("mcp-url") as HTMLInputElement).value).toBe(
      "https://mcp.example.com/mcp",
    );
  });
});

describe("MCP edit form", () => {
  function mockCatalog(
    servers: Array<Partial<Record<string, unknown>>> = [{ id: "remote" }],
    options: { patchError?: string } = {},
  ) {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith("/mcp/") && init?.method === "PATCH") {
        return options.patchError
          ? Promise.resolve(jsonResponse({ error: options.patchError }, 400))
          : Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === "/mcp") {
        return Promise.resolve(
          jsonResponse({
            servers: servers.map((server) => ({
              id: "remote",
              transport: "http",
              connected: false,
              toolNames: [],
              editable: true,
              url: "https://mcp.example.com/old",
              ...server,
            })),
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
  }

  it("shows Edit only for editable global rows", async () => {
    mockCatalog([
      { id: "remote", editable: true },
      { id: "projectdb", transport: "stdio", editable: false, source: "project" },
    ]);
    render(<McpScreen />);
    await screen.findByTestId("mcp-remote");
    const edit = screen.getByTestId("mcp-edit-remote");
    expect(edit).toBeTruthy();
    expect(screen.queryByTestId("mcp-edit-projectdb")).toBeNull();
    fireEvent.click(edit);
    expect(edit.getAttribute("aria-expanded")).toBe("true");
    expect(edit.getAttribute("aria-label")).toBe("Close MCP editor for remote");
    fireEvent.click(edit);
    expect(screen.queryByTestId("mcp-edit-form")).toBeNull();
    expect(edit.getAttribute("aria-expanded")).toBe("false");
    expect(edit.getAttribute("aria-label")).toBe("Edit global MCP definition remote");
  });

  it("seeds the locked name and existing URL, then PATCHes only the URL", async () => {
    mockCatalog();
    render(<McpScreen />);
    await screen.findByTestId("mcp-remote");
    fireEvent.click(screen.getByTestId("mcp-edit-remote"));
    expect(screen.getByTestId("mcp-edit-form")).toBeTruthy();
    expect((screen.getByTestId("mcp-name") as HTMLInputElement).value).toBe("remote");
    expect((screen.getByTestId("mcp-name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("mcp-url") as HTMLInputElement).value).toBe(
      "https://mcp.example.com/old",
    );
    fireEvent.change(screen.getByTestId("mcp-url"), {
      target: { value: "https://mcp.example.com/new" },
    });
    fireEvent.submit(screen.getByTestId("mcp-edit-form"));
    await waitFor(() => {
      const patch = vi.mocked(fetch).mock.calls.find(([input, init]) => {
        return String(input) === "/mcp/remote" && init?.method === "PATCH";
      });
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch![1]?.body))).toEqual({
        url: "https://mcp.example.com/new",
      });
    });
  });

  it("seeds a stdio command line and PATCHes command/args", async () => {
    mockCatalog([
      {
        id: "files",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server-fs"],
        url: undefined,
      },
    ]);
    render(<McpScreen />);
    await screen.findByTestId("mcp-files");
    fireEvent.click(screen.getByTestId("mcp-edit-files"));
    expect((screen.getByTestId("mcp-command") as HTMLInputElement).value).toBe("npx");
    expect((screen.getByTestId("mcp-args") as HTMLInputElement).value).toBe("-y server-fs");
    fireEvent.change(screen.getByTestId("mcp-command"), {
      target: { value: "uvx" },
    });
    fireEvent.change(screen.getByTestId("mcp-args"), {
      target: { value: 'server-fs "/tmp/hello world"' },
    });
    fireEvent.submit(screen.getByTestId("mcp-edit-form"));
    await waitFor(() => {
      const patch = vi.mocked(fetch).mock.calls.find(([input, init]) => {
        return String(input) === "/mcp/files" && init?.method === "PATCH";
      });
      expect(JSON.parse(String(patch![1]?.body))).toEqual({
        command: "uvx",
        args: ["server-fs", "/tmp/hello world"],
      });
    });
  });

  it("round-trips literal quotes, empty args, and spaced args", async () => {
    mockCatalog([
      {
        id: "quoted",
        transport: "stdio",
        command: "runner",
        args: ['"foo"', "", "hello world", "line\tbreak"],
        url: undefined,
      },
    ]);
    render(<McpScreen />);
    await screen.findByTestId("mcp-quoted");
    fireEvent.click(screen.getByTestId("mcp-edit-quoted"));
    fireEvent.submit(screen.getByTestId("mcp-edit-form"));
    await waitFor(() => {
      const patch = vi.mocked(fetch).mock.calls.find(([input, init]) => {
        return String(input) === "/mcp/quoted" && init?.method === "PATCH";
      });
      expect(JSON.parse(String(patch![1]?.body))).toEqual({
        command: "runner",
        args: ['"foo"', "", "hello world", "line\tbreak"],
      });
    });
  });

  it("does not PATCH an invalid URL and restores the snapshot on Escape", async () => {
    mockCatalog();
    render(<McpScreen />);
    await screen.findByTestId("mcp-remote");
    fireEvent.click(screen.getByTestId("mcp-edit-remote"));
    fireEvent.change(screen.getByTestId("mcp-url"), { target: { value: "not-a-url" } });
    expect((screen.getByTestId("mcp-edit-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByTestId("mcp-edit-form"));
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.change(screen.getByTestId("mcp-url"), {
      target: { value: "https://mcp.example.com/draft" },
    });
    fireEvent.keyDown(screen.getByTestId("mcp-edit-form"), { key: "Escape" });
    expect(screen.queryByTestId("mcp-edit-form")).toBeNull();
    fireEvent.click(screen.getByTestId("mcp-edit-remote"));
    expect((screen.getByTestId("mcp-url") as HTMLInputElement).value).toBe(
      "https://mcp.example.com/old",
    );
  });

  it("locks add and other edit actions while a save is in flight", async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp/remote" && init?.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          resolvePatch = resolve;
        });
      }
      if (url === "/mcp") {
        return Promise.resolve(
          jsonResponse({
            servers: [
              {
                id: "remote",
                transport: "http",
                connected: false,
                toolNames: [],
                editable: true,
                url: "https://mcp.example.com/old",
              },
              {
                id: "files",
                transport: "stdio",
                connected: false,
                toolNames: [],
                editable: true,
                command: "npx",
                args: ["echo"],
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
    render(<McpScreen />);
    await screen.findByTestId("mcp-remote");
    fireEvent.click(screen.getByTestId("mcp-edit-remote"));
    fireEvent.change(screen.getByTestId("mcp-url"), {
      target: { value: "https://mcp.example.com/new" },
    });
    fireEvent.submit(screen.getByTestId("mcp-edit-form"));
    await waitFor(() => expect(resolvePatch).toBeTruthy());
    expect((screen.getByTestId("mcp-add") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("mcp-edit-files") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("mcp-edit-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.click(screen.getByTestId("mcp-edit-files"));
    expect(screen.getByTestId("mcp-edit-form")).toBeTruthy();
    expect((screen.getByTestId("mcp-url") as HTMLInputElement).value).toBe(
      "https://mcp.example.com/new",
    );
    resolvePatch?.(jsonResponse({ ok: true }));
    await waitFor(() => expect(screen.queryByTestId("mcp-edit-form")).toBeNull());
  });

  it("keeps the edit form open after a save error", async () => {
    mockCatalog([{ id: "remote" }], { patchError: "http server needs a valid http(s) url" });
    render(<McpScreen />);
    await screen.findByTestId("mcp-remote");
    fireEvent.click(screen.getByTestId("mcp-edit-remote"));
    fireEvent.change(screen.getByTestId("mcp-url"), {
      target: { value: "https://mcp.example.com/new" },
    });
    fireEvent.submit(screen.getByTestId("mcp-edit-form"));
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("http server needs a valid http(s) url"),
    );
    expect(screen.getByTestId("mcp-edit-form")).toBeTruthy();
    expect((screen.getByTestId("mcp-url") as HTMLInputElement).value).toBe(
      "https://mcp.example.com/new",
    );
  });
});
