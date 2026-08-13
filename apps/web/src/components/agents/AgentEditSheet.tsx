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
  type AgentInfo,
  type ResourceScope,
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

type EditTab = "config" | "prompt" | "tools" | "skills" | "mcp";
const TABS: Array<{ id: EditTab; label: string }> = [
  { id: "config", label: "Config" },
  { id: "prompt", label: "Prompt" },
  { id: "tools", label: "Tools" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
];

const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

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
  const seed = agent ?? createFromBuiltin;
  const isReplacement = createFromBuiltin !== undefined;
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
  const [skills, setSkills] = useState((seed?.skills ?? []).join(", "));
  const [mcpServers, setMcpServers] = useState((seed?.mcpServers ?? []).join(", "));
  const [defaultExpectedOutcome, setDefaultExpectedOutcome] = useState<
    SubagentExpectedOutcome | ""
  >(seed?.defaultExpectedOutcome ?? "");
  const [body, setBody] = useState(seed?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

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
    skills: (seed?.skills ?? []).join(", "),
    mcpServers: (seed?.mcpServers ?? []).join(", "),
    defaultExpectedOutcome: seed?.defaultExpectedOutcome ?? "",
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
    skills !== initial.skills ||
    mcpServers !== initial.mcpServers ||
    defaultExpectedOutcome !== initial.defaultExpectedOutcome ||
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

  const isBuiltin = agent?.scope === "builtin";
  const parseList = (value: string): string[] =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      if (agent) {
        // Conflict guard: the sheet sends complete form state, so refuse to
        // save when the agent changed on disk since the sheet opened.
        const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
        const response = await fetch(`/resources/agents${query}`);
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
              (live.skills ?? []).join(", ") !== initial.skills ||
              (live.mcpServers ?? []).join(", ") !== initial.mcpServers ||
              (live.defaultExpectedOutcome ?? "") !== initial.defaultExpectedOutcome ||
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
            tools: parseList(tools),
            skills: parseList(skills),
            mcpServers: parseList(mcpServers),
            // Native exposes this authored default only for custom definitions.
            // Builtin edits continue to preserve any unmanaged override value.
            defaultExpectedOutcome: isBuiltin ? undefined : defaultExpectedOutcome,
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
              className="truncate text-sm font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              {agent
                ? `Edit ${agent.name}`
                : isReplacement
                  ? "New Custom Agent · Global"
                  : "New Agent"}
            </div>
            {isReplacement ? (
              <div className="text-xs text-text-muted">
                Seeded from builtin; saving creates a separate global file.
              </div>
            ) : isBuiltin ? (
              <div className="text-xs" style={{ color: "var(--color-warning)" }}>
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
          {TABS.map((t) => (
            <ControlButton
              key={t.id}
              data-testid={`editor-tab-${t.id}`}
              className={cn(
                "rounded-t-lg px-3 py-1.5 text-xs font-medium",
                tab === t.id
                  ? "border border-b-0 border-border-subtle bg-surface text-text-primary"
                  : "text-text-muted hover:text-text-primary",
              )}
              style={{ fontStretch: "expanded" }}
              onClick={() => setTab(t.id)}
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
                  <label className="text-xs text-text-muted">
                    Name
                    <ControlInput
                      ref={nameInputRef}
                      data-testid="editor-name"
                      className={inputClass}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="text-xs text-text-muted">
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
              <label className="block text-xs text-text-muted">
                Description
                <ControlInput
                  data-testid="editor-description"
                  className={inputClass}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label className="block text-xs text-text-muted">
                When to use
                <ControlInput
                  className={inputClass}
                  value={whenToUse}
                  onChange={(e) => setWhenToUse(e.target.value)}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-text-muted">
                  Model
                  <ControlInput
                    className={inputClass}
                    placeholder="Use Pi default"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                </label>
                <label className="text-xs text-text-muted">
                  Thinking
                  <ControlSelect
                    className={inputClass}
                    value={thinking}
                    onChange={(e) => setThinking(e.target.value)}
                  >
                    <option value="">Pi default</option>
                    {THINKING_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </ControlSelect>
                </label>
              </div>
              <label className="block text-xs text-text-muted">
                Fallback models (comma-separated; tried in order if the primary is unavailable)
                <ControlInput
                  data-testid="editor-fallback-models"
                  className={inputClass}
                  placeholder="anthropic/claude-sonnet-4, openai/gpt-4o…"
                  value={fallbackModels}
                  onChange={(e) => setFallbackModels(e.target.value)}
                />
              </label>
              {!isBuiltin ? (
                <label className="block text-xs text-text-muted">
                  Default outcome for managed delegation
                  <ControlSelect
                    data-testid="editor-default-outcome"
                    className={inputClass}
                    aria-describedby="editor-default-outcome-help"
                    value={defaultExpectedOutcome}
                    onChange={(event) =>
                      setDefaultExpectedOutcome(event.target.value as SubagentExpectedOutcome | "")
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
                    className="mt-1 block text-xs text-text-muted"
                  >
                    This adds outcome guidance only; it neither adds nor removes configured tools.
                    Edit files in worktree needs caller-selected worktree isolation, and
                    write/update project file needs a validated per-run output path.
                  </span>
                </label>
              ) : null}
            </>
          ) : null}

          {tab === "prompt" ? (
            <>
              <label className="block text-xs text-text-muted">
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
              <label className="block text-xs text-text-muted">
                System prompt (markdown)
                <ControlTextArea
                  data-testid="editor-body"
                  className={cn(inputClass, "min-h-[220px] font-mono text-caption")}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
            </>
          ) : null}

          {tab === "tools" ? (
            <div className="space-y-2">
              <label className="block text-xs text-text-muted">
                Tools (comma-separated; empty = Pi defaults)
                <ControlInput
                  data-testid="editor-tools"
                  className={inputClass}
                  aria-describedby="editor-tools-help"
                  placeholder="read, grep, mcp:search…"
                  value={tools}
                  onChange={(e) => setTools(e.target.value)}
                />
              </label>
              <p id="editor-tools-help" className="text-xs text-text-muted">
                Prefix an external Pi MCP adapter tool with mcp:. These names may be stale and do
                not connect or grant access to Agent Deck MCP servers.
              </p>
            </div>
          ) : null}

          {tab === "skills" ? (
            <label className="block text-xs text-text-muted">
              Skills (comma-separated names from the catalog)
              <ControlInput
                className={inputClass}
                value={skills}
                onChange={(e) => setSkills(e.target.value)}
              />
            </label>
          ) : null}

          {tab === "mcp" ? (
            <label className="block text-xs text-text-muted">
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
            <div className="text-sm" role="alert" style={{ color: "var(--color-role-error)" }}>
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
          <ControlButton
            className="rounded-capsule border border-border-strong px-4 py-1.5 text-sm text-text-secondary hover:text-text-primary"
            onClick={onClose}
          >
            Cancel
          </ControlButton>
          <ControlButton
            data-testid="editor-save"
            className="rounded-capsule px-4 py-1.5 text-sm font-medium shadow-capsule disabled:opacity-40"
            style={{
              background:
                "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
              color: "var(--color-accent-foreground)",
            }}
            disabled={saving || (!agent && !name.trim())}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </ControlButton>
        </div>
      </div>
    </div>
  );
}
