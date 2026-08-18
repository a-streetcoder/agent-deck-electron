import { AppSegmentedPicker } from "@/design-system/components/AppSegmentedPicker";
import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, LogOut, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { responseErrorMessage } from "@/lib/responseError";
import { openExternal } from "@/lib/native";
import { useAppStore } from "../state/store.ts";
import { updateProject } from "../state/wsBridge.ts";

/**
 * MCP screen (native Runtime → MCP): the configured MCP servers whose tools are
 * proxied into pi sessions over the bridge. Each row shows live connection
 * status + the tools that connected; add a stdio or HTTP server, refresh, or
 * remove it. An http server behind OAuth also gets a Sign-in flow (native
 * MCPOAuthService): begin → open the browser → capture the hardened loopback
 * callback automatically, with progressive manual code/URL fallback.
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
  notice?: string;
  automatic?: boolean;
}

type McpDefinitionProvenance =
  | { source: "global" | "project"; path: string }
  | { source: "environment"; variable: "AGENT_DECK_MCP_SERVERS" };

interface McpServer {
  id: string;
  transport: McpTransport;
  connected: boolean;
  toolNames: string[];
  error?: string;
  auth?: McpAuth;
  source?: "global" | "project" | "environment";
  provenance?: McpDefinitionProvenance;
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

function provenancePresentation(server: McpServer): { label: string; detail?: string } | undefined {
  const source = server.provenance?.source ?? server.source;
  if (!source) return undefined;
  // A global definition is NOT automatically editable. Since the catalog began
  // reading `~/.config/mcp/mcp.json` as well (MCP-11), a global server can come
  // from a file this app never writes — Edit and Delete are already hidden for
  // it, so saying "editable" promised a change nothing would accept (MCP-09).
  const label =
    source === "global"
      ? server.editable === true
        ? "global config · editable"
        : "global config · read only"
      : source === "project"
        ? "project config · read only"
        : "environment · read only";
  const detail = server.provenance
    ? "path" in server.provenance
      ? server.provenance.path
      : server.provenance.variable
    : undefined;
  return { label, detail };
}

function McpProvenance({ server }: { server: McpServer }) {
  const provenance = provenancePresentation(server);
  if (!provenance) return null;
  const accessibleDetail = provenance.detail
    ? `${provenance.label}: ${provenance.detail}`
    : provenance.label;
  return (
    <div
      data-testid={`mcp-provenance-${server.id}`}
      className="mt-0.5 min-w-0 text-detail text-text-muted"
      aria-label={accessibleDetail}
    >
      <span className="block">{provenance.label}</span>
      {provenance.detail ? (
        <span className="block truncate font-mono" title={provenance.detail}>
          {provenance.detail}
        </span>
      ) : null}
    </div>
  );
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
  projectId: string;
  authUrl: string;
  state: string;
  automatic: boolean;
  manual: boolean;
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
  const [mcpEnabled, setMcpEnabled] = useState<boolean | null>(null);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [assignedServerIds, setAssignedServerIds] = useState<string[]>([]);
  const [defaultAssignedServerIds, setDefaultAssignedServerIds] = useState<string[]>([]);
  const [missingAssignedServerIds, setMissingAssignedServerIds] = useState<string[]>([]);
  const [missingDefaultAssignedServerIds, setMissingDefaultAssignedServerIds] = useState<string[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false);
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
  const [loginPendingId, setLoginPendingId] = useState<string | null>(null);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [code, setCode] = useState("");
  const loadSeq = useRef(0);
  const policySeq = useRef(0);
  const policySwitchRef = useRef<HTMLInputElement>(null);
  const loadedProject = useRef<string | null | undefined>(undefined);
  const assignmentSaving = useRef(false);
  const assignmentInputs = useRef(new Map<string, HTMLInputElement>());
  const defaultAssignmentInputs = useRef(new Map<string, HTMLInputElement>());
  const addToggleRef = useRef<HTMLButtonElement>(null);
  const editToggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const loginButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const loginRef = useRef<LoginFlow | null>(null);
  const loginRequestRef = useRef<{ seq: number; id: string; projectId: string } | null>(null);
  const pendingLoginRef = useRef<string | null>(null);
  const loginSubmittingRef = useRef(false);
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
            mcpEnabled?: boolean;
            assignedServerIds?: string[];
            defaultAssignedServerIds?: string[];
            missingAssignedServerIds?: string[];
            missingDefaultAssignedServerIds?: string[];
          };
          if (seq !== loadSeq.current) return "superseded";
          setCatalogLoadFailed(false);
          setMcpEnabled(data.mcpEnabled !== false);
          setServers((current) => {
            if (!preserveRows) return data.servers;
            const incoming = new Map(data.servers.map((server) => [server.id, server]));
            return current.map((server) => incoming.get(server.id) ?? server);
          });
          setAssignedServerIds(data.assignedServerIds ?? []);
          setDefaultAssignedServerIds(data.defaultAssignedServerIds ?? []);
          setMissingAssignedServerIds(data.missingAssignedServerIds ?? []);
          setMissingDefaultAssignedServerIds(data.missingDefaultAssignedServerIds ?? []);
          return "applied";
        } catch (err) {
          if (seq !== loadSeq.current) return "superseded";
          setCatalogLoadFailed(true);
          setServers([]);
          setAssignedServerIds([]);
          setDefaultAssignedServerIds([]);
          setMissingAssignedServerIds([]);
          setMissingDefaultAssignedServerIds([]);
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
    loginRef.current = login;
  }, [login]);

  useEffect(() => {
    return () => {
      const flow = loginRef.current;
      ++loginSeq.current;
      loginRequestRef.current = null;
      pendingLoginRef.current = null;
      loginSubmittingRef.current = false;
      loginRef.current = null;
      setLoginPendingId(null);
      setLoginSubmitting(false);
      if (!flow) return;
      void fetch(
        `/mcp/${encodeURIComponent(flow.id)}/login?projectId=${encodeURIComponent(flow.projectId)}`,
        { method: "DELETE" },
      );
    };
  }, [currentProjectId]);

  useEffect(() => {
    if (!login) return;
    const server = servers.find((item) => item.id === login.id);
    if (server?.auth?.status !== "authorized") return;
    ++loginSeq.current;
    pushToast({ kind: "success", message: `Signed in to ${login.id}` });
    loginSubmittingRef.current = false;
    setLoginSubmitting(false);
    setLogin(null);
    setCode("");
  }, [login, pushToast, servers]);

  useEffect(() => {
    const preserveRows = loadedProject.current === currentProjectId;
    if (loadedProject.current !== currentProjectId) {
      ++loginSeq.current;
      setLogin(null);
      setCode("");
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

  const awaitAuthoritativeLoad = async (
    pending: Promise<CatalogLoadResult>,
  ): Promise<CatalogLoadResult> => {
    for (;;) {
      const result = await pending;
      if (result !== "superseded") return result;
      const winner = latestLoad.current;
      if (!winner || winner === pending) return result;
      pending = winner;
    }
  };

  const togglePolicy = async (): Promise<void> => {
    if (policySaving || mcpEnabled === null) return;
    const seq = ++policySeq.current;
    const next = !mcpEnabled;
    const restoreFocus = document.activeElement === policySwitchRef.current;
    setPolicySaving(true);
    setPolicyError(null);
    try {
      const response = await fetch("/mcp/policy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const result = (await response.json()) as { mcpEnabled: boolean; warning?: string };
      if (seq !== policySeq.current) return;
      setMcpEnabled(result.mcpEnabled);
      if (result.warning) setPolicyError(result.warning);
      await awaitAuthoritativeLoad(load(true));
    } catch (error) {
      if (seq !== policySeq.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setPolicyError(message);
      setError(message);
      await awaitAuthoritativeLoad(load(true));
    } finally {
      if (seq === policySeq.current) {
        setPolicySaving(false);
        if (restoreFocus) requestAnimationFrame(() => policySwitchRef.current?.focus());
      }
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
    const requestProjectId = currentProjectId;
    assignmentSaving.current = true;
    const restoreFocus = assignmentInputs.current.get(id) === document.activeElement;
    const next = new Set(assignedServerIds);
    if (enabled) next.add(id);
    else next.delete(id);
    // Immediate controlled-state feedback; the id lock prevents stale rapid toggles.
    setAssignedServerIds([...next]);
    setSavingAssignments((current) => new Set(current).add(id));
    try {
      await updateProject(requestProjectId, { assignedMcpServers: [...next] });
      if (loadedProject.current !== requestProjectId) return;
      const authoritative = useAppStore
        .getState()
        .projects.find((project) => project.id === requestProjectId)?.assignedMcpServers;
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
      if (restoreFocus && loadedProject.current === requestProjectId) {
        setTimeout(() => {
          if (loadedProject.current === requestProjectId) assignmentInputs.current.get(id)?.focus();
        }, 0);
      }
    }
  };

  const assignDefault = async (id: string, enabled: boolean): Promise<void> => {
    if (assignmentSaving.current) return;
    const requestProjectId = currentProjectId;
    assignmentSaving.current = true;
    const savingKey = `default:${id}`;
    const restoreFocus = defaultAssignmentInputs.current.get(id) === document.activeElement;
    const previous = defaultAssignedServerIds;
    const next = new Set(previous);
    if (enabled) next.add(id);
    else next.delete(id);
    setDefaultAssignedServerIds([...next]);
    setSavingAssignments((current) => new Set(current).add(savingKey));
    try {
      const response = await fetch(`/mcp/${encodeURIComponent(id)}/default-assignment`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      if (loadedProject.current === requestProjectId) await load(true);
    } catch (error) {
      if (loadedProject.current === requestProjectId) {
        setDefaultAssignedServerIds(previous);
        setError(error instanceof Error ? error.message : String(error));
        await load(true);
      }
    } finally {
      assignmentSaving.current = false;
      setSavingAssignments((current) => {
        const updated = new Set(current);
        updated.delete(savingKey);
        return updated;
      });
      if (restoreFocus && loadedProject.current === requestProjectId) {
        setTimeout(() => {
          if (loadedProject.current === requestProjectId) {
            defaultAssignmentInputs.current.get(id)?.focus();
          }
        }, 0);
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

  // Begin OAuth: the backend starts its callback owner before returning the
  // authorization URL. The renderer opens it and shows waiting/manual fallback;
  // state parsed here is used only by that explicit manual completion path.
  const beginLogin = async (id: string): Promise<void> => {
    if (pendingLoginRef.current === id) return;
    const projectId = currentProjectId ?? "";
    const seq = ++loginSeq.current;
    loginRequestRef.current = { seq, id, projectId };
    pendingLoginRef.current = id;
    setLoginPendingId(id);
    const previous = loginRef.current;
    loginRef.current = null;
    setLogin(null);
    setCode("");
    try {
      if (previous) {
        await fetch(
          `/mcp/${encodeURIComponent(previous.id)}/login?projectId=${encodeURIComponent(previous.projectId)}`,
          { method: "DELETE" },
        );
      }
      if (seq !== loginSeq.current) return;
      const response = await fetch(
        `/mcp/${encodeURIComponent(id)}/login?projectId=${encodeURIComponent(projectId)}`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await response.text());
      const { auth } = (await response.json()) as { auth: McpAuth };
      if (!auth.authUrl) throw new Error("no authorization URL returned");
      const state = new URL(auth.authUrl).searchParams.get("state") ?? "";
      // A stale cross-server response owns a backend attempt that is no longer
      // represented in the UI, so explicitly revoke it. For a repeated same-id
      // request, the backend generation reservation already superseded it and a
      // DELETE here would incorrectly cancel the newer generation.
      if (seq !== loginSeq.current) {
        const latest = loginRequestRef.current;
        if (!latest || latest.id !== id || latest.projectId !== projectId) {
          await fetch(
            `/mcp/${encodeURIComponent(id)}/login?projectId=${encodeURIComponent(projectId)}`,
            { method: "DELETE" },
          );
        }
        return;
      }
      {
        const flow = {
          id,
          projectId: currentProjectId ?? "",
          authUrl: auth.authUrl,
          state,
          automatic: auth.automatic === true,
          manual: auth.automatic !== true,
        };
        setServers((current) =>
          current.map((server) => (server.id === id ? { ...server, auth } : server)),
        );
        loginRef.current = flow;
        setLogin(flow);
        // Purpose-built bridge validates http(s); the visible link remains the
        // fallback if the OS refuses to open a browser.
        void openExternal(auth.authUrl);
      }
    } catch (err) {
      if (seq === loginSeq.current) setError(String(err));
    } finally {
      if (seq === loginSeq.current) {
        pendingLoginRef.current = null;
        setLoginPendingId(null);
      }
    }
  };

  // Complete OAuth with the pasted code (or redirect URL) → the server exchanges
  // it and reconnects, so the server's tools register.
  const showManualLogin = (): void => {
    setLogin((flow) => (flow ? { ...flow, manual: true } : flow));
  };

  const submitCode = async (): Promise<void> => {
    const flow = login;
    if (!flow || loginSubmittingRef.current) return;
    const seq = loginSeq.current;
    const { code: parsedCode, state } = parseCallback(code, flow.state);
    if (!parsedCode) return;
    loginSubmittingRef.current = true;
    setLoginSubmitting(true);
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
      if (seq === loginSeq.current) setError(String(err));
    } finally {
      if (seq === loginSeq.current) {
        loginSubmittingRef.current = false;
        setLoginSubmitting(false);
      }
    }
  };

  const cancelLogin = async (): Promise<void> => {
    const flow = login;
    if (!flow) return;
    ++loginSeq.current;
    loginSubmittingRef.current = false;
    setLoginSubmitting(false);
    setLogin(null);
    setCode("");
    try {
      await fetch(
        `/mcp/${encodeURIComponent(flow.id)}/login?projectId=${encodeURIComponent(flow.projectId)}`,
        { method: "DELETE" },
      );
    } finally {
      requestAnimationFrame(() => loginButtonRefs.current.get(flow.id)?.focus());
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
        <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-text-secondary" aria-hidden />
            <h2
              className="text-base font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              MCP servers
            </h2>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="flex w-[6.75rem] shrink-0 items-center justify-center gap-2 rounded-capsule border border-border-subtle px-2.5 py-1 text-xs text-text-secondary">
              <ControlInput
                ref={policySwitchRef}
                type="checkbox"
                role="switch"
                data-testid="mcp-policy-switch"
                aria-label="MCP runtime availability"
                aria-describedby="mcp-policy-help mcp-policy-status"
                aria-busy={policySaving}
                checked={mcpEnabled === true}
                disabled={mcpEnabled === null || policySaving || loading || catalogLoadFailed}
                onChange={() => void togglePolicy()}
                className="h-4 w-4 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              <span className="inline-block min-w-[3.25rem] text-center">
                {policySaving
                  ? "Saving…"
                  : mcpEnabled === null
                    ? "Loading…"
                    : mcpEnabled
                      ? "On"
                      : "Paused"}
              </span>
            </label>
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
        <p id="mcp-policy-help" className="break-words text-xs text-text-muted">
          Pausing removes MCP from model runtimes while keeping servers, All Projects/project/agent
          assignments, and sign-ins unchanged.
        </p>
        <div
          id="mcp-policy-status"
          data-testid="mcp-policy-status"
          aria-live="polite"
          className={cn(
            "min-h-4 pb-1 text-xs",
            policyError ? "text-text-primary" : "text-text-muted",
          )}
        >
          {policyError ??
            (policySaving
              ? "Saving MCP availability…"
              : mcpEnabled === null
                ? "Loading MCP availability…"
                : mcpEnabled
                  ? "MCP is on."
                  : "MCP is paused.")}
        </div>
        <p className="break-words pb-3 text-xs text-text-muted" data-testid="mcp-trust-copy">
          {selectedProject
            ? `All Projects defaults and this project's explicit assignments are combined for ordinary ${selectedProject.name} chats. Named-agent chats use only that agent's MCP list. Project .pi/mcp.json definitions are read-only and may run repository-controlled commands; review them before assigning.`
            : "All Projects applies only to ordinary chats attached to a real project; no-project chats receive no MCP servers. Add and remove edit only your global ~/.pi/agent/mcp.json catalog."}
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
          {!loading && catalogLoadFailed ? (
            <div
              className="py-8 text-center text-sm text-danger"
              data-testid="mcp-load-error"
              role="alert"
            >
              MCP servers could not be loaded. Reload the catalog to try again.
            </div>
          ) : null}
          {!loading &&
            !catalogLoadFailed &&
            servers.map((server) => (
              <div key={server.id}>
                <div
                  data-testid={`mcp-${server.id}`}
                  data-connected={server.connected ? "true" : "false"}
                  data-assigned={
                    defaultAssignedServerIds.includes(server.id) ||
                    assignedServerIds.includes(server.id)
                      ? "true"
                      : "false"
                  }
                  className="flex min-w-0 flex-wrap items-center gap-3 overflow-hidden rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5"
                  aria-busy={
                    savingAssignments.has(server.id) ||
                    savingAssignments.has(`default:${server.id}`)
                  }
                >
                  <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <label className="flex items-center gap-1.5 text-detail text-text-muted">
                      <ControlInput
                        type="checkbox"
                        className="h-4 w-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        ref={(element) => {
                          if (element) defaultAssignmentInputs.current.set(server.id, element);
                          else defaultAssignmentInputs.current.delete(server.id);
                        }}
                        data-testid={`mcp-assign-all-${server.id}`}
                        aria-label={`All Projects MCP assignment for ${server.id}`}
                        aria-busy={savingAssignments.has(`default:${server.id}`)}
                        checked={defaultAssignedServerIds.includes(server.id)}
                        disabled={savingAssignments.size > 0}
                        onChange={(event) => void assignDefault(server.id, event.target.checked)}
                      />
                      <span aria-live="polite">
                        {savingAssignments.has(`default:${server.id}`)
                          ? "Saving All Projects…"
                          : "All Projects"}
                      </span>
                    </label>
                    {currentProjectId ? (
                      <label className="flex items-center gap-1.5 text-detail text-text-muted">
                        <ControlInput
                          type="checkbox"
                          className="h-4 w-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          ref={(element) => {
                            if (element) assignmentInputs.current.set(server.id, element);
                            else assignmentInputs.current.delete(server.id);
                          }}
                          data-testid={`mcp-assign-${server.id}`}
                          aria-busy={savingAssignments.has(server.id)}
                          aria-label={
                            defaultAssignedServerIds.includes(server.id)
                              ? `${server.id} is inherited from All Projects for ${selectedProject?.name ?? "project"}; explicit project assignment is ${assignedServerIds.includes(server.id) ? "retained" : "not set"}`
                              : `Assign ${server.id} to ${selectedProject?.name ?? "project"}`
                          }
                          aria-describedby={
                            defaultAssignedServerIds.includes(server.id)
                              ? `mcp-inherited-${server.id}`
                              : undefined
                          }
                          checked={
                            defaultAssignedServerIds.includes(server.id) ||
                            assignedServerIds.includes(server.id)
                          }
                          disabled={
                            defaultAssignedServerIds.includes(server.id) ||
                            savingAssignments.size > 0
                          }
                          onChange={(event) => void assign(server.id, event.target.checked)}
                        />
                        <span aria-live="polite">
                          {defaultAssignedServerIds.includes(server.id)
                            ? assignedServerIds.includes(server.id)
                              ? "Inherited · explicit assignment preserved"
                              : "Inherited · no explicit assignment"
                            : savingAssignments.has(server.id)
                              ? "Saving this project…"
                              : assignedServerIds.includes(server.id)
                                ? "Assigned"
                                : "This project"}
                        </span>
                        {defaultAssignedServerIds.includes(server.id) ? (
                          <span id={`mcp-inherited-${server.id}`} className="sr-only">
                            The project control is disabled while All Projects is enabled.
                            {assignedServerIds.includes(server.id)
                              ? " Its explicit project assignment is preserved."
                              : " It has no explicit project assignment."}
                          </span>
                        ) : null}
                      </label>
                    ) : null}
                  </div>
                  <div className="min-w-0 basis-40 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 overflow-hidden">
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
                          !mcpEnabled
                            ? "border-border-subtle text-text-muted"
                            : server.connected
                              ? "border-success text-success"
                              : currentProjectId &&
                                  !defaultAssignedServerIds.includes(server.id) &&
                                  !assignedServerIds.includes(server.id)
                                ? "border-border-subtle text-text-muted"
                                : "border-danger text-danger",
                        )}
                      >
                        {!mcpEnabled
                          ? "paused"
                          : server.connected
                            ? "connected"
                            : currentProjectId &&
                                !defaultAssignedServerIds.includes(server.id) &&
                                !assignedServerIds.includes(server.id)
                              ? "available"
                              : "disconnected"}
                      </span>
                      <span className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted">
                        {server.transport}
                      </span>
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
                    <McpProvenance server={server} />
                    {!mcpEnabled ? (
                      <div className="truncate text-detail text-text-muted">
                        Paused globally; configuration and sign-ins are preserved.
                      </div>
                    ) : server.error ? (
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
                        ref={(element) => {
                          if (element) loginButtonRefs.current.set(server.id, element);
                          else loginButtonRefs.current.delete(server.id);
                        }}
                        data-testid={`mcp-login-${server.id}`}
                        className="flex items-center gap-1 rounded-capsule px-2 py-1 text-detail font-medium text-accent hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        title="Sign in"
                        aria-label={`Sign in to ${server.id}`}
                        aria-busy={loginPendingId === server.id}
                        disabled={loginPendingId === server.id}
                        onClick={() => void beginLogin(server.id)}
                      >
                        <LogIn size={12} />
                        {loginPendingId === server.id ? "Starting…" : "Sign in"}
                      </ControlButton>
                    )
                  ) : null}
                  <ControlButton
                    data-testid={`mcp-refresh-${server.id}`}
                    className="rounded p-1 text-text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    title={mcpEnabled ? "Reconnect" : "MCP is paused; turn it on to reconnect"}
                    aria-label={
                      mcpEnabled
                        ? `Reconnect ${server.id}`
                        : `Reconnect ${server.id} unavailable while MCP is paused`
                    }
                    aria-busy={loginPendingId === server.id || login?.id === server.id}
                    disabled={
                      !mcpEnabled || loginPendingId === server.id || login?.id === server.id
                    }
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
                  {server.editable === true ? (
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
                    aria-busy={loginSubmitting}
                    className="mt-1 flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface-subtle px-3.5 py-3"
                  >
                    <div className="text-detail text-text-muted" role="status" aria-live="polite">
                      {loginSubmitting
                        ? "Submitting authorization code…"
                        : server.auth?.status === "error"
                          ? "Sign-in stopped."
                          : login.automatic
                            ? "Waiting for authorization in your browser…"
                            : "Open the authorization page and approve access:"}
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
                    {server.auth?.notice ? (
                      <div className="text-detail text-warning" role="status">
                        {server.auth.notice}
                      </div>
                    ) : null}
                    {server.auth?.status === "error" && server.auth.error ? (
                      <div className="flex flex-col items-start gap-2">
                        <div className="text-detail text-danger" role="alert">
                          {server.auth.error}
                        </div>
                        <ControlButton
                          data-testid={`mcp-login-restart-${server.id}`}
                          className="rounded-capsule px-3 py-1.5 text-xs font-medium text-accent hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          onClick={() => void beginLogin(server.id)}
                        >
                          Restart sign in
                        </ControlButton>
                      </div>
                    ) : login.manual ? (
                      <>
                        <div className="text-detail text-text-muted">
                          Paste the code you were shown (or the full redirect URL):
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
                              if (e.key === "Escape") void cancelLogin();
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
                            disabled={!code.trim() || loginSubmitting}
                            onClick={() => void submitCode()}
                          >
                            Connect
                          </ControlButton>
                          <ControlButton
                            data-testid={`mcp-login-cancel-${server.id}`}
                            className="rounded-capsule px-2 py-1.5 text-xs text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            disabled={loginSubmitting}
                            onClick={() => void cancelLogin()}
                          >
                            Cancel
                          </ControlButton>
                        </div>
                      </>
                    ) : (
                      <div className="flex gap-2">
                        <ControlButton
                          data-testid={`mcp-login-manual-${server.id}`}
                          className="rounded-capsule px-2 py-1.5 text-xs text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          disabled={loginSubmitting}
                          onClick={showManualLogin}
                        >
                          Enter code manually
                        </ControlButton>
                        <ControlButton
                          data-testid={`mcp-login-cancel-${server.id}`}
                          className="rounded-capsule px-2 py-1.5 text-xs text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          onClick={() => void cancelLogin()}
                        >
                          Cancel
                        </ControlButton>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          {!loading &&
            !catalogLoadFailed &&
            missingDefaultAssignedServerIds.map((id) => (
              <div
                key={`missing-default-${id}`}
                className="flex min-w-0 flex-wrap items-center gap-3 overflow-hidden rounded-xl border border-danger bg-surface px-3.5 py-2.5"
                data-testid={`mcp-missing-default-${id}`}
                aria-busy={savingAssignments.has(`default:${id}`)}
              >
                <label className="flex shrink-0 items-center gap-1.5 text-detail text-text-muted">
                  <ControlInput
                    type="checkbox"
                    checked
                    ref={(element) => {
                      if (element) defaultAssignmentInputs.current.set(id, element);
                      else defaultAssignmentInputs.current.delete(id);
                    }}
                    disabled={savingAssignments.size > 0}
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    aria-label={`Remove missing All Projects MCP assignment ${id}`}
                    onChange={() => void assignDefault(id, false)}
                  />
                  <span>{savingAssignments.has(`default:${id}`) ? "Saving…" : "All Projects"}</span>
                </label>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-primary" title={id}>
                    {id}
                  </div>
                  <div className="break-words text-detail text-danger">
                    Default assignment is missing a configured definition and grants no tools. Add
                    the definition or remove this All Projects assignment.
                  </div>
                </div>
              </div>
            ))}
          {!loading &&
            !catalogLoadFailed &&
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
                    disabled={defaultAssignedServerIds.includes(id) || savingAssignments.size > 0}
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    aria-label={
                      defaultAssignedServerIds.includes(id)
                        ? `${id} is inherited from All Projects; its missing explicit project assignment is retained`
                        : `Remove missing MCP assignment ${id}`
                    }
                    onChange={() => void assign(id, false)}
                  />
                  <span>
                    {defaultAssignedServerIds.includes(id)
                      ? "Inherited · explicit assignment preserved"
                      : savingAssignments.has(id)
                        ? "Saving…"
                        : "This project"}
                  </span>
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
          {!loading &&
          !catalogLoadFailed &&
          servers.length === 0 &&
          missingAssignedServerIds.length === 0 &&
          missingDefaultAssignedServerIds.length === 0 &&
          !adding ? (
            <div className="py-8 text-center text-sm text-text-muted" data-testid="mcp-empty">
              {currentProjectId
                ? "No configured MCP servers. Add a global definition or review this project's .pi/mcp.json."
                : "No global MCP servers. Add one to assign it to All Projects or specific projects."}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
