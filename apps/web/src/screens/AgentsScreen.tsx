import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ImagePlus,
  Pencil,
  Power,
  PowerOff,
  Plus,
  RefreshCw,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  agentMatchesFilter,
  AGENT_FILTERS,
  SUBAGENT_EXPECTED_OUTCOME_LABELS,
  type AgentFilter,
  type AgentInfo,
} from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { MarkdownDocument } from "@/design-system/markdown/MarkdownDocument";
import { openResourceFile, revealResourceFile } from "../lib/native.ts";
import { responseErrorMessage } from "../lib/responseError.ts";
import { useAgentsCatalog } from "../state/useAgents.ts";
import { useAppStore } from "../state/store.ts";
import { deleteAgent, renameAgent, setAgentDisabled, updateProject } from "../state/wsBridge.ts";
import { AgentAvatar, agentSourceColor } from "../components/agents/AgentAvatar.tsx";
import { AgentEditSheet } from "../components/agents/AgentEditSheet.tsx";
import { ScopeChip } from "../components/ScopeChip.tsx";

/**
 * Native AgentsScreen: a fixed master-detail split (list 42% / detail 58%,
 * AppTheme.Split.listFraction) — sectioned avatar rows on the left, an
 * AppPage-style detail on the right, editing in a tabbed sheet.
 */

const SECTION_ORDER: Array<{ scope: AgentInfo["scope"]; title: string; hint?: string }> = [
  { scope: "project", title: "Project Agents" },
  { scope: "global", title: "Global Agents", hint: "available everywhere" },
  { scope: "library", title: "Library Agents" },
  { scope: "builtin", title: "Builtin Agents", hint: "bundled with Agent Deck" },
];

function AgentRow({
  agent,
  selected,
  onSelect,
  onEdit,
}: {
  agent: AgentInfo;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
        selected ? "border-selection-stroke bg-selection" : "border-transparent hover:bg-hover",
        (agent.shadowed || agent.disabled) && "opacity-60 saturate-50",
      )}
      data-testid="agent-row"
      data-agent-name={agent.name}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <AgentAvatar agent={agent} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-sm font-semibold text-text-primary"
            style={{ fontStretch: "expanded" }}
          >
            {agent.name}
          </span>
          <ScopeChip scope={agent.scope} />
          {agent.disabled ? (
            <span
              className="rounded-capsule border px-1.5 text-micro"
              style={{
                color: "var(--color-text-muted)",
                borderColor: "var(--color-border-strong)",
              }}
              data-testid="disabled-badge"
            >
              disabled
            </span>
          ) : null}
          {agent.overridden ? (
            <span
              className="text-micro"
              style={{ color: "var(--color-warning)" }}
              data-testid="overridden-badge"
            >
              overridden
            </span>
          ) : null}
          {agent.shadowed ? <span className="text-micro text-text-muted">shadowed</span> : null}
        </div>
        {agent.description ? (
          <div className="line-clamp-2 text-xs text-text-secondary">{agent.description}</div>
        ) : null}
      </div>
      <ControlButton
        data-testid={`agent-row-edit-${agent.name}`}
        className="rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary opacity-0 transition-opacity hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          onEdit();
        }}
      >
        Edit
      </ControlButton>
    </div>
  );
}

