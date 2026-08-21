import {
  ControlButton,
  ControlInput,
  ControlTextArea,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  SUBAGENT_EXPECTED_OUTCOMES,
  SUBAGENT_EXPECTED_OUTCOME_LABELS,
  availableAgentToolNames,
  type AgentInfo,
  type ResourceScope,
  type SkillInfo,
  type SubagentExpectedOutcome,
} from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { responseErrorMessage } from "@/lib/responseError";
import { useAppStore } from "../../state/store.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";

/**
 * The native AgentEditSheet: a modal sheet with an AppSheetHeader (tinted
 * icon tile + title) and a Config / Prompt / Tools / Skills tab strip.
 */

type EditTab = "config" | "prompt" | "tools" | "skills" | "extensions" | "mcp";
const TABS: Array<{ id: EditTab; label: string }> = [
  { id: "config", label: "Config" },
  { id: "prompt", label: "Prompt" },
  { id: "tools", label: "Tools" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
  { id: "mcp", label: "MCP" },
];

const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-label text-text-primary outline-none focus:border-accent";

// Pi's full ladder. `max` was missing, so an agent storing it rendered a select
// with no matching option (Codex). Used only when the selected model's own
// supported levels are unknown.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * AGT-09: one model as both catalog routes report it. `supportedThinkingLevels`
 * is optional because only a live session's catalog carries it — Pi's
 * `--list-models` output, which discovery parses, has no per-model thinking map,
 * so a session-less editor legitimately does not know.
 */
interface ModelCatalogEntry {
  provider: string;
  id: string;
  supportedThinkingLevels?: string[];
}

/** How a model is named in this editor, matching the launch plan's `provider/id`. */
function modelKey(entry: ModelCatalogEntry): string {
  return `${entry.provider}/${entry.id}`;
}

interface ExtensionCatalogEntry {
  path: string;
  name: string;
  exists: boolean;
  disabled: boolean;
  source?: "discovered" | "added" | "settings" | "package";
  scope?: string;
  bridgeConflict?: string | null;
}

export function AgentEditSheet({
  agent,
  createFromBuiltin,
  onClose,
}: {
  /** Existing agent, or null to create a new one. */
  agent: AgentInfo | null;
  /** A pristine builtin used as the seed for a create-only global custom agent. */
  createFromBuiltin?: AgentInfo;
  onClose: () => void;
}) {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  // AGT-09: a live session's catalog is both cheaper than a discovery spawn and
  // the only source that reports per-model thinking levels.
  const sessionId = useAppStore((state) => state.session?.id ?? null);
  const seed = agent ?? createFromBuiltin;
  const isReplacement = createFromBuiltin !== undefined;
  const isBuiltin = agent?.scope === "builtin";
  const [tab, setTab] = useState<EditTab>("config");
  const [name, setName] = useState(seed?.name ?? "");
  const [scope, setScope] = useState<ResourceScope>(
    isReplacement ? "global" : (agent?.scope ?? "global"),
  );
  const [description, setDescription] = useState(seed?.description ?? "");
  const [whenToUse, setWhenToUse] = useState(seed?.whenToUse ?? "");
  const [model, setModel] = useState(seed?.model ?? "");
  const [fallbackModels, setFallbackModels] = useState((seed?.fallbackModels ?? []).join(", "));
  const [thinking, setThinking] = useState(seed?.thinking ?? "");
  const [mode, setMode] = useState<"replace" | "append">(seed?.systemPromptMode ?? "replace");
  const [tools, setTools] = useState(
    [...(seed?.tools ?? []), ...(seed?.mcpDirectTools ?? []).map((name) => `mcp:${name}`)].join(
      ", ",
    ),
  );
  const [toolsExplicit, setToolsExplicit] = useState(seed?.toolsExplicit === true);
  const [skills, setSkills] = useState((seed?.skills ?? []).join(", "));
  const [skillCatalog, setSkillCatalog] = useState<SkillInfo[]>([]);
  const [skillCatalogRequested, setSkillCatalogRequested] = useState(false);
  const [skillCatalogLoading, setSkillCatalogLoading] = useState(false);
  const [skillCatalogError, setSkillCatalogError] = useState<string | null>(null);
  const [useDefaultExtensions, setUseDefaultExtensions] = useState(seed?.extensions === undefined);
  const [extensions, setExtensions] = useState<string[]>(seed?.extensions ?? []);
  const [extensionCatalog, setExtensionCatalog] = useState<ExtensionCatalogEntry[]>([]);
  const [extensionCatalogRequested, setExtensionCatalogRequested] = useState(false);
  const [extensionCatalogLoading, setExtensionCatalogLoading] = useState(false);
  const [extensionLoadingMode, setExtensionLoadingMode] = useState<
    "useMyExtensions" | "agentDeckManaged"
  >("useMyExtensions");
  const [extensionCatalogError, setExtensionCatalogError] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState((seed?.mcpServers ?? []).join(", "));
  const [defaultReads, setDefaultReads] = useState((seed?.defaultReads ?? []).join("\n"));
  const [defaultExpectedOutcome, setDefaultExpectedOutcome] = useState<
    SubagentExpectedOutcome | ""
  >(seed?.defaultExpectedOutcome ?? "");
  const [defaultProgress, setDefaultProgress] = useState(seed?.defaultProgress ?? false);
  const [interactive, setInteractive] = useState(seed?.interactive ?? false);
  const [maxSubagentDepth, setMaxSubagentDepth] = useState(
    seed?.maxSubagentDepth === undefined ? "" : String(seed.maxSubagentDepth),
  );
  const [output, setOutput] = useState(seed?.output ?? "");
  const [body, setBody] = useState(seed?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // AGT-09: the live model catalog, so model names are chosen rather than typed
  // and a stale one is called out here instead of at launch.
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [modelCatalogRequested, setModelCatalogRequested] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const extensionCatalogSeq = useRef(0);
  const skillCatalogSeq = useRef(0);
  const modelCatalogSeq = useRef(0);

  // Snapshot of the managed fields at open time — used both for dirty
  // detection (backdrop/Escape only dismiss when clean) and for the
  // conflict check before save.
  const initial = useRef({
    name: seed?.name ?? "",
    scope: isReplacement ? "global" : (agent?.scope ?? "global"),
    description: seed?.description ?? "",
    whenToUse: seed?.whenToUse ?? "",
    model: seed?.model ?? "",
    fallbackModels: (seed?.fallbackModels ?? []).join(", "),
    thinking: seed?.thinking ?? "",
    mode: seed?.systemPromptMode ?? "replace",
    tools: [
      ...(seed?.tools ?? []),
      ...(seed?.mcpDirectTools ?? []).map((name) => `mcp:${name}`),
    ].join(", "),
    toolsExplicit: seed?.toolsExplicit === true,
    skills: (seed?.skills ?? []).join(", "),
    useDefaultExtensions: seed?.extensions === undefined,
    extensions: seed?.extensions ?? [],
    mcpServers: (seed?.mcpServers ?? []).join(", "),
    defaultReads: (seed?.defaultReads ?? []).join("\n"),
    defaultExpectedOutcome: seed?.defaultExpectedOutcome ?? "",
    defaultProgress: seed?.defaultProgress ?? false,
    interactive: seed?.interactive ?? false,
    maxSubagentDepth: seed?.maxSubagentDepth === undefined ? "" : String(seed.maxSubagentDepth),
    output: seed?.output ?? "",
    body: seed?.body ?? "",
  }).current;
  const dirty =
    name !== initial.name ||
    scope !== initial.scope ||
    description !== initial.description ||
    whenToUse !== initial.whenToUse ||
    model !== initial.model ||
    fallbackModels !== initial.fallbackModels ||
    thinking !== initial.thinking ||
    mode !== initial.mode ||
    tools !== initial.tools ||
    toolsExplicit !== initial.toolsExplicit ||
    skills !== initial.skills ||
    useDefaultExtensions !== initial.useDefaultExtensions ||
    extensions.join("\0") !== initial.extensions.join("\0") ||
    mcpServers !== initial.mcpServers ||
    defaultReads !== initial.defaultReads ||
    defaultExpectedOutcome !== initial.defaultExpectedOutcome ||
    defaultProgress !== initial.defaultProgress ||
    interactive !== initial.interactive ||
    maxSubagentDepth !== initial.maxSubagentDepth ||
    output !== initial.output ||
    body !== initial.body;

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Modal keyboard behavior: initial focus, Escape (when clean), focus trap.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter(
        (el) => !el.hasAttribute("disabled"),
      );
    // Create flows need a name before they can be saved. The tab strip appears
    // before the form fields in DOM order, so focus the seeded/editable name.
    (nameInputRef.current ?? focusables()[1])?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !dirtyRef.current) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // AGT-09 — the model catalog, read exactly the way ModelsScreen reads it: a
  // live session's own catalog when there is one (it alone reports per-model
  // thinking levels), and a discovery spawn otherwise. Best-effort: a failure
  // leaves the catalog empty, which degrades to the previous free-text
  // behaviour rather than blocking the edit.
  useEffect(() => {
    // Reading a running session's catalog is a plain request to a pi that is
    // already up, so it happens on open. Discovery SPAWNS one, so it waits until
    // the user actually engages a model field — opening this sheet must never
    // start a process on its own.
    const seq = ++modelCatalogSeq.current;
    const controller = new AbortController();
    // Drop the previous source's catalog FIRST. Keeping it while the new one
    // loads — or forever, if the new request fails — would validate this
    // session's models against another session's catalog, whose providers and
    // extensions can differ (Codex).
    setModelCatalog([]);
    if (!sessionId && !modelCatalogRequested) return;
    void (async () => {
      try {
        const response = sessionId
          ? await fetch(`/sessions/${encodeURIComponent(sessionId)}/models`, {
              signal: controller.signal,
            })
          : await fetch("/runtime/models/discover", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
              signal: controller.signal,
            });
        if (!response.ok) return;
        const data = (await response.json()) as { models?: ModelCatalogEntry[] };
        if (seq === modelCatalogSeq.current) setModelCatalog(data.models ?? []);
      } catch {
        // Leave the catalog empty; the fields stay usable without it.
      }
    })();
    return () => {
      controller.abort();
      if (modelCatalogSeq.current === seq) modelCatalogSeq.current += 1;
    };
  }, [sessionId, modelCatalogRequested, resourcesVersion]);

  useEffect(() => {
    if (!skillCatalogRequested) return;
    const seq = ++skillCatalogSeq.current;
    const controller = new AbortController();
    setSkillCatalog([]);
    setSkillCatalogError(null);
    setSkillCatalogLoading(true);
    void (async () => {
      try {
        const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
        const response = await fetch(`/resources/skills/visibility${query}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseErrorMessage(response));
        const data = (await response.json()) as { skills: SkillInfo[] };
        if (seq === skillCatalogSeq.current) setSkillCatalog(data.skills);
      } catch (error) {
        if (!controller.signal.aborted && seq === skillCatalogSeq.current) {
          setSkillCatalogError(String(error));
        }
      } finally {
        if (seq === skillCatalogSeq.current) setSkillCatalogLoading(false);
      }
    })();
    return () => {
      controller.abort();
      if (skillCatalogSeq.current === seq) skillCatalogSeq.current += 1;
    };
  }, [currentProjectId, resourcesVersion, skillCatalogRequested]);

  useEffect(() => {
    if (isBuiltin || !extensionCatalogRequested) return;
    const seq = ++extensionCatalogSeq.current;
    const controller = new AbortController();
    // Never present the previous project/version as the current picker, and do
    // not let explicit mode look like a settled empty catalog while loading.
    setExtensionCatalog([]);
    setExtensionLoadingMode("useMyExtensions");
    setExtensionCatalogError(null);
    setExtensionCatalogLoading(true);
    void (async () => {
      try {
        const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
        const response = await fetch(`/resources/extensions${query}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseErrorMessage(response));
        const data = (await response.json()) as {
          loadingMode?: "useMyExtensions" | "agentDeckManaged";
          extensions: ExtensionCatalogEntry[];
        };
        if (seq !== extensionCatalogSeq.current) return;
        setExtensionCatalog(data.extensions);
        setExtensionLoadingMode(data.loadingMode ?? "useMyExtensions");
      } catch (error) {
        if (!controller.signal.aborted && seq === extensionCatalogSeq.current) {
          setExtensionCatalogError(String(error));
        }
      } finally {
        if (seq === extensionCatalogSeq.current) setExtensionCatalogLoading(false);
      }
    })();
    return () => {
      controller.abort();
      if (extensionCatalogSeq.current === seq) extensionCatalogSeq.current += 1;
    };
  }, [currentProjectId, extensionCatalogRequested, isBuiltin, resourcesVersion]);

  const parseList = (value: string): string[] =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const selectedTools = parseList(tools);
  const selectedToolNames = new Set(selectedTools);
  const toolPickerOptions = availableAgentToolNames(selectedTools).filter(
    (name) => !selectedToolNames.has(name),
  );
  const extensionEntries = (() => {
    const byPath = new Map(extensionCatalog.map((entry) => [entry.path, entry]));
    for (const selected of extensions) {
      if (!byPath.has(selected)) {
        byPath.set(selected, {
          path: selected,
          name: selected.split(/[\\/]/).pop() || selected,
          exists: false,
          disabled: false,
        });
      }
    }
    return [...byPath.values()];
  })();
  const assignedSkillNames = [...new Set(parseList(skills))];
  // AGT-09 derived catalog state. A model the catalog does not know is REPORTED,
  // never rewritten: native keeps a stale model rather than dropping the user's
  // configuration, and the catalog can legitimately be empty (discovery failed,
  // or the provider is signed out).
  // Matched against the EXACT stored string, untrimmed: that string is what save
  // sends and what pi receives, so validating a tidied-up version of it would
  // clear the warning while persisting the untidy value (Codex).
  const catalogKnowsModel = (name: string): boolean =>
    modelCatalog.some((entry) => modelKey(entry) === name || entry.id === name);
  // A bare id is only resolved to a model when exactly ONE catalog entry claims
  // it. The editor cannot know which provider a bare id will launch under, so
  // when several expose the same id, resolving to the first would read another
  // provider's capabilities — a launch-facing field must not guess (Codex).
  const bareIdMatches = modelCatalog.filter((entry) => entry.id === model);
  const selectedCatalogModel =
    modelCatalog.find((entry) => modelKey(entry) === model) ??
    (bareIdMatches.length === 1 ? bareIdMatches[0] : undefined);
  const modelIsAmbiguous =
    modelCatalog.every((entry) => modelKey(entry) !== model) && bareIdMatches.length > 1;
  const modelIsStale = modelCatalog.length > 0 && model.length > 0 && !catalogKnowsModel(model);
  const staleFallbackModels = modelCatalog.length
    ? parseList(fallbackModels).filter((name) => !catalogKnowsModel(name))
    : [];
  // Only an unambiguously resolved model constrains the level list. An unknown
  // or ambiguous one means unknown capabilities, and hiding levels there would
  // be a guess.
  const supportedThinking = selectedCatalogModel?.supportedThinkingLevels;
  // `off` stays on the list. It is an explicit choice a model can support, and
  // it is NOT the same as the empty "Pi default" entry — dropping it left a
  // model whose only level is `off` with nothing to select, and made a stored
  // `off` render as "Pi default" (Codex).
  const offeredThinkingLevels = supportedThinking ?? THINKING_LEVELS;
  const thinkingUnsupported =
    supportedThinking !== undefined && thinking.length > 0 && !supportedThinking.includes(thinking);
  // A stored level the model does not offer is still shown, so the control
  // displays what will actually be saved. Without this the select falls back to
  // rendering nothing and reads as "Pi default" while persisting the real value
  // (Codex).
  const preservedThinkingLevel =
    thinking.length > 0 && !offeredThinkingLevels.includes(thinking) ? thinking : undefined;
  const extensionNameCounts = new Map<string, number>();
  for (const entry of extensionCatalog) {
    if (!entry.disabled) {
      extensionNameCounts.set(entry.name, (extensionNameCounts.get(entry.name) ?? 0) + 1);
    }
  }
  const toggleExtension = (filePath: string): void => {
    setExtensions((current) =>
      current.includes(filePath)
        ? current.filter((entry) => entry !== filePath)
        : [...current, filePath],
    );
  };

  const save = async (): Promise<void> => {
    if (extensionCatalogLoading || skillCatalogLoading) return;
    setSaving(true);
    setError(null);
    try {
      if (agent) {
        // Conflict guard: the sheet sends complete form state, so refuse to
        // save when the agent changed on disk since the sheet opened.
        const query = new URLSearchParams({ includeUnassigned: "true" });
        if (currentProjectId) query.set("projectId", currentProjectId);
        const response = await fetch(`/resources/agents?${query.toString()}`);
        if (response.ok) {
          const { agents } = (await response.json()) as { agents: AgentInfo[] };
          const live = agents.find((a) => a.name === agent.name && a.scope === agent.scope);
          if (
            live &&
            ((live.description ?? "") !== initial.description ||
              (live.whenToUse ?? "") !== initial.whenToUse ||
              (live.model ?? "") !== initial.model ||
              (live.fallbackModels ?? []).join(", ") !== initial.fallbackModels ||
              (live.thinking ?? "") !== initial.thinking ||
              live.systemPromptMode !== initial.mode ||
              [
                ...(live.tools ?? []),
                ...(live.mcpDirectTools ?? []).map((name) => `mcp:${name}`),
              ].join(", ") !== initial.tools ||
              (live.toolsExplicit === true) !== initial.toolsExplicit ||
              (live.skills ?? []).join(", ") !== initial.skills ||
              (live.extensions === undefined) !== initial.useDefaultExtensions ||
              (live.extensions ?? []).join("\0") !== initial.extensions.join("\0") ||
              (live.mcpServers ?? []).join(", ") !== initial.mcpServers ||
              (live.defaultReads ?? []).join("\n") !== initial.defaultReads ||
              (live.defaultExpectedOutcome ?? "") !== initial.defaultExpectedOutcome ||
              (live.defaultProgress ?? false) !== initial.defaultProgress ||
              (live.interactive ?? false) !== initial.interactive ||
              (live.maxSubagentDepth === undefined ? "" : String(live.maxSubagentDepth)) !==
                initial.maxSubagentDepth ||
              (live.output ?? "") !== initial.output ||
              live.body !== initial.body)
          ) {
            throw new Error(
              "This agent changed on disk while you were editing. Close the editor and reopen it to avoid overwriting those changes.",
            );
          }
        }
      }
      const response = await fetch("/resources/agents", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: currentProjectId ?? undefined,
          scope: agent ? agent.scope : scope,
          name: agent ? agent.name : name.trim(),
          createFromBuiltin: createFromBuiltin?.name,
          edit: {
            description,
            whenToUse,
            model,
            fallbackModels: parseList(fallbackModels),
            thinking,
            systemPromptMode: mode,
            tools: toolsExplicit ? parseList(tools) : undefined,
            skills: parseList(skills),
            // Builtin override support intentionally remains absent. For custom
            // agents null removes the field (defaults); [] is explicit none.
            extensions: isBuiltin ? undefined : useDefaultExtensions ? null : extensions,
            mcpServers: parseList(mcpServers),
            // Newline authoring keeps paths containing spaces intact. Builtins
            // use the normal effective diff override; bundled bytes stay pristine.
            defaultReads: defaultReads
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean),
            // Native exposes this authored default only for custom definitions.
            // Builtin edits continue to preserve any unmanaged override value.
            defaultExpectedOutcome: isBuiltin ? undefined : defaultExpectedOutcome,
            // Native exposes this only for custom definitions. Builtin saves
            // leave any same-named override key unmanaged and preserved.
            defaultProgress: isBuiltin ? undefined : defaultProgress,
            // Compatibility metadata has no Electron runtime consumer. Builtin
            // edits preserve any existing override instead of managing it here.
            interactive: isBuiltin ? undefined : interactive,
            // Compatibility metadata only; recursive child delegation remains blocked.
            maxSubagentDepth: isBuiltin
              ? undefined
              : maxSubagentDepth === ""
                ? ""
                : Number(maxSubagentDepth),
            // Native output is advisory metadata for named delegation only.
            // Builtin saves preserve any unmanaged override value.
            output: isBuiltin ? undefined : output,
            body,
          },
        }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-overlay p-8"
      onMouseDown={(event) => {
        // Backdrop dismisses only while the form is clean — a stray press
        // must never discard edits (Cancel is the explicit path).
        if (event.target === event.currentTarget && !dirty) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="flex max-h-[85vh] w-[560px] flex-col rounded-2xl border border-border-strong bg-surface-elevated shadow-elevated"
        data-testid="agent-editor"
        role="dialog"
        aria-busy={saving}
        aria-modal="true"
        aria-label={
          agent
            ? `Edit ${agent.name}`
            : isReplacement
              ? `Create global replacement for ${createFromBuiltin.name}`
              : "New agent"
        }
      >
        {/* Sheet header: tinted icon tile + title + Done (native AppSheetHeader). */}
        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
          <AgentAvatar agent={agent ?? { scope, name }} size={32} />
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-label font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              {agent
                ? `Edit ${agent.name}`
                : isReplacement
                  ? "New Custom Agent · Global"
                  : "New Agent"}
            </div>
            {isReplacement ? (
              <div className="text-detail text-text-muted">
                Seeded from builtin; saving creates a separate global file.
              </div>
            ) : isBuiltin ? (
              <div className="text-detail" style={{ color: "var(--color-warning)" }}>
                builtin — saved as override, file untouched
              </div>
            ) : null}
          </div>
          <ControlButton
            className="rounded-capsule p-1.5 text-text-muted hover:bg-hover hover:text-text-primary"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={15} />
          </ControlButton>
        </div>

        {/* Tab strip */}
        <div className="flex gap-1 border-b border-border-subtle px-4 pt-2">
          {TABS.filter((item) => !isBuiltin || item.id !== "extensions").map((t) => (
            <ControlButton
              key={t.id}
              data-testid={`editor-tab-${t.id}`}
              className={cn(
                "rounded-t-lg px-3 py-1.5 text-detail font-medium",
                tab === t.id
                  ? "border border-b-0 border-border-subtle bg-surface text-text-primary"
                  : "text-text-muted hover:text-text-primary",
              )}
              style={{ fontStretch: "expanded" }}
              onClick={() => {
                setTab(t.id);
                if (t.id === "extensions") setExtensionCatalogRequested(true);
                if (t.id === "skills") setSkillCatalogRequested(true);
              }}
            >
              {t.label}
            </ControlButton>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {tab === "config" ? (
            <>
              {!agent ? (
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-caption font-medium text-text-muted">
                    Name
                    <ControlInput
                      ref={nameInputRef}
                      data-testid="editor-name"
                      className={inputClass}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="text-caption font-medium text-text-muted">
                    Scope
                    {isReplacement ? (
                      <ControlInput
                        data-testid="editor-scope"
                        className={inputClass}
                        value="global"
                        readOnly
                        aria-description="Builtin replacements are saved as global custom agents"
                      />
                    ) : (
                      <ControlSelect
                        data-testid="editor-scope"
                        className={inputClass}
                        value={scope}
                        onChange={(e) => setScope(e.target.value as ResourceScope)}
                      >
                        <option value="global">global</option>
                        <option value="library">library</option>
                      </ControlSelect>
                    )}
                  </label>
                </div>
              ) : null}
              <label className="block text-caption font-medium text-text-muted">
                Description
                <ControlInput
                  data-testid="editor-description"
                  className={inputClass}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label className="block text-caption font-medium text-text-muted">
                When to use
                <ControlInput
                  className={inputClass}
                  value={whenToUse}
                  onChange={(e) => setWhenToUse(e.target.value)}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-caption font-medium text-text-muted">
                    Model
                    <ControlInput
                      data-testid="editor-model"
                      onFocus={() => setModelCatalogRequested(true)}
                      className={inputClass}
                      placeholder="Use Pi default"
                      list="editor-model-catalog"
                      aria-describedby={
                        modelIsStale || modelIsAmbiguous ? "editor-model-diagnostic" : undefined
                      }
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    />
                    {/* Suggestions rather than a hard picker: the catalog can be
                        empty (discovery failed, provider signed out), and a field
                        that refuses every value then would block the edit. */}
                    <datalist id="editor-model-catalog" data-testid="editor-model-catalog">
                      {modelCatalog.map((entry) => (
                        <option key={modelKey(entry)} value={modelKey(entry)} />
                      ))}
                    </datalist>
                  </label>
                  {/* Outside the label, and described rather than named: text
                      inside it joins the control's accessible name, so the field
                      would read as "Model This model is not in…" (Codex). */}
                  {modelIsStale || modelIsAmbiguous ? (
                    <span
                      id="editor-model-diagnostic"
                      data-testid="editor-model-diagnostic"
                      role="status"
                      className="mt-1 block text-micro text-warning"
                    >
                      {modelIsAmbiguous
                        ? `Ambiguous: ${bareIdMatches.length} providers offer this model id. Qualify it as provider/id to pin which one launches.`
                        : "This model is not in the current model catalog. The stale name is preserved until you remove or replace it."}
                    </span>
                  ) : null}
                </div>
                <div>
                  <label className="text-caption font-medium text-text-muted">
                    Thinking
                    <ControlSelect
                      data-testid="editor-thinking"
                      className={inputClass}
                      aria-describedby={
                        thinkingUnsupported ? "editor-thinking-diagnostic" : undefined
                      }
                      value={thinking}
                      onChange={(e) => setThinking(e.target.value)}
                    >
                      <option value="">Pi default</option>
                      {preservedThinkingLevel !== undefined ? (
                        <option value={preservedThinkingLevel}>
                          {preservedThinkingLevel} (unsupported)
                        </option>
                      ) : null}
                      {offeredThinkingLevels.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </ControlSelect>
                  </label>
                  {thinkingUnsupported ? (
                    <span
                      id="editor-thinking-diagnostic"
                      data-testid="editor-thinking-diagnostic"
                      role="status"
                      className="mt-1 block text-micro text-warning"
                    >
                      {/* Says only what is true: nothing in this app rewrites the
                          level, and the launch passes it straight to pi (Codex). */}
                      The selected model does not support “{thinking}”. Pick a listed level — this
                      is sent to Pi as written.
                    </span>
                  ) : null}
                </div>
              </div>
              <div>
                <label className="block text-caption font-medium text-text-muted">
                  Fallback models (comma-separated; tried in order if the primary is unavailable)
                  {/* No datalist here: browser completion replaces the WHOLE input
                      value, so picking a suggestion after an existing entry would
                      silently discard the earlier fallbacks (Codex). */}
                  <ControlInput
                    data-testid="editor-fallback-models"
                    onFocus={() => setModelCatalogRequested(true)}
                    className={inputClass}
                    placeholder="anthropic/claude-sonnet-4, openai/gpt-4o…"
                    aria-describedby={
                      staleFallbackModels.length > 0
                        ? "editor-fallback-models-diagnostic"
                        : undefined
                    }
                    value={fallbackModels}
                    onChange={(e) => setFallbackModels(e.target.value)}
                  />
                </label>
                {staleFallbackModels.length > 0 ? (
                  <span
                    id="editor-fallback-models-diagnostic"
                    data-testid="editor-fallback-models-diagnostic"
                    role="status"
                    className="mt-1 block text-micro text-warning"
                  >
                    Not in the current model catalog: {staleFallbackModels.join(", ")}. Stale names
                    are preserved until you remove or replace them.
                  </span>
                ) : null}
              </div>
              <label className="block text-caption font-medium text-text-muted">
                Default reads (one project-relative path per line)
                <ControlTextArea
                  data-testid="editor-default-reads"
                  className={cn(inputClass, "min-h-[88px] font-mono text-code")}
                  aria-describedby="editor-default-reads-help"
                  placeholder={"AGENTS.md\nsrc/main.ts"}
                  value={defaultReads}
                  onChange={(event) => setDefaultReads(event.target.value)}
                />
                <span
                  id="editor-default-reads-help"
                  className="mt-1 block text-caption text-text-muted"
                >
                  Read-first hints for named delegation. Contents are not preloaded; unsafe manually
                  authored entries are ignored independently.
                </span>
              </label>
              {!isBuiltin ? (
                <>
                  <label className="block text-caption font-medium text-text-muted">
                    Default outcome for managed delegation
                    <ControlSelect
                      data-testid="editor-default-outcome"
                      className={inputClass}
                      aria-describedby="editor-default-outcome-help"
                      value={defaultExpectedOutcome}
                      onChange={(event) =>
                        setDefaultExpectedOutcome(
                          event.target.value as SubagentExpectedOutcome | "",
                        )
                      }
                    >
                      <option value="">Unspecified (report only)</option>
                      {SUBAGENT_EXPECTED_OUTCOMES.map((outcome) => (
                        <option key={outcome} value={outcome}>
                          {SUBAGENT_EXPECTED_OUTCOME_LABELS[outcome]}
                        </option>
                      ))}
                    </ControlSelect>
                    <span
                      id="editor-default-outcome-help"
                      className="mt-1 block text-detail text-text-muted"
                    >
                      This adds outcome guidance only; it neither adds nor removes configured tools.
                      Edit files in worktree needs caller-selected worktree isolation, and
                      write/update project file needs a validated per-run output path.
                    </span>
                  </label>
                  <label className="block text-caption font-medium text-text-muted">
                    Output advisory
                    <ControlInput
                      data-testid="editor-output"
                      className={inputClass}
                      maxLength={1000}
                      aria-describedby="editor-output-help"
                      placeholder="e.g. concise review summary"
                      value={output}
                      onChange={(event) => setOutput(event.target.value)}
                    />
                    <span
                      id="editor-output-help"
                      className="mt-1 block text-caption text-text-muted"
                    >
                      Advisory guidance for named children only. It does not grant tools, authorize
                      a path, create a worktree, or select an Agent Deck artifact file.
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-caption font-medium text-text-muted">
                    <ControlInput
                      type="checkbox"
                      data-testid="editor-default-progress"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                      checked={defaultProgress}
                      aria-describedby="editor-default-progress-help"
                      onChange={(event) => setDefaultProgress(event.target.checked)}
                    />
                    <span>
                      <span className="block text-text-secondary">Default progress</span>
                      <span id="editor-default-progress-help" className="mt-1 block">
                        Portable metadata only. Agent Deck currently preserves and displays this
                        preference; it does not change progress reporting or child runtime behavior.
                      </span>
                    </span>
                  </label>
                  <label className="block text-caption font-medium text-text-muted">
                    Maximum subagent depth
                    <ControlInput
                      type="number"
                      min={0}
                      step={1}
                      data-testid="editor-max-subagent-depth"
                      className={inputClass}
                      aria-describedby="editor-max-subagent-depth-help"
                      placeholder="Unspecified"
                      value={maxSubagentDepth}
                      onChange={(event) => setMaxSubagentDepth(event.target.value)}
                    />
                    <span
                      id="editor-max-subagent-depth-help"
                      className="mt-1 block text-detail text-text-muted"
                    >
                      Compatibility metadata. Native’s editor offers 0 to 10, while higher
                      hand-authored non-negative values remain preservable. Agent Deck still blocks
                      recursive child delegation regardless of this value.
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-caption font-medium text-text-muted">
                    <ControlInput
                      type="checkbox"
                      data-testid="editor-interactive"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                      checked={interactive}
                      aria-describedby="editor-interactive-help"
                      onChange={(event) => setInteractive(event.target.checked)}
                    />
                    <span>
                      <span className="block text-text-secondary">Interactive</span>
                      <span id="editor-interactive-help" className="mt-1 block">
                        Compatibility metadata only. Agent Deck parses, preserves, and displays this
                        field; it does not enable prompts or change agent runtime behavior.
                      </span>
                    </span>
                  </label>
                </>
              ) : null}
            </>
          ) : null}

          {tab === "prompt" ? (
            <>
              <label className="block text-caption font-medium text-text-muted">
                Prompt mode
                <ControlSelect
                  className={inputClass}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "replace" | "append")}
                >
                  <option value="replace">Replace</option>
                  <option value="append">Append</option>
                </ControlSelect>
              </label>
              <label className="block text-caption font-medium text-text-muted">
                System prompt (markdown)
                <ControlTextArea
                  data-testid="editor-body"
                  className={cn(inputClass, "min-h-[220px] font-mono text-code")}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
            </>
          ) : null}

          {tab === "tools" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-detail text-text-secondary">Reset</div>
                  <div data-testid="editor-tools-mode" className="text-detail text-text-muted">
                    {!toolsExplicit
                      ? "Currently using Pi default tool access."
                      : selectedTools.length > 0
                        ? "Using an explicit tool allowlist."
                        : "Using an explicit tool allowlist that grants no tools."}
                  </div>
                </div>
                <ControlButton
                  type="button"
                  data-testid="editor-tools-reset"
                  className="rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-detail text-text-secondary hover:text-text-primary"
                  onClick={() => {
                    setTools("");
                    setToolsExplicit(false);
                  }}
                >
                  Reset Tool Access
                </ControlButton>
              </div>
              <label className="block text-caption font-medium text-text-muted">
                Add Tool
                <ControlSelect
                  data-testid="editor-tools-picker"
                  className={inputClass}
                  value=""
                  onChange={(event) => {
                    const name = event.target.value;
                    if (!name) return;
                    setTools(tools.trim().length === 0 ? name : `${tools}, ${name}`);
                    setToolsExplicit(true);
                  }}
                >
                  <option value="" disabled>
                    Choose Tool
                  </option>
                  {toolPickerOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </ControlSelect>
              </label>
              <div>
                <div className="text-detail text-text-muted">Selected</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {selectedTools.map((name, index) => (
                    <span
                      key={`${name}-${index}`}
                      className="flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-2 py-1 text-detail text-text-secondary"
                    >
                      <span className="max-w-[24ch] truncate">{name}</span>
                      <ControlButton
                        type="button"
                        data-testid={`editor-tools-remove-${name}`}
                        className="text-text-muted hover:text-danger"
                        aria-label={`Remove ${name} tool`}
                        onClick={() => {
                          // Removal must reserialize the free-text list; additions preserve it verbatim.
                          setTools(
                            selectedTools.filter((_, toolIndex) => toolIndex !== index).join(", "),
                          );
                          setToolsExplicit(true);
                        }}
                      >
                        <X size={12} />
                      </ControlButton>
                    </span>
                  ))}
                </div>
              </div>
              <label className="block text-caption font-medium text-text-muted">
                Tools (comma-separated; empty = no tools when explicitly edited)
                <ControlInput
                  data-testid="editor-tools"
                  className={inputClass}
                  aria-describedby="editor-tools-help"
                  placeholder="read, grep, mcp:search…"
                  value={tools}
                  onChange={(e) => {
                    setTools(e.target.value);
                    setToolsExplicit(true);
                  }}
                />
              </label>
              <p id="editor-tools-help" className="text-caption text-text-muted">
                Prefix an external Pi MCP adapter tool with mcp:. These names may be stale and do
                not connect or grant access to Agent Deck MCP servers.
              </p>
            </div>
          ) : null}

          {tab === "skills" ? (
            <div className="space-y-3" data-testid="editor-skills" aria-busy={skillCatalogLoading}>
              <label className="block text-caption font-medium text-text-muted">
                Skills (comma-separated bare names)
                <ControlInput
                  data-testid="editor-skills-input"
                  className={inputClass}
                  aria-describedby="editor-skills-help"
                  value={skills}
                  onChange={(e) => setSkills(e.target.value)}
                />
              </label>
              <p id="editor-skills-help" className="text-caption text-text-muted">
                Names resolve against global skills and the currently selected project. A project
                skill from another project is not visible here; duplicate visible names are
                ambiguous and block named launch.
              </p>
              {skillCatalogLoading ? (
                <div className="text-caption text-text-muted" role="status">
                  Loading skill catalog…
                </div>
              ) : skillCatalogError ? (
                <div className="text-caption text-danger" role="alert">
                  Skill catalog unavailable: {skillCatalogError}
                </div>
              ) : (
                <div className="space-y-1.5" aria-label="Assigned skill diagnostics">
                  {assignedSkillNames.map((skillName) => {
                    const candidates = skillCatalog.filter((item) => item.name === skillName);
                    const diagnostic =
                      candidates.length === 0
                        ? "Missing for the current project. The stale name is preserved until you remove or replace it."
                        : candidates.length > 1
                          ? `Ambiguous: ${candidates.length} visible catalog entries use this bare name. Rename a duplicate.`
                          : candidates[0]!.disabled
                            ? "Disabled in Skills. Named-agent launch refuses this assignment; ambient default/project assignments skip it. Enable it or remove it."
                            : candidates[0]!.scope === "package"
                              ? "Package-provided skill (read-only) visible to the current project."
                              : `${candidates[0]!.scope === "project" ? "Project" : "Global"} skill visible to the current project.`;
                    return (
                      <div
                        key={skillName}
                        className="rounded-lg border border-border-subtle bg-surface px-3 py-2"
                      >
                        <div className="font-mono text-code text-text-primary">{skillName}</div>
                        <div
                          className={cn(
                            "text-micro",
                            candidates.length === 1 && !candidates[0]!.disabled
                              ? "text-text-muted"
                              : "text-warning",
                          )}
                        >
                          {diagnostic}
                        </div>
                      </div>
                    );
                  })}
                  {assignedSkillNames.length === 0 ? (
                    <div className="text-detail text-text-muted">No explicit skills assigned.</div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {tab === "extensions" && !isBuiltin ? (
            <div
              className="space-y-3"
              data-testid="editor-extensions"
              aria-busy={extensionCatalogLoading}
            >
              <label className="flex items-start gap-2 text-caption font-medium text-text-muted">
                <ControlInput
                  type="checkbox"
                  data-testid="editor-extensions-default"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                  checked={useDefaultExtensions}
                  onChange={(event) => setUseDefaultExtensions(event.target.checked)}
                />
                <span>
                  <span className="block text-text-secondary">Use Default Extensions</span>
                  <span className="mt-1 block">
                    Uses the current enabled extension catalog. Turn this off to choose an explicit
                    allowlist; choosing none is supported.
                  </span>
                </span>
              </label>
              {!extensionCatalogLoading && extensionLoadingMode === "agentDeckManaged" ? (
                <div className="rounded-lg border border-warning px-3 py-2 text-detail text-warning">
                  Agent Deck managed loading mode currently blocks all user extensions, including
                  this agent’s selections.
                </div>
              ) : null}
              {extensionCatalogLoading ? (
                <div className="text-caption text-text-muted" role="status">
                  Loading extension catalog…
                </div>
              ) : extensionCatalogError ? (
                <div className="text-caption text-danger" role="alert">
                  Extension catalog unavailable: {extensionCatalogError}
                </div>
              ) : null}
              {!useDefaultExtensions && !extensionCatalogLoading ? (
                <div className="space-y-1.5" aria-label="Extension allowlist">
                  {extensionEntries.map((entry, index) => {
                    const selected = extensions.includes(entry.path);
                    const stale = !extensionCatalog.some((item) => item.path === entry.path);
                    const diagnostics = [
                      stale ? "not in current catalog; preserved but not loaded" : null,
                      !entry.exists ? "missing or not a file; not loaded" : null,
                      entry.disabled ? "disabled globally; not loaded" : null,
                      entry.bridgeConflict
                        ? `conflicts with Agent Deck bridge “${entry.bridgeConflict}”; not loaded`
                        : null,
                      (extensionNameCounts.get(entry.name) ?? 0) > 1
                        ? "same filename as another enabled catalog entry"
                        : null,
                    ].filter((value): value is string => Boolean(value));
                    return (
                      <label
                        key={entry.path}
                        className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2"
                      >
                        <ControlInput
                          type="checkbox"
                          data-testid={`editor-extension-${index}`}
                          data-extension-path={entry.path}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                          checked={selected}
                          onChange={() => toggleExtension(entry.path)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-detail text-text-primary">
                            {entry.name}
                          </span>
                          <span className="block truncate font-mono text-micro text-text-muted">
                            {entry.path}
                          </span>
                          <span className="block text-micro text-text-muted">
                            {stale
                              ? "hand-authored"
                              : entry.source === "added"
                                ? "added · global"
                                : entry.source === "settings"
                                  ? `${entry.scope === "project" ? "project" : "global"} · settings.json`
                                  : entry.source === "package"
                                    ? "package"
                                    : `${entry.scope === "project" ? "project" : "global"} · discovered`}
                          </span>
                          {diagnostics.map((diagnostic) => (
                            <span key={diagnostic} className="block text-micro text-warning">
                              {diagnostic}
                            </span>
                          ))}
                        </span>
                      </label>
                    );
                  })}
                  {extensionEntries.length === 0 ? (
                    <div className="rounded-lg border border-border-subtle px-3 py-4 text-center text-detail text-text-muted">
                      No catalog extensions are available. Saving keeps an explicit empty allowlist.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "mcp" ? (
            <label className="block text-caption font-medium text-text-muted">
              MCP servers (comma-separated names from mcp.json this agent uses)
              <ControlInput
                data-testid="editor-mcp"
                className={inputClass}
                placeholder="github, linear…"
                value={mcpServers}
                onChange={(e) => setMcpServers(e.target.value)}
              />
            </label>
          ) : null}

          {error ? (
            <div className="text-body" role="alert" style={{ color: "var(--color-role-error)" }}>
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
          <ControlButton
            className="rounded-capsule border border-border-strong px-4 py-1.5 text-label text-text-secondary hover:text-text-primary"
            onClick={onClose}
          >
            Cancel
          </ControlButton>
          <ControlButton
            data-testid="editor-save"
            className="rounded-capsule px-4 py-1.5 text-label font-medium shadow-capsule disabled:opacity-40"
            style={{
              background:
                "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
              color: "var(--color-accent-foreground)",
            }}
            disabled={
              saving || extensionCatalogLoading || skillCatalogLoading || (!agent && !name.trim())
            }
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </ControlButton>
        </div>
      </div>
    </div>
  );
}
