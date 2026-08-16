import { AppSegmentedPicker } from "@/design-system/components/AppSegmentedPicker";
import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, LogOut, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { responseErrorMessage } from "@/lib/responseError";
import { useAppStore } from "../state/store.ts";
import { updateProject } from "../state/wsBridge.ts";

/**
 * MCP screen (native Runtime → MCP): the configured MCP servers whose tools are
 * proxied into pi sessions over the bridge. Each row shows live connection
 * status + the tools that connected; add a stdio or HTTP server, refresh, or
 * remove it. An http server behind OAuth also gets a Sign-in flow (native
 * MCPOAuthService): begin → open the authorization link → paste the redirect's
 * code → connected.
 */

type McpTransport = "stdio" | "http";

const MCP_TRANSPORT_OPTIONS = [
  { id: "stdio", label: "Local (stdio)" },
  { id: "http", label: "Remote (HTTP)" },
] as const;

interface McpAuth {
  status: "none" | "unauthenticated" | "authorizing" | "authorized" | "error";
  authUrl?: string;
  error?: string;
}

interface McpServer {
  id: string;
  transport: McpTransport;
  connected: boolean;
  toolNames: string[];
  error?: string;
  auth?: McpAuth;
  source?: "global" | "project" | "environment";
  editable?: boolean;
  command?: string;
  args?: string[];
  url?: string;
}

/** Client-side check matching the backend `isValidHttpMcpUrl` contract without
 *  importing `@agent-deck/resources` into the sandboxed renderer. */
function isValidHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function needsArgQuoting(arg: string): boolean {
  return arg === "" || /\s/.test(arg) || /^["']/.test(arg) || arg.includes("\\");
}

function argsLineFrom(args: readonly string[] | undefined): string {
  return (args ?? []).map((arg) => (needsArgQuoting(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function unescapeQuotedArg(inner: string, quote: '"' | "'"): string {
  const escaped = quote === '"' ? /\\(["\\])/g : /\\(['\\])/g;
  return inner.replace(escaped, "$1");
}

function parseArgLine(value: string): string[] {
  const args: string[] = [];
  const token = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
  for (const match of value.matchAll(token)) {
    if (match[1] !== undefined) {
      try {
        const parsed: unknown = JSON.parse(match[0]);
        if (typeof parsed === "string") {
          args.push(parsed);
          continue;
        }
      } catch {
        // Invalid user quotes must not crash the form.
      }
      args.push(unescapeQuotedArg(match[1], '"'));
    } else if (match[2] !== undefined) {
      args.push(unescapeQuotedArg(match[2], "'"));
    } else if (match[3] !== undefined) {
      args.push(match[3]);
    }
  }
  return args;
}

/** In-progress sign-in: the server + the authorization URL to open, and the
 *  OAuth `state` parsed from it (echoed back on the callback for CSRF). */
interface LoginFlow {
  id: string;
  authUrl: string;
  state: string;
}

type CatalogLoadResult = "applied" | "failed" | "superseded";

/** Extract the `code` (+ `state`) the user pastes back — either a bare code or
 *  the full redirect URL they landed on. Falls back to the flow's own state. */
function parseCallback(input: string, fallbackState: string): { code: string; state: string } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") ?? "",
      state: url.searchParams.get("state") ?? fallbackState,
    };
  } catch {
    return { code: trimmed, state: fallbackState };
  }
}

export function McpScreen() {
  const setError = useAppStore((state) => state.setError);
  const pushToast = useAppStore((state) => state.pushToast);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const projects = useAppStore((state) => state.projects);
  const selectedProject = projects.find((project) => project.id === currentProjectId);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [assignedServerIds, setAssignedServerIds] = useState<string[]>([]);
  const [missingAssignedServerIds, setMissingAssignedServerIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingAssignments, setSavingAssignments] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [login, setLogin] = useState<LoginFlow | null>(null);
  const [code, setCode] = useState("");
  const loadSeq = useRef(0);
  const loadedProject = useRef<string | null | undefined>(undefined);
  const assignmentSaving = useRef(false);
  const assignmentInputs = useRef(new Map<string, HTMLInputElement>());
  const addToggleRef = useRef<HTMLButtonElement>(null);
  const editToggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const editSnapshot = useRef<{
    transport: McpTransport;
    command: string;
    argsText: string;
    url: string;
  } | null>(null);
  const latestLoad = useRef<Promise<CatalogLoadResult> | null>(null);
  // Bumped whenever a sign-in flow starts, so a slow /login (or /callback) for one
  // server can't clobber a newer flow the user has since started for another.
  const loginSeq = useRef(0);

  const load = useCallback(
    (preserveRows = false): Promise<CatalogLoadResult> => {
      const seq = ++loadSeq.current;
      const pending = (async (): Promise<CatalogLoadResult> => {
        try {
          if (!preserveRows) setLoading(true);
          const query = currentProjectId
            ? `?projectId=${encodeURIComponent(currentProjectId)}`
            : "";
          const response = await fetch(`/mcp${query}`);
          if (!response.ok) throw new Error(await response.text());
          const data = (await response.json()) as {
            servers: McpServer[];
            assignedServerIds?: string[];
            missingAssignedServerIds?: string[];
          };
          if (seq !== loadSeq.current) return "superseded";
          setServers((current) => {
            if (!preserveRows) return data.servers;
            const incoming = new Map(data.servers.map((server) => [server.id, server]));
            return current.map((server) => incoming.get(server.id) ?? server);
          });
          setAssignedServerIds(data.assignedServerIds ?? []);
          setMissingAssignedServerIds(data.missingAssignedServerIds ?? []);
          return "applied";
        } catch (err) {
          if (seq !== loadSeq.current) return "superseded";
          setError(String(err));
          return "failed";
        } finally {
          // A silent assignment refresh may supersede a broadcast-triggered full
          // load; the winning request must always settle its loading indicator.
          if (seq === loadSeq.current) setLoading(false);
        }
      })();
      latestLoad.current = pending;
      return pending;
    },
    [currentProjectId, setError],
  );

  useEffect(() => {
    const preserveRows = loadedProject.current === currentProjectId;
    if (loadedProject.current !== currentProjectId) {
      setAdding(false);
      setEditingId(null);
      editSnapshot.current = null;
    }
    loadedProject.current = currentProjectId;
    void load(preserveRows);
  }, [currentProjectId, load, resourcesVersion]);

  const trimmedName = name.trim();
  const trimmedCommand = command.trim();
  const parsedArgs = parseArgLine(argsText);
  const trimmedUrl = url.trim();
  const editing = editingId !== null;
  const formOpen = adding || editing;
  const duplicateName = !editing && servers.some((server) => server.id === trimmedName);
  const canSubmit =
    Boolean(trimmedName) &&
    !saving &&
    !duplicateName &&
    (transport === "stdio" ? Boolean(trimmedCommand) : isValidHttpUrl(trimmedUrl));

  const resetDraft = (): void => {
    setName("");
    setCommand("");
    setArgsText("");
    setUrl("");
    setTransport("stdio");
    editSnapshot.current = null;
  };

  const add = async (): Promise<void> => {
    if (!canSubmit || editing) return;
    const body =
      transport === "http"
        ? { name: trimmedName, url: trimmedUrl }
        : {
            name: trimmedName,
            command: trimmedCommand,
            args: parsedArgs,
          };
    setSaving(true);
    try {
      const response = await fetch("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      resetDraft();
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const closeEditor = (restore = false): void => {
    const id = editingId;
    if (restore && editSnapshot.current) {
      setTransport(editSnapshot.current.transport);
      setCommand(editSnapshot.current.command);
      setArgsText(editSnapshot.current.argsText);
      setUrl(editSnapshot.current.url);
    }
    setEditingId(null);
    editSnapshot.current = null;
    requestAnimationFrame(() => {
      if (id) editToggleRefs.current.get(id)?.focus();
    });
  };

  const startAdd = (): void => {
    if (saving) return;
    if (adding) {
      setAdding(false);
      return;
    }
    setEditingId(null);
    editSnapshot.current = null;
    resetDraft();
    setAdding(true);
  };

  const startEdit = (server: McpServer): void => {
    if (saving) return;
    if (editingId === server.id) {
      closeEditor();
      return;
    }
    const nextCommand = server.command ?? "";
    const nextArgs = argsLineFrom(server.args);
    const nextUrl = server.url ?? "";
    const nextTransport = server.transport;
    setAdding(false);
    setEditingId(server.id);
    setName(server.id);
    setTransport(nextTransport);
    setCommand(nextCommand);
    setArgsText(nextArgs);
    setUrl(nextUrl);
    editSnapshot.current = {
      transport: nextTransport,
      command: nextCommand,
      argsText: nextArgs,
      url: nextUrl,
    };
  };

  const saveEdit = async (): Promise<void> => {
    if (!editingId || !canSubmit) return;
    const savedProjectId = currentProjectId;
    const body =
      transport === "http" ? { url: trimmedUrl } : { command: trimmedCommand, args: parsedArgs };
    setSaving(true);
    try {
      const response = await fetch(`/mcp/${encodeURIComponent(editingId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const id = editingId;
      setEditingId(null);
      resetDraft();
      // A project switch while PATCH was in flight already owns catalog + focus.
      if (loadedProject.current !== savedProjectId) return;
      await load();
      if (loadedProject.current !== savedProjectId) return;
      requestAnimationFrame(() => {
        if (loadedProject.current === savedProjectId) editToggleRefs.current.get(id)?.focus();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const refresh = async (id: string): Promise<void> => {
    try {
      const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
      const response = await fetch(`/mcp/${encodeURIComponent(id)}/refresh${query}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await response.text());
    } catch (err) {
      setError(String(err));
    }
    await load();
  };

  const reloadFromDisk = async (): Promise<void> => {
    if (reloading) return;
    setReloading(true);
    setError(null);
    try {
      const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
      const response = await fetch(`/mcp/reload${query}`, { method: "POST" });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      let pending = load();
      for (;;) {
        const result = await pending;
        if (result === "failed") return;
        if (result === "applied") break;
        const winner = latestLoad.current;
        if (!winner || winner === pending) return;
        pending = winner;
      }
      pushToast({ kind: "success", message: "Reloaded MCP configuration" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  };

  const assign = async (id: string, enabled: boolean): Promise<void> => {
    if (!currentProjectId || assignmentSaving.current) return;
    assignmentSaving.current = true;
    const restoreFocus = assignmentInputs.current.get(id) === document.activeElement;
    const next = new Set(assignedServerIds);
    if (enabled) next.add(id);
    else next.delete(id);
    // Immediate controlled-state feedback; the id lock prevents stale rapid toggles.
    setAssignedServerIds([...next]);
    setSavingAssignments((current) => new Set(current).add(id));
    try {
      await updateProject(currentProjectId, { assignedMcpServers: [...next] });
      const authoritative = useAppStore
        .getState()
        .projects.find((project) => project.id === currentProjectId)?.assignedMcpServers;
      setAssignedServerIds(authoritative ?? []);
      // Refresh connection/error state without unmounting rows or stealing focus.
      await load(true);
    } finally {
      assignmentSaving.current = false;
      setSavingAssignments((current) => {
        const updated = new Set(current);
        updated.delete(id);
        return updated;
      });
      if (restoreFocus) {
        setTimeout(() => assignmentInputs.current.get(id)?.focus(), 0);
      }
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      const response = await fetch(`/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await response.text());
    } catch (err) {
      setError(String(err));
    }
    await load();
  };

  // Begin OAuth: ask the server for the authorization URL, then show the
  // open-link + paste-code panel. The `state` is parsed from the URL and echoed
  // back on the callback for CSRF verification.
  const beginLogin = async (id: string): Promise<void> => {
    const seq = ++loginSeq.current;
    setCode("");
    try {
      const response = await fetch(
        `/mcp/${encodeURIComponent(id)}/login?projectId=${encodeURIComponent(currentProjectId ?? "")}`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await response.text());
      const { auth } = (await response.json()) as { auth: McpAuth };
      if (!auth.authUrl) throw new Error("no authorization URL returned");
      const state = new URL(auth.authUrl).searchParams.get("state") ?? "";
      // Ignore a stale response if the user has since started another flow.
      if (seq === loginSeq.current) setLogin({ id, authUrl: auth.authUrl, state });
    } catch (err) {
      if (seq === loginSeq.current) setError(String(err));
    }
  };

  // Complete OAuth with the pasted code (or redirect URL) → the server exchanges
  // it and reconnects, so the server's tools register.
  const submitCode = async (): Promise<void> => {
    const flow = login;
    if (!flow) return;
    const seq = loginSeq.current;
    const { code: parsedCode, state } = parseCallback(code, flow.state);
    if (!parsedCode) return;
    try {
      const response = await fetch(
        `/mcp/${encodeURIComponent(flow.id)}/login/callback?projectId=${encodeURIComponent(currentProjectId ?? "")}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: parsedCode, state }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      pushToast({ kind: "success", message: `Signed in to ${flow.id}` });
      // Only close/clear the panel if the user hasn't since started another flow.
      if (seq === loginSeq.current) {
        setLogin(null);
        setCode("");
      }
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const logout = async (id: string): Promise<void> => {
    try {
      const response = await fetch(
        `/mcp/${encodeURIComponent(id)}/logout?projectId=${encodeURIComponent(currentProjectId ?? "")}`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await response.text());
    } catch (err) {
      setError(String(err));
    }
    await load();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="mcp-screen">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between pb-1">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-text-secondary" aria-hidden />
            <h2
              className="text-base font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              MCP servers
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <ControlButton
              data-testid="mcp-reload"
              className="flex items-center gap-1.5 rounded-capsule px-3 py-1 text-xs font-medium text-text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
              disabled={reloading}
              title="Reload mcp.json and apply added, changed, or removed servers"
              aria-label="Reload MCP configuration"
              onClick={() => void reloadFromDisk()}
            >
              <RefreshCw size={13} className={reloading ? "animate-spin" : undefined} />
              {reloading ? "Reloading…" : "Reload config"}
            </ControlButton>
            <ControlButton
              ref={addToggleRef}
              data-testid="mcp-add"
              className="flex items-center gap-1.5 rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              style={{
                background:
                  "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                color: "var(--color-accent-foreground)",
              }}
              aria-label={adding ? "Close add MCP server form" : "Add MCP server"}
              disabled={saving}
              onClick={startAdd}
            >
              <Plus size={13} /> Add server
            </ControlButton>
          </div>
        </div>
        <p className="break-words pb-3 text-xs text-text-muted" data-testid="mcp-trust-copy">
          {selectedProject
            ? `Only servers you assign here are connected for ordinary ${selectedProject.name} sessions. Project .pi/mcp.json definitions are read-only and may run repository-controlled commands; review them before assigning.`
            : "Select a project to assign servers. Add and remove edit only your global ~/.pi/agent/mcp.json catalog; project definitions stay read-only."}
        </p>

        {formOpen ? (
          <form
            className="mb-3 flex flex-col gap-2"
            data-testid={editing ? "mcp-edit-form" : "mcp-add-form"}
            aria-label={editing ? `Edit MCP server ${editingId}` : "Add MCP server"}
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              if (editing) void saveEdit();
              else void add();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (saving) return;
              if (editing) {
                closeEditor(true);
                return;
              }
              setAdding(false);
              requestAnimationFrame(() => addToggleRef.current?.focus());
            }}
          >
            {editing ? (
              <p className="text-xs text-text-muted" data-testid="mcp-editing-label">
                Editing {editingId}
              </p>
            ) : null}
            <div data-testid="mcp-transport">
              <AppSegmentedPicker
                aria-label="MCP server type"
                size="sm"
                value={transport}
                onChange={(next) => setTransport(next)}
                disabled={saving}
                options={MCP_TRANSPORT_OPTIONS}
              />
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-text-secondary">Name</span>
              <ControlInput
                autoFocus={!editing}
                data-testid="mcp-name"
                className="rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent disabled:opacity-55"
                placeholder="filesystem"
                aria-invalid={duplicateName || undefined}
                aria-describedby={duplicateName ? "mcp-add-hint" : undefined}
                value={name}
                disabled={editing || saving}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="flex flex-col gap-2">
              {transport === "stdio" ? (
                <>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-medium text-text-secondary">Command</span>
                    <ControlInput
                      autoFocus={editing}
                      data-testid="mcp-command"
                      className="min-w-0 w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent disabled:opacity-55"
                      placeholder="npx"
                      value={command}
                      disabled={saving}
                      onChange={(e) => setCommand(e.target.value)}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-medium text-text-secondary">Arguments</span>
                    <ControlInput
                      data-testid="mcp-args"
                      className="min-w-0 w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent disabled:opacity-55"
                      placeholder='-y server-fs "/path with spaces"'
                      value={argsText}
                      disabled={saving}
                      onChange={(e) => setArgsText(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-xs font-medium text-text-secondary">URL</span>
                  <ControlInput
                    autoFocus={editing}
                    data-testid="mcp-url"
                    className="min-w-0 w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent disabled:opacity-55"
                    placeholder="https://mcp.example.com/mcp"
                    aria-invalid={(Boolean(trimmedUrl) && !isValidHttpUrl(trimmedUrl)) || undefined}
                    aria-describedby={
                      trimmedUrl && !isValidHttpUrl(trimmedUrl) ? "mcp-add-hint" : undefined
                    }
                    value={url}
                    disabled={saving}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </label>
              )}
            </div>
            <div className="flex items-center justify-end">
              <ControlButton
                type="submit"
                data-testid={editing ? "mcp-edit-confirm" : "mcp-add-confirm"}
                className="rounded-capsule px-3 py-1.5 text-xs font-medium shadow-capsule disabled:opacity-40"
                style={{
                  background:
                    "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                  color: "var(--color-accent-foreground)",
                }}
                disabled={!canSubmit}
              >
                {saving ? (editing ? "Saving…" : "Adding…") : editing ? "Save" : "Add"}
              </ControlButton>
            </div>
            {duplicateName ? (
              <p id="mcp-add-hint" className="text-xs text-warning" data-testid="mcp-add-hint">
                A server named {trimmedName} already exists.
              </p>
            ) : transport === "http" && trimmedUrl && !isValidHttpUrl(trimmedUrl) ? (
              <p id="mcp-add-hint" className="text-xs text-warning" data-testid="mcp-add-hint">
                Enter an http:// or https:// URL.
              </p>
            ) : null}
          </form>
        ) : null}

        <div
          className="space-y-1.5"
          data-testid="mcp-list"
          aria-busy={loading || savingAssignments.size > 0}
        >
          {loading ? (
            <div className="py-8 text-center text-sm text-text-muted" data-testid="mcp-loading">
              Loading MCP servers…
            </div>
          ) : null}
          {!loading &&
            servers.map((server) => (
              <div key={server.id}>
                <div
                  data-testid={`mcp-${server.id}`}
                  data-connected={server.connected ? "true" : "false"}
                  data-assigned={assignedServerIds.includes(server.id) ? "true" : "false"}
                  className="flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5"
                  aria-busy={savingAssignments.has(server.id)}
                >
                  {currentProjectId ? (
                    <label className="flex shrink-0 items-center gap-1.5 text-detail text-text-muted">
                      <ControlInput
                        type="checkbox"
                        className="h-4 w-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        ref={(element) => {
                          if (element) assignmentInputs.current.set(server.id, element);
                          else assignmentInputs.current.delete(server.id);
                        }}
                        data-testid={`mcp-assign-${server.id}`}
                        aria-label={`Assign ${server.id} to ${selectedProject?.name ?? "project"}`}
                        checked={assignedServerIds.includes(server.id)}
                        disabled={savingAssignments.size > 0}
                        onChange={(event) => void assign(server.id, event.target.checked)}
                      />
                      <span>
                        {savingAssignments.has(server.id)
                          ? "Saving…"
                          : assignedServerIds.includes(server.id)
                            ? "Assigned"
                            : "Assign"}
                      </span>
                    </label>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                      <span
                        className="truncate text-sm font-medium text-text-primary"
                        style={{ fontStretch: "expanded" }}
                      >
                        {server.id}
                      </span>
                      <span
                        data-testid={`mcp-status-${server.id}`}
                        className={cn(
                          "rounded-capsule border px-1.5 text-micro",
                          server.connected
                            ? "border-success text-success"
                            : currentProjectId && !assignedServerIds.includes(server.id)
                              ? "border-border-subtle text-text-muted"
                              : "border-danger text-danger",
                        )}
                      >
                        {server.connected
                          ? "connected"
                          : currentProjectId && !assignedServerIds.includes(server.id)
                            ? "available"
                            : "disconnected"}
                      </span>
                      <span className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted">
                        {server.transport}
                      </span>
                      {server.source ? (
                        <span
                          className="truncate text-detail text-text-muted"
                          title={server.source}
                        >
                          {server.source === "project"
                            ? "project config · read only"
                            : server.source}
                        </span>
                      ) : null}
                      {server.transport === "http" &&
                      server.auth &&
                      server.auth.status !== "none" ? (
                        <span
                          data-testid={`mcp-auth-${server.id}`}
                          data-auth={server.auth.status}
                          className={cn(
                            "rounded-capsule border px-1.5 text-micro",
                            server.auth.status === "authorized"
                              ? "border-success text-success"
                              : "border-border-subtle text-text-muted",
                          )}
                        >
                          {server.auth.status === "authorized" ? "signed in" : "sign-in required"}
                        </span>
                      ) : null}
                      <span className="text-detail text-text-muted">
                        {server.toolNames.length} tool{server.toolNames.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {server.error ? (
                      <div
                        className="truncate text-detail text-danger"
                        title="Connection failed. Review this server definition and reconnect."
                      >
                        {server.error}
                      </div>
                    ) : server.toolNames.length > 0 ? (
                      <div className="truncate font-mono text-detail text-text-muted">
                        {server.toolNames.join(", ")}
                      </div>
                    ) : null}
                  </div>
                  {server.transport === "http" && server.auth && server.auth.status !== "none" ? (
                    server.auth.status === "authorized" ? (
                      <ControlButton
                        data-testid={`mcp-logout-${server.id}`}
                        className="rounded p-1 text-text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        title="Sign out"
                        aria-label={`Sign out of ${server.id}`}
                        onClick={() => void logout(server.id)}
                      >
                        <LogOut size={13} />
                      </ControlButton>
                    ) : (
                      <ControlButton
                        data-testid={`mcp-login-${server.id}`}
                        className="flex items-center gap-1 rounded-capsule px-2 py-1 text-detail font-medium text-accent hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        title="Sign in"
                        aria-label={`Sign in to ${server.id}`}
                        onClick={() => void beginLogin(server.id)}
                      >
                        <LogIn size={12} /> Sign in
                      </ControlButton>
                    )
                  ) : null}
                  <ControlButton
                    data-testid={`mcp-refresh-${server.id}`}
                    className="rounded p-1 text-text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    title="Reconnect"
                    aria-label={`Reconnect ${server.id}`}
                    onClick={() => void refresh(server.id)}
                  >
                    <RefreshCw size={13} />
                  </ControlButton>
                  {server.editable === true ? (
                    <ControlButton
                      ref={(element) => {
                        if (element) editToggleRefs.current.set(server.id, element);
                        else editToggleRefs.current.delete(server.id);
                      }}
                      data-testid={`mcp-edit-${server.id}`}
                      className="rounded p-1 text-text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      title={editingId === server.id ? "Close editor" : "Edit global definition"}
                      aria-label={
                        editingId === server.id
                          ? `Close MCP editor for ${server.id}`
                          : `Edit global MCP definition ${server.id}`
                      }
                      aria-expanded={editingId === server.id}
                      disabled={saving}
                      onClick={() => startEdit(server)}
                    >
                      <Pencil size={13} />
                    </ControlButton>
                  ) : null}
                  {server.editable !== false ? (
                    <ControlButton
                      data-testid={`mcp-remove-${server.id}`}
                      className="rounded p-1 text-text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      title="Remove global definition"
                      aria-label={`Remove global MCP definition ${server.id}`}
                      onClick={() => {
                        if (
                          confirm(
                            `Remove global MCP definition "${server.id}"? Existing assignments will show as missing unless another effective definition exists.`,
                          )
                        ) {
                          void remove(server.id);
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </ControlButton>
                  ) : null}
                </div>
                {login?.id === server.id ? (
                  <div
                    data-testid={`mcp-login-panel-${server.id}`}
                    className="mt-1 flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface-subtle px-3.5 py-3"
                  >
                    <div className="text-detail text-text-muted">
                      1. Open the authorization page and approve access:
                    </div>
                    <a
                      data-testid={`mcp-login-url-${server.id}`}
                      href={login.authUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-mono text-detail text-accent underline"
                    >
                      {login.authUrl}
                    </a>
                    <div className="text-detail text-text-muted">
                      2. Paste the code you were shown (or the full redirect URL):
                    </div>
                    <div className="flex gap-2">
                      <ControlInput
                        autoFocus
                        data-testid={`mcp-login-code-${server.id}`}
                        className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent"
                        placeholder="authorization code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submitCode();
                          if (e.key === "Escape") setLogin(null);
                        }}
                      />
                      <ControlButton
                        data-testid={`mcp-login-submit-${server.id}`}
                        className="rounded-capsule px-3 py-1.5 text-xs font-medium shadow-capsule disabled:opacity-40"
                        style={{
                          background:
                            "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                          color: "var(--color-accent-foreground)",
                        }}
                        disabled={!code.trim()}
                        onClick={() => void submitCode()}
                      >
                        Connect
                      </ControlButton>
                      <ControlButton
                        data-testid={`mcp-login-cancel-${server.id}`}
                        className="rounded-capsule px-2 py-1.5 text-xs text-text-muted hover:text-text-primary"
                        onClick={() => setLogin(null)}
                      >
                        Cancel
                      </ControlButton>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          {!loading &&
            missingAssignedServerIds.map((id) => (
              <div
                key={`missing-${id}`}
                className="flex items-center gap-3 overflow-hidden rounded-xl border border-danger bg-surface px-3.5 py-2.5"
                data-testid={`mcp-missing-${id}`}
                aria-busy={savingAssignments.has(id)}
              >
                <label className="flex shrink-0 items-center gap-1.5 text-detail text-text-muted">
                  <ControlInput
                    type="checkbox"
                    checked
                    ref={(element) => {
                      if (element) assignmentInputs.current.set(id, element);
                      else assignmentInputs.current.delete(id);
                    }}
                    disabled={savingAssignments.size > 0}
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    aria-label={`Remove missing MCP assignment ${id}`}
                    onChange={() => void assign(id, false)}
                  />
                  <span>{savingAssignments.has(id) ? "Saving…" : "Assigned"}</span>
                </label>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-primary" title={id}>
                    {id}
                  </div>
                  <div className="text-detail text-danger">
                    Assigned definition is missing. Add it to global or project .pi/mcp.json, or
                    unassign it.
                  </div>
                </div>
              </div>
            ))}
          {!loading && servers.length === 0 && missingAssignedServerIds.length === 0 && !adding ? (
            <div className="py-8 text-center text-sm text-text-muted" data-testid="mcp-empty">
              {currentProjectId
                ? "No configured MCP servers. Add a global definition or review this project's .pi/mcp.json."
                : "No global MCP servers. Add one to make it available for explicit project assignment."}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