function ChipList({ label, items }: { label: string; items: string[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded-capsule border border-border-subtle bg-surface px-2 py-0.5 font-mono text-detail text-text-secondary"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function AgentDetail({
  agent,
  canCreateReplacement,
  onCreateReplacement,
  onEdit,
  availableCustomAgentNames = [],
}: {
  agent: AgentInfo;
  canCreateReplacement: boolean;
  onCreateReplacement: () => void;
  onEdit: () => void;
  /** Effective custom names used when a legacy-open project is curated for the first time. */
  availableCustomAgentNames?: string[];
}) {
  const projects = useAppStore((state) => state.projects);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const currentProject = projects.find((p) => p.id === currentProjectId);
  const isDefault = currentProject?.defaultAgentName === agent.name;
  const customAgent = agent.scope !== "builtin";
  const isAssigned =
    currentProject !== undefined &&
    (!customAgent ||
      currentProject.assignedAgentNames === undefined ||
      currentProject.assignedAgentNames.includes(agent.name));
  const toggleAssignment = (): void => {
    if (!currentProject || !customAgent || agent.shadowed) return;
    const current =
      currentProject.assignedAgentNames === undefined
        ? availableCustomAgentNames
        : currentProject.assignedAgentNames;
    const assignedAgentNames = isAssigned
      ? current.filter((name) => name !== agent.name)
      : [...current, agent.name];
    void updateProject(currentProject.id, { assignedAgentNames: [...new Set(assignedAgentNames)] });
  };
  // Inline rename (native RenameResourceSheet); value === null when not renaming.
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const avatarRequest = async (file: File): Promise<void> => {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      if (file.size < 1 || file.size > 15_000_000)
        throw new Error("Choose an image no larger than 15 MB.");
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type))
        throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("The image could not be read."));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      const separator = url.indexOf(",");
      if (separator < 0) throw new Error("The image could not be read.");
      const response = await fetch("/resources/agents/avatar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: currentProjectId ?? undefined,
          scope: agent.scope,
          name: agent.name,
          mimeType: file.type,
          data: url.slice(separator + 1),
        }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : String(error));
    } finally {
      setAvatarBusy(false);
      if (avatarInput.current) avatarInput.current.value = "";
    }
  };

  const removeAvatar = async (): Promise<void> => {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const response = await fetch("/resources/agents/avatar", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: currentProjectId ?? undefined,
          scope: agent.scope,
          name: agent.name,
        }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : String(error));
    } finally {
      setAvatarBusy(false);
    }
  };

  const submitRename = async (): Promise<void> => {
    const newName = (renameValue ?? "").trim();
    if (!newName || newName === agent.name) {
      setRenameValue(null);
      return;
    }
    if (await renameAgent(agent.scope, agent.name, newName)) setRenameValue(null);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="agent-detail">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex shrink-0 flex-col items-center gap-1.5">
          <AgentAvatar agent={agent} size={56} />
          <ControlInput
            ref={avatarInput}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            aria-label={`${agent.avatarUrl ? "Replace" : "Import"} avatar for ${agent.name}`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void avatarRequest(file);
            }}
          />
          <div className="flex gap-1">
            <ControlButton
              data-testid="agent-avatar-import"
              className="flex items-center gap-1 rounded-capsule border border-border-strong px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary disabled:opacity-40"
              disabled={avatarBusy}
              onClick={() => avatarInput.current?.click()}
            >
              <ImagePlus size={11} aria-hidden="true" />
              {agent.avatarUrl ? "Replace" : "Import"}
            </ControlButton>
            {agent.avatarUrl ? (
              <ControlButton
                data-testid="agent-avatar-remove"
                className="rounded-capsule border border-border-strong px-2 py-0.5 text-micro text-text-muted hover:text-danger disabled:opacity-40"
                disabled={avatarBusy}
                aria-label={`Remove avatar for ${agent.name}`}
                onClick={() => void removeAvatar()}
              >
                Remove
              </ControlButton>
            ) : null}
          </div>
        </div>
        <div className="min-w-[180px] flex-1">
          <div className="flex items-center gap-2">
            {renameValue !== null ? (
              <>
                <ControlInput
                  autoFocus
                  data-testid="agent-rename-input"
                  className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2 py-1 text-lg font-bold text-text-primary outline-none focus:border-accent"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitRename();
                    if (e.key === "Escape") setRenameValue(null);
                  }}
                />
                <ControlButton
                  data-testid="agent-rename-confirm"
                  className="rounded p-1 text-text-muted hover:text-accent"
                  title="Rename"
                  onClick={() => void submitRename()}
                >
                  <Check size={16} />
                </ControlButton>
                <ControlButton
                  data-testid="agent-rename-cancel"
                  className="rounded p-1 text-text-muted hover:text-text-primary"
                  title="Cancel"
                  onClick={() => setRenameValue(null)}
                >
                  <X size={16} />
                </ControlButton>
              </>
            ) : (
              <h2
                className="truncate text-xl font-bold text-text-primary"
                style={{ fontStretch: "expanded" }}
              >
                {agent.name}
              </h2>
            )}
            <ScopeChip scope={agent.scope} />
            {agent.replacesBuiltin ? (
              <span className="text-xs" style={{ color: "var(--color-warning)" }}>
                replaces builtin
              </span>
            ) : null}
          </div>
          {agent.description ? (
            <p className="mt-0.5 text-sm text-text-secondary">{agent.description}</p>
          ) : null}
        </div>
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2 max-[900px]:w-full">
          {currentProject && !agent.shadowed ? (
            <>
              {customAgent ? (
                <ControlButton
                  data-testid={`assigned-agent-${agent.name}`}
                  aria-pressed={isAssigned}
                  className={cn(
                    "flex items-center gap-1.5 rounded-capsule border px-2.5 py-1 text-xs",
                    isAssigned
                      ? "border-accent text-accent"
                      : "border-border-strong text-text-muted hover:text-text-primary",
                  )}
                  onClick={toggleAssignment}
                >
                  <Check size={12} aria-hidden="true" />
                  {isAssigned ? "assigned to project" : "assign to project"}
                </ControlButton>
              ) : (
                <span className="text-xs text-text-muted" data-testid="builtin-project-access">
                  available to every project
                </span>
              )}
              <ControlButton
                data-testid={`default-agent-${agent.name}`}
                className={cn(
                  "flex items-center gap-1.5 rounded-capsule border px-2.5 py-1 text-xs",
                  isDefault
                    ? "border-accent text-accent"
                    : "border-border-strong text-text-muted hover:text-text-primary",
                )}
                disabled={!isAssigned || agent.disabled}
                title={
                  !isAssigned
                    ? "Assign this agent to the project before making it the active-session default"
                    : undefined
                }
                onClick={() =>
                  void updateProject(currentProject.id, {
                    defaultAgentName: isDefault ? null : agent.name,
                  })
                }
              >
                <Star size={12} fill={isDefault ? "currentColor" : "none"} />
                {isDefault ? "active-session default" : "make session default"}
              </ControlButton>
            </>
          ) : null}
          <>
            {canCreateReplacement ? (
              <ControlButton
                data-testid="agent-create-replacement"
                className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                title="Create an editable global custom agent from this builtin"
                onClick={onCreateReplacement}
              >
                <RefreshCw size={12} />
                Replacement
              </ControlButton>
            ) : null}
            <ControlButton
              data-testid="agent-disable"
              className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
              onClick={() => void setAgentDisabled(agent.scope, agent.name, !agent.disabled)}
            >
              {agent.disabled ? <Power size={12} /> : <PowerOff size={12} />}
              {agent.disabled ? "Enable" : "Disable"}
            </ControlButton>
            <ControlButton
              data-testid="agent-edit"
              className="flex items-center gap-1.5 rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule"
              style={{
                background:
                  "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                color: "var(--color-accent-foreground)",
              }}
              onClick={onEdit}
            >
              <Pencil size={12} />
              Edit
            </ControlButton>
            {/* Rename moves a custom agent's file and re-points project
                  defaults. Builtins keep their name (it's the override key). */}
            {agent.scope !== "builtin" ? (
              <ControlButton
                data-testid="agent-rename"
                className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                onClick={() => setRenameValue(agent.name)}
              >
                <Tag size={12} />
                Rename
              </ControlButton>
            ) : null}
            {/* Delete removes a custom agent's file. Builtins are bundled
                  and can only be reset — offered just when overridden, so its
                  effect ("clear all overrides") is unambiguous. */}
            {agent.scope !== "builtin" ? (
              <ControlButton
                data-testid="agent-delete"
                className="rounded-capsule border border-border-strong p-1.5 text-text-muted hover:text-danger"
                title="Delete agent"
                onClick={() => {
                  if (confirm(`Delete agent "${agent.name}"? This removes its file.`)) {
                    void deleteAgent(agent.scope, agent.name);
                  }
                }}
              >
                <Trash2 size={13} />
              </ControlButton>
            ) : agent.overridden ? (
              <ControlButton
                data-testid="agent-reset"
                className="rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-muted hover:text-danger"
                title="Clear all overrides and restore the bundled defaults"
                onClick={() => {
                  if (
                    confirm(`Reset "${agent.name}" — clear all overrides and restore defaults?`)
                  ) {
                    void deleteAgent(agent.scope, agent.name);
                  }
                }}
              >
                Reset
              </ControlButton>
            ) : null}
          </>
        </div>
      </div>

      {avatarError ? (
        <div className="mt-3 text-sm" role="alert" style={{ color: "var(--color-role-error)" }}>
          {avatarError}
        </div>
      ) : null}

      <div className="mt-5 space-y-4">
        {canCreateReplacement ? (
          <div
            className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
            data-testid="agent-replacement-description"
          >
            <p className="text-sm text-text-secondary">
              Use Replacement to create a global custom agent seeded from this bundled agent. The
              builtin stays unchanged.
            </p>
          </div>
        ) : null}
        {agent.whenToUse ? (
          <div className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3">
            <div className="pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
              When to use
            </div>
            <p className="text-sm text-text-secondary">{agent.whenToUse}</p>
          </div>
        ) : null}

        <div className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3">
          <div className="flex items-center justify-between pb-2">
            <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
              System prompt
            </div>
            {/* Native "Prompt Mode" row (AgentManagementViews.swift:1335) surfaces
                the mode only when it's set. "replace" is pi's default (an absent
                mode launches as replace), so — like native, which hides the row
                for the implicit default — we badge only the notable "append"
                case: this body is added on top of pi's base prompt, not the
                whole prompt. */}
            {agent.systemPromptMode === "append" ? (
              <span
                data-testid="agent-prompt-mode"
                className="rounded-capsule border border-border-strong px-2 py-0.5 text-micro font-medium text-text-secondary"
                title="append — keeps pi's base system prompt and adds this agent's instructions on top"
              >
                append
              </span>
            ) : null}
          </div>
          <MarkdownDocument source={agent.body || "_(empty — pi's default prompt applies)_"} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3">
            <ChipList
              label="Tools"
              items={
                agent.tools?.length || agent.mcpDirectTools?.length
                  ? [
                      ...(agent.tools ?? []),
                      ...(agent.mcpDirectTools ?? []).map((name) => `mcp:${name}`),
                    ]
                  : ["pi defaults"]
              }
            />
          </div>
          <div className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3">
            <ChipList label="Skills" items={agent.skills?.length ? agent.skills : ["none"]} />
          </div>
          {agent.mcpServers?.length ? (
            <div
              className="col-span-2 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
              data-testid="agent-mcp-servers"
            >
              <ChipList label="MCP Servers" items={agent.mcpServers} />
            </div>
          ) : null}
          {/* Native "Fallback Models" config row (AgentManagementViews.swift:1333)
              — shown only when declared, like native's `if !isEmpty`. */}
          {agent.fallbackModels?.length ? (
            <div
              className="col-span-2 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
              data-testid="agent-fallback-models"
            >
              <ChipList label="Fallback Models" items={agent.fallbackModels} />
            </div>
          ) : null}
          {agent.scope !== "builtin" && agent.output ? (
            <div
              className="col-span-2 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
              data-testid="agent-output"
            >
              <div className="pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                Output Advisory
              </div>
              <div className="text-sm text-text-secondary">{agent.output}</div>
            </div>
          ) : null}
          {agent.defaultReads?.length ? (
            <div
              className="col-span-2 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
              data-testid="agent-default-reads"
            >
              <ChipList label="Default Reads" items={agent.defaultReads} />
            </div>
          ) : null}
          {agent.defaultExpectedOutcome ? (
            <div
              className="col-span-2 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
              data-testid="agent-default-outcome"
            >
              <div className="pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                Default Outcome
              </div>
              <div className="text-sm text-text-secondary">
                {SUBAGENT_EXPECTED_OUTCOME_LABELS[agent.defaultExpectedOutcome]}
              </div>
            </div>
          ) : null}
          <div
            className="col-span-2 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
            data-testid="agent-default-progress"
          >
            <div className="pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
              Default Progress
            </div>
            <div className="text-sm text-text-secondary">
              {agent.defaultProgress ? "Yes" : "No"}
            </div>
          </div>
          {agent.maxSubagentDepth !== undefined ? (
            <div
              className="col-span-2 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
              data-testid="agent-max-subagent-depth"
            >
              <div className="pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                Max Subagent Depth Metadata
              </div>
              <div className="text-sm text-text-secondary">{agent.maxSubagentDepth}</div>
            </div>
          ) : null}
          <div
            className="col-span-2 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
            data-testid="agent-interactive"
          >
            <div className="pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
              Interactive Metadata
            </div>
            <div className="text-sm text-text-secondary">{agent.interactive ? "Yes" : "No"}</div>
          </div>
          {agent.scope !== "builtin" ? (
            <div
              className="col-span-2 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
              data-testid="agent-extensions"
            >
              <div className="pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                Extensions
              </div>
              {agent.extensions === undefined ? (
                <div className="text-sm text-text-secondary">Default catalog policy</div>
              ) : agent.extensions.length === 0 ? (
                <div className="text-sm text-text-secondary">None (explicit)</div>
              ) : (
                <div className="space-y-1">
                  <div className="text-sm text-text-secondary">
                    {agent.extensions.length} selected
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {agent.extensions.map((extension) => (
                      <span
                        key={extension}
                        title={extension}
                        className="max-w-full truncate rounded-capsule border border-border-subtle bg-surface px-2 py-0.5 font-mono text-detail text-text-secondary"
                      >
                        {extension}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-4 text-xs text-text-muted">
          <div>
            model: <span className="font-mono">{agent.model ?? "pi default"}</span>
            {agent.thinking ? <span className="font-mono">:{agent.thinking}</span> : null}
          </div>
          <div className="truncate" title={agent.filePath}>
            {agent.filePath}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentsScreen() {
  const {
    agents,
    loaded,
    projectId: loadedProjectId,
  } = useAgentsCatalog({
    includeUnassigned: true,
  });
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const resourceRequest = useAppStore((state) => state.resourceCommandRequest);
  const selectedAgentFilePath = useAppStore((state) => state.selectedAgentFilePath);
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(selectedAgentFilePath);
  const [editing, setEditing] = useState<AgentInfo | null | "new" | { replacement: AgentInfo }>(
    null,
  );

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return agents.filter(
      (agent) =>
        agentMatchesFilter(agent, filter) &&
        (query === "" ||
          agent.name.toLowerCase().includes(query) ||
          (agent.description ?? "").toLowerCase().includes(query)),
    );
  }, [agents, filter, search]);

  useEffect(() => {
    setSelectedKey(selectedAgentFilePath);
  }, [selectedAgentFilePath]);

  const selected =
    visible.find((a) => a.filePath === selectedKey) ??
    visible.find((a) => !a.shadowed) ??
    visible[0] ??
    null;

  useEffect(() => {
    if (!resourceRequest?.action.startsWith("agent.")) return;
    if (currentProjectId !== resourceRequest.projectId) {
      useAppStore.getState().clearResourceCommandRequest(resourceRequest.token);
      return;
    }
    const store = useAppStore.getState();
    if (resourceRequest.action === "agent.new") {
      store.clearResourceCommandRequest(resourceRequest.token);
      setEditing("new");
      return;
    }
    if (!loaded || loadedProjectId !== resourceRequest.projectId) return;
    store.clearResourceCommandRequest(resourceRequest.token);
    const target = resourceRequest.filePath
      ? agents.find((agent) => agent.filePath === resourceRequest.filePath)
      : undefined;
    if (!target) {
      store.pushToast({ kind: "info", message: "Select an agent first." });
      return;
    }
    if (resourceRequest.action === "agent.toggleDisabled") {
      void setAgentDisabled(target.scope, target.name, !target.disabled);
      return;
    }
    const request = {
      kind: "agent" as const,
      projectId: resourceRequest.projectId,
      filePath: target.filePath,
    };
    void (
      resourceRequest.action === "agent.openFile"
        ? openResourceFile(request)
        : revealResourceFile(request)
    ).then((available) => {
      if (!available) {
        useAppStore.getState().pushToast({
          kind: "info",
          message: "Opening resource files is unavailable in this browser.",
        });
      }
    });
  }, [agents, currentProjectId, loaded, loadedProjectId, resourceRequest]);

  const selectAgent = (filePath: string): void => {
    setSelectedKey(filePath);
    useAppStore.getState().setSelectedAgentFilePath(filePath);
  };
  const replacementSeed =
    typeof editing === "object" && editing !== null && "replacement" in editing
      ? editing.replacement
      : undefined;

  return (
    <div className="flex min-h-0 flex-1 max-[900px]:flex-col" data-testid="agents-screen">
      {/* List pane — native fixed 42% split. */}
      <div className="flex w-[42%] min-w-[320px] flex-col border-r border-border-subtle max-[900px]:h-[38%] max-[900px]:w-full max-[900px]:min-w-0 max-[900px]:border-b max-[900px]:border-r-0">
        <div className="space-y-2 px-3 pb-2 pt-3">
          <div className="flex items-center gap-2">
            <ControlInput
              data-testid="agent-search"
              className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="Search agents"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <ControlButton
              data-testid="new-agent"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full shadow-capsule"
              style={{
                background:
                  "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                color: "var(--color-accent-foreground)",
              }}
              title="New agent"
              onClick={() => setEditing("new")}
            >
              <Plus size={15} />
            </ControlButton>
          </div>
          <div className="flex flex-wrap gap-1">
            {AGENT_FILTERS.map((f) => (
              <ControlButton
                key={f}
                data-testid={`agent-filter-${f}`}
                className={cn(
                  "rounded-capsule px-2.5 py-0.5 text-xs",
                  filter === f
                    ? "bg-selection text-text-primary"
                    : "text-text-muted hover:bg-hover",
                )}
                onClick={() => setFilter(f)}
              >
                {f}
              </ControlButton>
            ))}
          </div>
        </div>
        <div
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-4"
          role="listbox"
          aria-label="Agents"
        >
          {SECTION_ORDER.map(({ scope, title, hint }) => {
            const sectionAgents = visible.filter((agent) => agent.scope === scope);
            if (sectionAgents.length === 0) return null;
            return (
              <div key={scope}>
                <div className="flex items-baseline gap-2 px-1 pb-1 pt-2">
                  <span
                    className="text-micro font-semibold uppercase tracking-wider"
                    style={{ color: agentSourceColor({ scope }) }}
                  >
                    {title}
                  </span>
                  {hint ? <span className="text-micro text-text-muted">{hint}</span> : null}
                </div>
                <div className="space-y-1">
                  {sectionAgents.map((agent) => (
                    <AgentRow
                      key={agent.filePath}
                      agent={agent}
                      selected={selectedKey === agent.filePath}
                      onSelect={() => selectAgent(agent.filePath)}
                      onEdit={() => {
                        selectAgent(agent.filePath);
                        setEditing(agent);
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {visible.length === 0 ? (
            <div className="mt-8 text-center text-sm text-text-muted">
              No agents match this filter.
            </div>
          ) : null}
        </div>
      </div>

      {/* Detail pane */}
      {selected ? (
        <AgentDetail
          agent={selected}
          canCreateReplacement={
            selected.scope === "builtin" &&
            !selected.shadowed &&
            !agents.some(
              (agent) =>
                agent.name === selected.name &&
                (agent.scope === "global" || agent.scope === "project"),
            )
          }
          onCreateReplacement={() => setEditing({ replacement: selected })}
          onEdit={() => setEditing(selected)}
          availableCustomAgentNames={[
            ...new Set(
              agents
                .filter((agent) => agent.scope !== "builtin" && !agent.shadowed && !agent.disabled)
                .map((agent) => agent.name),
            ),
          ]}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
          Select an agent.
        </div>
      )}

      {editing !== null ? (
        <AgentEditSheet
          agent={editing === "new" || replacementSeed ? null : (editing as AgentInfo)}
          createFromBuiltin={replacementSeed}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
