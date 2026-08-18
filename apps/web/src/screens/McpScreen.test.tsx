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

describe("MCP master policy", () => {
  it("reports unknown initial policy as loading rather than falsely on", async () => {
    let resolveCatalog!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    render(<McpScreen />);
    const toggle = screen.getByRole("switch", { name: "MCP runtime availability" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.getByTestId("mcp-policy-status").textContent).toBe("Loading MCP availability…");
    resolveCatalog(jsonResponse({ mcpEnabled: true, servers: [] }));
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
  });

  it("exposes an accessible non-optimistic switch and renders paused rows without disabling management", async () => {
    let enabled = true;
    let resolveToggle!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp")
        return Promise.resolve(
          jsonResponse({
            mcpEnabled: enabled,
            servers: [
              {
                id: "server",
                transport: "http",
                connected: enabled,
                toolNames: enabled ? ["mcp__server__echo"] : [],
                editable: true,
                auth: { status: "unauthenticated" },
              },
            ],
          }),
        );
      if (url === "/mcp/policy" && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
        return new Promise<Response>((resolve) => {
          resolveToggle = (response) => {
            enabled = false;
            resolve(response);
          };
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    const toggle = await screen.findByRole("switch", { name: "MCP runtime availability" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    toggle.focus();
    fireEvent.click(toggle);
    // Capability truth does not change optimistically while persistence is pending.
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Saving MCP availability…")).toBeTruthy();
    resolveToggle(jsonResponse({ mcpEnabled: false }));

    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    expect(screen.getByTestId("mcp-status-server").textContent).toBe("paused");
    expect((screen.getByTestId("mcp-refresh-server") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("mcp-edit-server")).toBeTruthy();
    expect(screen.getByTestId("mcp-remove-server")).toBeTruthy();
    expect(screen.getByTestId("mcp-add")).toBeTruthy();
    expect(screen.getByTestId("mcp-reload")).toBeTruthy();
    expect((screen.getByTestId("mcp-login-server") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("mcp-assign-all-server")).toBeTruthy();
    expect(document.activeElement).toBe(toggle);
  });

  it("settles saving/focus from a broadcast-superseding authoritative load", async () => {
    let catalogLoads = 0;
    let resolveExplicit!: (response: Response) => void;
    let resolveWinner!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp/policy" && init?.method === "PATCH")
        return Promise.resolve(jsonResponse({ mcpEnabled: false }));
      if (url === "/mcp") {
        catalogLoads += 1;
        if (catalogLoads === 1)
          return Promise.resolve(jsonResponse({ mcpEnabled: true, servers: [] }));
        if (catalogLoads === 2)
          return new Promise<Response>((resolve) => (resolveExplicit = resolve));
        return new Promise<Response>((resolve) => (resolveWinner = resolve));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    render(<McpScreen />);
    const toggle = await screen.findByRole("switch", { name: "MCP runtime availability" });
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() => expect(catalogLoads).toBe(2));
    useAppStore.setState({ resourcesVersion: 1 });
    await waitFor(() => expect(catalogLoads).toBe(3));
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    resolveExplicit(jsonResponse({ mcpEnabled: true, servers: [] }));
    await Promise.resolve();
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    resolveWinner(jsonResponse({ mcpEnabled: false, servers: [] }));
    await waitFor(() => expect(toggle.getAttribute("aria-busy")).toBe("false"));
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it("retains authoritative truth and announces a persistence failure", async () => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp") return Promise.resolve(jsonResponse({ mcpEnabled: true, servers: [] }));
      if (url === "/mcp/policy" && init?.method === "PATCH")
        return Promise.resolve(jsonResponse({ error: "Policy write failed" }, 500));
      throw new Error(`unexpected request: ${url}`);
    });
    render(<McpScreen />);
    const toggle = await screen.findByRole("switch", { name: "MCP runtime availability" });
    fireEvent.click(toggle);
    await waitFor(() => expect(useAppStore.getState().error).toBe("Policy write failed"));
    expect((toggle as HTMLInputElement).checked).toBe(true);
    const status = screen.getByTestId("mcp-policy-status");
    expect(status.textContent).toContain("Policy write failed");
    expect(status.className).toContain("text-text-primary");
    expect(status.className).not.toContain("text-warning");
  });
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

describe("MCP definition provenance", () => {
  it("shows exact global, project, and environment origins with unchanged ownership", async () => {
    useAppStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          name: "Project",
          path: "/workspace/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedMcpServers: [],
        },
      ],
    });
    const longProjectPath = `/workspace/${"deep-directory/".repeat(12)}.pi/mcp.json`;
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        servers: [
          {
            id: "global",
            transport: "stdio",
            connected: false,
            toolNames: [],
            source: "global",
            editable: true,
            provenance: { source: "global", path: "/Users/test/.pi/agent/mcp.json" },
          },
          {
            id: "project",
            transport: "stdio",
            connected: false,
            toolNames: [],
            source: "project",
            editable: false,
            provenance: { source: "project", path: longProjectPath },
          },
          {
            id: "environment",
            transport: "stdio",
            connected: false,
            toolNames: [],
            source: "environment",
            editable: false,
            provenance: {
              source: "environment",
              variable: "AGENT_DECK_MCP_SERVERS",
            },
          },
        ],
      }),
    );

    render(<McpScreen />);

    const global = await screen.findByTestId("mcp-provenance-global");
    expect(global.textContent).toContain("global config · editable");
    expect(global.textContent).toContain("/Users/test/.pi/agent/mcp.json");
    expect(global.getAttribute("aria-label")).toBe(
      "global config · editable: /Users/test/.pi/agent/mcp.json",
    );
    expect(screen.getByTestId("mcp-edit-global")).toBeTruthy();
    expect(screen.getByTestId("mcp-remove-global")).toBeTruthy();

    const project = screen.getByTestId("mcp-provenance-project");
    expect(project.textContent).toContain("project config · read only");
    expect(project.getAttribute("aria-label")).toContain(longProjectPath);
    const projectPath = project.querySelector("[title]");
    expect(projectPath?.getAttribute("title")).toBe(longProjectPath);
    expect(projectPath?.className).toContain("truncate");
    expect(screen.queryByTestId("mcp-edit-project")).toBeNull();
    expect(screen.queryByTestId("mcp-remove-project")).toBeNull();

    const environment = screen.getByTestId("mcp-provenance-environment");
    expect(environment.textContent).toContain("environment · read only");
    expect(environment.textContent).toContain("AGENT_DECK_MCP_SERVERS");
    expect(environment.getAttribute("aria-label")).toBe(
      "environment · read only: AGENT_DECK_MCP_SERVERS",
    );
    expect(screen.queryByTestId("mcp-edit-environment")).toBeNull();
    expect(screen.queryByTestId("mcp-remove-environment")).toBeNull();
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

  it("keeps an explicit project value while All Projects is inherited, then restores its control", async () => {
    useAppStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          name: "Project",
          path: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedMcpServers: ["server"],
        },
      ],
    });
    let inherited = true;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp?projectId=project-1")
        return Promise.resolve(
          jsonResponse({
            defaultAssignedServerIds: inherited ? ["server"] : [],
            assignedServerIds: ["server"],
            servers: [{ id: "server", transport: "stdio", connected: true, toolNames: [] }],
          }),
        );
      if (url === "/mcp/server/default-assignment" && init?.method === "PATCH") {
        inherited = false;
        return Promise.resolve(jsonResponse({ defaultAssignedServerIds: [] }));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    const projectToggle = await screen.findByRole("checkbox", {
      name: /server is inherited from All Projects.*explicit project assignment is retained/i,
    });
    const allToggle = screen.getByRole("checkbox", {
      name: "All Projects MCP assignment for server",
    });
    expect((projectToggle as HTMLInputElement).checked).toBe(true);
    expect((projectToggle as HTMLInputElement).disabled).toBe(true);
    expect(projectToggle.getAttribute("aria-label")).toContain(
      "explicit project assignment is retained",
    );
    fireEvent.click(allToggle);
    await waitFor(() => expect((projectToggle as HTMLInputElement).disabled).toBe(false));
    expect((projectToggle as HTMLInputElement).checked).toBe(true);
  });

  it("announces All Projects saving state on its focused checkbox", async () => {
    let resolvePatch!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp")
        return Promise.resolve(
          jsonResponse({
            defaultAssignedServerIds: [],
            servers: [{ id: "server", transport: "stdio", connected: false, toolNames: [] }],
          }),
        );
      if (url === "/mcp/server/default-assignment" && init?.method === "PATCH")
        return new Promise<Response>((resolve) => (resolvePatch = resolve));
      throw new Error(`unexpected request: ${url}`);
    });
    render(<McpScreen />);
    const toggle = await screen.findByRole("checkbox", {
      name: "All Projects MCP assignment for server",
    });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Saving All Projects…")).toBeTruthy();
    expect(document.activeElement).toBe(toggle);
    resolvePatch(jsonResponse({ defaultAssignedServerIds: ["server"] }));
    await waitFor(() => expect(toggle.getAttribute("aria-busy")).toBe("false"));
  });

  it("rolls back a failed All Projects save and keeps keyboard focus", async () => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp")
        return Promise.resolve(
          jsonResponse({
            defaultAssignedServerIds: [],
            servers: [{ id: "server", transport: "stdio", connected: false, toolNames: [] }],
          }),
        );
      if (url === "/mcp/server/default-assignment" && init?.method === "PATCH")
        return Promise.resolve(jsonResponse({ error: "Default write failed" }, 500));
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    const toggle = await screen.findByTestId("mcp-assign-all-server");
    toggle.focus();
    fireEvent.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    expect(useAppStore.getState().error).toBe("Default write failed");
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it("visibly distinguishes inherited state with no explicit project assignment", async () => {
    useAppStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          name: "Project",
          path: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedMcpServers: [],
        },
      ],
    });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        defaultAssignedServerIds: ["server"],
        assignedServerIds: [],
        servers: [{ id: "server", transport: "stdio", connected: true, toolNames: [] }],
      }),
    );
    render(<McpScreen />);
    const projectToggle = await screen.findByRole("checkbox", {
      name: /inherited from All Projects.*explicit project assignment is not set/i,
    });
    expect((projectToggle as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Inherited · no explicit assignment")).toBeTruthy();
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
    expect(checkbox.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Saving this project…")).toBeTruthy();
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

  it("does not apply an old-project assignment refresh or focus after switching projects", async () => {
    const second = { ...project, id: "project-next", name: "Next project" };
    useAppStore.setState({ currentProjectId: project.id, projects: [project, second] });
    let resolvePatch!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/mcp?projectId=${project.id}`)
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: [],
            servers: [{ id: "old", transport: "stdio", connected: false, toolNames: [] }],
          }),
        );
      if (url === `/projects/${project.id}` && init?.method === "PATCH")
        return new Promise<Response>((resolve) => (resolvePatch = resolve));
      if (url === `/mcp?projectId=${second.id}`)
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: [],
            servers: [{ id: "new", transport: "stdio", connected: false, toolNames: [] }],
          }),
        );
      if (url === "/projects")
        return Promise.resolve(jsonResponse({ projects: [project, second] }));
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    const oldToggle = await screen.findByTestId("mcp-assign-old");
    oldToggle.focus();
    fireEvent.click(oldToggle);
    useAppStore.setState({ currentProjectId: second.id });
    expect(await screen.findByTestId("mcp-new")).toBeTruthy();
    resolvePatch(jsonResponse({ project: {} }));
    await waitFor(() => expect(screen.queryByTestId("mcp-old")).toBeNull());
    expect(screen.getByTestId("mcp-new")).toBeTruthy();
    expect(document.activeElement).not.toBe(oldToggle);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input) === `/mcp?projectId=${project.id}`),
    ).toHaveLength(1);
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

  it("shows an honest initial catalog failure instead of a successful empty state", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("catalog unavailable", { status: 503 }));
    render(<McpScreen />);
    expect(await screen.findByTestId("mcp-load-error")).toHaveProperty(
      "textContent",
      "MCP servers could not be loaded. Reload the catalog to try again.",
    );
    expect(screen.queryByTestId("mcp-empty")).toBeNull();
  });

  it("clears old rows when a project-switch catalog load fails", async () => {
    const first = { ...project, id: "first", name: "First" };
    const second = { ...project, id: "second", name: "Second" };
    useAppStore.setState({ currentProjectId: first.id, projects: [first, second] });
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/mcp?projectId=first")
        return Promise.resolve(
          jsonResponse({
            servers: [{ id: "old-row", transport: "stdio", connected: false, toolNames: [] }],
          }),
        );
      if (url === "/mcp?projectId=second")
        return Promise.resolve(new Response("project catalog unavailable", { status: 503 }));
      throw new Error(`unexpected request: ${url}`);
    });
    render(<McpScreen />);
    expect(await screen.findByTestId("mcp-old-row")).toBeTruthy();
    useAppStore.setState({ currentProjectId: second.id });
    expect(await screen.findByTestId("mcp-load-error")).toBeTruthy();
    expect(screen.queryByTestId("mcp-old-row")).toBeNull();
    expect(screen.queryByTestId("mcp-empty")).toBeNull();
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

describe("MCP OAuth callback", () => {
  const project = {
    id: "oauth-project",
    name: "OAuth project",
    path: "/tmp/oauth-project",
    createdAt: "2026-01-01T00:00:00.000Z",
    assignedMcpServers: ["remote"],
  };

  it("opens the browser, waits accessibly, preserves paste fallback, and cancels", async () => {
    useAppStore.setState({ currentProjectId: project.id, projects: [project] });
    const openExternal = vi.fn().mockResolvedValue(true);
    window.agentDeck = { isElectron: true, openExternal };
    let cancelled = false;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/mcp?projectId=${project.id}`)
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: ["remote"],
            missingAssignedServerIds: [],
            servers: [
              {
                id: "remote",
                transport: "http",
                connected: false,
                toolNames: [],
                auth: { status: "unauthenticated" },
              },
            ],
          }),
        );
      if (url === `/mcp/remote/login?projectId=${project.id}` && init?.method === "POST")
        return Promise.resolve(
          jsonResponse({
            auth: {
              status: "authorizing",
              automatic: true,
              authUrl: "https://auth.example/authorize?state=STATE",
            },
          }),
        );
      if (url === `/mcp/remote/login?projectId=${project.id}` && init?.method === "DELETE") {
        cancelled = true;
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-remote");
    fireEvent.click(screen.getByTestId("mcp-login-remote"));
    expect((await screen.findByRole("status")).textContent).toContain("Waiting for authorization");
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith("https://auth.example/authorize?state=STATE"),
    );
    expect(screen.queryByTestId("mcp-login-code-remote")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByTestId("mcp-login-manual-remote"));
    fireEvent.click(screen.getByTestId("mcp-login-manual-remote"));
    const codeInput = await screen.findByTestId("mcp-login-code-remote");
    await waitFor(() => expect(document.activeElement).toBe(codeInput));
    fireEvent.keyDown(codeInput, { key: "Escape" });
    await waitFor(() => expect(cancelled).toBe(true));
    expect(screen.queryByTestId("mcp-login-panel-remote")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("mcp-login-remote")),
    );
    delete window.agentDeck;
  });

  it("cancels stale cross-server login responses without replacing the newer flow", async () => {
    useAppStore.setState({ currentProjectId: project.id, projects: [project] });
    const openExternal = vi.fn().mockResolvedValue(true);
    window.agentDeck = { isElectron: true, openExternal };
    let resolveFirst!: (response: Response) => void;
    const cancelled: string[] = [];
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/mcp?projectId=${project.id}`)
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: ["one", "two"],
            servers: ["one", "two"].map((id) => ({
              id,
              transport: "http",
              connected: false,
              toolNames: [],
              auth: { status: "unauthenticated" },
            })),
          }),
        );
      if (url === `/mcp/one/login?projectId=${project.id}` && init?.method === "POST")
        return new Promise<Response>((resolve) => (resolveFirst = resolve));
      if (url === `/mcp/two/login?projectId=${project.id}` && init?.method === "POST")
        return Promise.resolve(
          jsonResponse({
            auth: {
              status: "authorizing",
              automatic: true,
              authUrl: "https://auth.example/two?state=TWO",
            },
          }),
        );
      if (init?.method === "DELETE") {
        cancelled.push(url);
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-one");
    fireEvent.click(screen.getByTestId("mcp-login-one"));
    fireEvent.click(screen.getByTestId("mcp-login-two"));
    await screen.findByTestId("mcp-login-panel-two");
    resolveFirst(
      jsonResponse({
        auth: {
          status: "authorizing",
          automatic: true,
          authUrl: "https://auth.example/one?state=ONE",
        },
      }),
    );
    await waitFor(() => expect(cancelled).toContain(`/mcp/one/login?projectId=${project.id}`));
    expect(screen.queryByTestId("mcp-login-panel-one")).toBeNull();
    expect(screen.getByTestId("mcp-login-panel-two")).toBeTruthy();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://auth.example/two?state=TWO");
    delete window.agentDeck;
  });

  it("cancels a pending login after unmount once its stale response materializes", async () => {
    useAppStore.setState({ currentProjectId: project.id, projects: [project] });
    let resolveLogin!: (response: Response) => void;
    let cancelled = false;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/mcp?projectId=${project.id}`)
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: ["remote"],
            servers: [
              {
                id: "remote",
                transport: "http",
                connected: false,
                toolNames: [],
                auth: { status: "unauthenticated" },
              },
            ],
          }),
        );
      if (url === `/mcp/remote/login?projectId=${project.id}` && init?.method === "POST")
        return new Promise<Response>((resolve) => (resolveLogin = resolve));
      if (url === `/mcp/remote/login?projectId=${project.id}` && init?.method === "DELETE") {
        cancelled = true;
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const rendered = render(<McpScreen />);
    await screen.findByTestId("mcp-remote");
    fireEvent.click(screen.getByTestId("mcp-login-remote"));
    expect((screen.getByTestId("mcp-refresh-remote") as HTMLButtonElement).disabled).toBe(true);
    rendered.unmount();
    resolveLogin(
      jsonResponse({
        auth: {
          status: "authorizing",
          automatic: true,
          authUrl: "https://auth.example/authorize?state=STALE",
        },
      }),
    );
    await waitFor(() => expect(cancelled).toBe(true));
  });

  it("locks repeated manual submission and announces pending state", async () => {
    useAppStore.setState({ currentProjectId: project.id, projects: [project] });
    window.agentDeck = { isElectron: true, openExternal: vi.fn().mockResolvedValue(true) };
    let callbackCount = 0;
    let resolveCallback!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/mcp?projectId=${project.id}`)
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: ["remote"],
            servers: [
              {
                id: "remote",
                transport: "http",
                connected: false,
                toolNames: [],
                auth: { status: "unauthenticated" },
              },
            ],
          }),
        );
      if (url === `/mcp/remote/login?projectId=${project.id}` && init?.method === "POST")
        return Promise.resolve(
          jsonResponse({
            auth: {
              status: "authorizing",
              automatic: false,
              authUrl: "https://auth.example/authorize?state=STATE",
            },
          }),
        );
      if (url.includes("/login/callback") && init?.method === "POST") {
        callbackCount += 1;
        return new Promise<Response>((resolve) => (resolveCallback = resolve));
      }
      if (url === `/mcp/remote/login?projectId=${project.id}` && init?.method === "DELETE")
        return Promise.resolve(jsonResponse({ ok: true }));
      throw new Error(`unexpected request: ${url}`);
    });
    render(<McpScreen />);
    await screen.findByTestId("mcp-remote");
    fireEvent.click(screen.getByTestId("mcp-login-remote"));
    const input = await screen.findByTestId("mcp-login-code-remote");
    const reconnect = screen.getByTestId("mcp-refresh-remote") as HTMLButtonElement;
    expect(reconnect.disabled).toBe(true);
    expect(reconnect.getAttribute("aria-busy")).toBe("true");
    fireEvent.change(input, { target: { value: "code" } });
    const submit = screen.getByTestId("mcp-login-submit-remote");
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(callbackCount).toBe(1);
    expect(screen.getByTestId("mcp-login-panel-remote").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("Submitting authorization code");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(reconnect.disabled).toBe(true);
    resolveCallback(jsonResponse({ auth: { status: "authorized" } }));
    await waitFor(() => expect(screen.queryByTestId("mcp-login-panel-remote")).toBeNull());
    delete window.agentDeck;
  });

  it("replaces dead manual input with an actionable restart after an automatic failure", async () => {
    useAppStore.setState({ currentProjectId: project.id, projects: [project] });
    window.agentDeck = { isElectron: true, openExternal: vi.fn().mockResolvedValue(true) };
    let failed = false;
    let begins = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/mcp?projectId=${project.id}`)
        return Promise.resolve(
          jsonResponse({
            assignedServerIds: ["remote"],
            servers: [
              {
                id: "remote",
                transport: "http",
                connected: false,
                toolNames: [],
                auth: failed
                  ? { status: "error", error: "authorization timed out" }
                  : { status: "unauthenticated" },
              },
            ],
          }),
        );
      if (url === `/mcp/remote/login?projectId=${project.id}` && init?.method === "POST") {
        begins += 1;
        return Promise.resolve(
          jsonResponse({
            auth: {
              status: "authorizing",
              automatic: true,
              authUrl: `https://auth.example/authorize?state=STATE${begins}`,
            },
          }),
        );
      }
      if (url === `/mcp/remote/login?projectId=${project.id}` && init?.method === "DELETE")
        return Promise.resolve(jsonResponse({ ok: true }));
      throw new Error(`unexpected request: ${url}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-remote");
    fireEvent.click(screen.getByTestId("mcp-login-remote"));
    await screen.findByTestId("mcp-login-manual-remote");
    failed = true;
    useAppStore.setState({ resourcesVersion: 1 });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "authorization timed out",
    );
    expect(screen.queryByTestId("mcp-login-code-remote")).toBeNull();
    fireEvent.click(screen.getByTestId("mcp-login-restart-remote"));
    await waitFor(() => expect(begins).toBe(2));
    await screen.findByTestId("mcp-login-manual-remote");
    delete window.agentDeck;
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

/**
 * MCP-09: a globally-scoped server is not necessarily editable. Since the
 * catalog began reading `~/.config/mcp/mcp.json` (MCP-11), a global definition
 * can be read-only — the server already reports `editable: false` and both Edit
 * and Delete are hidden, but the provenance line still claimed "editable",
 * telling the user an edit would persist when nothing would accept it.
 */
describe("MCP read-only global provenance (MCP-09)", () => {
  it("labels a non-editable global definition read only", async () => {
    useAppStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          name: "Project",
          path: "/workspace/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedMcpServers: [],
        },
      ],
    });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        servers: [
          {
            id: "xdg",
            transport: "stdio",
            connected: false,
            toolNames: [],
            source: "global",
            editable: false,
            provenance: { source: "global", path: "/Users/test/.config/mcp/mcp.json" },
          },
        ],
      }),
    );

    render(<McpScreen />);

    const row = await screen.findByTestId("mcp-provenance-xdg");
    expect(row.textContent).toContain("read only");
    expect(row.textContent).not.toContain("editable");
    // The affordance already agrees; only the words disagreed.
    expect(screen.queryByTestId("mcp-edit-xdg")).toBeNull();
  });

  it("still labels the app-owned global config editable", async () => {
    useAppStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          name: "Project",
          path: "/workspace/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedMcpServers: [],
        },
      ],
    });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        servers: [
          {
            id: "ours",
            transport: "stdio",
            connected: false,
            toolNames: [],
            source: "global",
            editable: true,
            provenance: { source: "global", path: "/Users/test/.pi/agent/mcp.json" },
          },
        ],
      }),
    );

    render(<McpScreen />);

    expect((await screen.findByTestId("mcp-provenance-ours")).textContent).toContain("editable");
  });
});

/**
 * MCP-09 fail-closed: `editable` is optional on the wire. Absence means
 * ownership is UNKNOWN, and both the label and the Remove action must take the
 * restrictive branch — the label promises persistence and Remove triggers a
 * write, so guessing "editable" is the unsafe direction (Codex).
 */
describe("MCP unknown ownership fails closed (MCP-09)", () => {
  it("labels a global server read only and hides both actions when editable is absent", async () => {
    useAppStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          name: "Project",
          path: "/workspace/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedMcpServers: [],
        },
      ],
    });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        servers: [
          {
            id: "unknown",
            transport: "stdio",
            connected: false,
            toolNames: [],
            source: "global",
            // `editable` deliberately omitted — an older or partial response.
            provenance: { source: "global", path: "/Users/test/.pi/agent/mcp.json" },
          },
        ],
      }),
    );

    render(<McpScreen />);

    const row = await screen.findByTestId("mcp-provenance-unknown");
    expect(row.textContent).toContain("read only");
    expect(screen.queryByTestId("mcp-edit-unknown")).toBeNull();
    expect(screen.queryByTestId("mcp-remove-unknown")).toBeNull();
  });
});

/**
 * MCP-12: pasting a server's setup into the add form fills it in (native
 * MCPConfigParser). The parser has its own tests in @agent-deck/domain; these
 * pin that the screen actually CALLS it and maps the result onto the fields —
 * a parser nothing invokes would be the never-wired defect.
 */
describe("MCP smart paste (MCP-12)", () => {
  /**
   * Native's add sheet has a Manual | Paste picker. The Paste tab takes a whole
   * config snippet and saves EVERY server it parses with the config VERBATIM —
   * it does not funnel them through the manual fields, which have nowhere to put
   * env or headers.
   */
  const openPasteTab = async (existing: { id: string }[] = []): Promise<void> => {
    useAppStore.setState({ currentProjectId: null, projects: [] });
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/mcp" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }, 201));
      }
      return Promise.resolve(
        jsonResponse({
          servers: existing.map((server) => ({
            transport: "stdio",
            connected: false,
            toolNames: [],
            ...server,
          })),
        }),
      );
    });
    render(<McpScreen />);
    fireEvent.click(await screen.findByTestId("mcp-add"));
    fireEvent.click(screen.getByRole("radio", { name: "Paste" }));
  };

  const type = (text: string): void => {
    fireEvent.change(screen.getByTestId("mcp-paste"), { target: { value: text } });
  };

  const posts = (): unknown[] =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([input, init]) => String(input) === "/mcp" && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));

  it("saves every server in a pasted block, keeping env the manual form cannot hold", async () => {
    await openPasteTab();

    type(
      JSON.stringify({
        mcpServers: {
          zulu: { command: "z" },
          alpha: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "secret" } },
        },
      }),
    );
    fireEvent.click(screen.getByTestId("mcp-add-confirm"));

    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()).toEqual([
      { name: "alpha", command: "npx", args: ["-y", "srv"], env: { TOKEN: "secret" } },
      { name: "zulu", command: "z" },
    ]);
  });

  it("keeps the auth header off a pasted remote server's command line", async () => {
    await openPasteTab();

    type('claude mcp add docs -t http https://example.com/mcp -H "Authorization: Bearer t"');
    fireEvent.click(screen.getByTestId("mcp-add-confirm"));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({
      name: "docs",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("sends empty headers so a pasted replacement drops the old credential", async () => {
    await openPasteTab([{ id: "docs" }]);

    // Native replaces the whole config. Omitting headers here would leave the
    // previous server's Authorization attached to the newly pasted url.
    type(JSON.stringify({ mcpServers: { docs: { url: "https://new.test/mcp" } } }));
    fireEvent.click(screen.getByTestId("mcp-add-confirm"));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ name: "docs", url: "https://new.test/mcp", headers: {} });
  });

  it("derives a name for a snippet that carries none", async () => {
    await openPasteTab();

    // Native: the first host label that is not api/www/mcp/app.
    type(JSON.stringify({ url: "https://mcp.amplitude.com/mcp" }));
    fireEvent.click(screen.getByTestId("mcp-add-confirm"));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect((posts()[0] as { name: string }).name).toBe("amplitude");
  });

  it("will not save text that parses to nothing", async () => {
    await openPasteTab();

    type("npm install some-mcp-server");

    expect((screen.getByTestId("mcp-add-confirm") as HTMLButtonElement).disabled).toBe(true);
    type(JSON.stringify({ command: "srv" }));
    expect((screen.getByTestId("mcp-add-confirm") as HTMLButtonElement).disabled).toBe(false);
  });

  it("warns before a paste replaces a server that already exists", async () => {
    await openPasteTab([{ id: "files" }]);

    type(JSON.stringify({ mcpServers: { files: { command: "new" } } }));

    expect(screen.getByTestId("mcp-add-hint").textContent).toContain("files");
  });

  it("offers Paste when adding but not when editing an existing server", async () => {
    useAppStore.setState({ currentProjectId: null, projects: [] });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        servers: [
          {
            id: "files",
            transport: "stdio",
            command: "npx",
            connected: false,
            toolNames: [],
            editable: true,
          },
        ],
      }),
    );
    render(<McpScreen />);
    fireEvent.click(await screen.findByTestId("mcp-add"));
    expect(screen.getByRole("radio", { name: "Paste" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.click(await screen.findByTestId("mcp-edit-files"));

    expect(screen.queryByRole("radio", { name: "Paste" })).toBeNull();
  });
});

/**
 * MCP-10 — native's server row menu has "Reveal Config in Finder" for EVERY
 * entry, editable or not, so a read-only definition can still be opened by
 * hand. The port knows each server's exact winning path from MCP-08.
 */
describe("MCP reveal config (MCP-10)", () => {
  const withServers = async (servers: Record<string, unknown>[]): Promise<void> => {
    useAppStore.setState({ currentProjectId: null, projects: [] });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        servers: servers.map((server) => ({
          transport: "stdio",
          connected: false,
          toolNames: [],
          ...server,
        })),
      }),
    );
    render(<McpScreen />);
    await screen.findByTestId("mcp-provenance-files");
  };

  it("reveals a read-only definition's own file", async () => {
    const revealResourceFile = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("agentDeck", { isElectron: true, revealResourceFile });
    await withServers([
      {
        id: "files",
        command: "npx",
        editable: false,
        source: "project",
        provenance: { source: "project", path: "/repo/.pi/mcp.json" },
      },
    ]);

    fireEvent.click(screen.getByTestId("mcp-reveal-files"));

    await waitFor(() =>
      expect(revealResourceFile).toHaveBeenCalledWith({
        kind: "mcp",
        projectId: null,
        filePath: "/repo/.pi/mcp.json",
      }),
    );
  });

  it("offers no reveal for a definition that has no file", async () => {
    vi.stubGlobal("agentDeck", { isElectron: true, revealResourceFile: vi.fn() });
    await withServers([
      {
        id: "files",
        command: "npx",
        editable: false,
        source: "global",
        provenance: { source: "global", path: "/home/.pi/agent/mcp.json" },
      },
      {
        id: "envsrv",
        command: "env-cmd",
        editable: false,
        source: "environment",
        provenance: { source: "environment", variable: "AGENT_DECK_MCP_SERVERS" },
      },
    ]);

    // An environment override has no owning file to reveal.
    expect(screen.getByTestId("mcp-reveal-files")).toBeTruthy();
    expect(screen.queryByTestId("mcp-reveal-envsrv")).toBeNull();
  });
});
