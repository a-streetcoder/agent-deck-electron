import {
  ControlButton,
  ControlInput,
  ControlTextArea,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, Brain, Pin, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { groupMemoriesByStatus, type MemoryStatus } from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { useAppStore } from "../state/store.ts";

/**
 * Memory screen (native Memory sidebar): browse and manage a project's stored
 * memories — the visible half of the memory subsystem. Agents write memories
 * during sessions via the bridge tools; here you inspect, pin, retire (stale),
 * archive, edit, delete, and manually add them. Project-scoped: no project, no
 * memory.
 */

const MEMORY_TYPES = ["context", "decision", "runbook", "failure", "preference"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

interface MemoryItem {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  updatedAt: string;
}

interface Draft {
  id?: string; // set when editing
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  projectId: string;
}

const STATUS_STYLE: Record<MemoryStatus, string> = {
  active: "border-border-subtle text-text-muted",
  pinned: "border-accent text-accent",
  stale: "border-warning text-warning",
  archived: "border-border-subtle text-text-muted opacity-70",
};

type SemanticPreferenceState = "loading" | "ready" | "error";

function SemanticMemoryPreference({ onChanged }: { onChanged: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<SemanticPreferenceState>("loading");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const seq = ++loadSeq.current;
    setState("loading");
    setMessage(null);
    try {
      const response = await fetch("/settings", { signal });
      if (!response.ok) throw new Error("We couldn’t load the semantic memory preference.");
      const data = (await response.json()) as {
        settings: { semanticMemoryEnabled: boolean };
      };
      if (seq !== loadSeq.current || signal?.aborted) return;
      setEnabled(data.settings.semanticMemoryEnabled);
      setState("ready");
    } catch (cause) {
      if (seq !== loadSeq.current || signal?.aborted) return;
      setState("error");
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      loadSeq.current += 1;
      controller.abort();
    };
  }, [load]);

  const toggle = async (): Promise<void> => {
    if (state !== "ready" || saving) return;
    const previous = enabled;
    const next = !previous;
    setEnabled(next);
    setSaving(true);
    setMessage("Saving…");
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ semanticMemoryEnabled: next }),
      });
      if (!response.ok) throw new Error("We couldn’t save the semantic memory preference.");
      const data = (await response.json()) as {
        settings: { semanticMemoryEnabled: boolean };
      };
      setEnabled(data.settings.semanticMemoryEnabled);
      setMessage("Saved");
      onChanged();
    } catch (cause) {
      setEnabled(previous);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="mb-4 rounded-xl border border-border-subtle bg-surface-elevated p-3"
      data-testid="semantic-memory-preference"
    >
      {state === "loading" ? (
        <p className="text-sm text-text-muted" role="status" data-testid="semantic-memory-loading">
          Loading semantic memory preference…
        </p>
      ) : state === "error" ? (
        <div data-testid="semantic-memory-load-error">
          <p className="text-sm text-danger" role="alert">
            {message}
          </p>
          <ControlButton
            className="mt-2 flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs text-text-primary"
            onClick={() => void load()}
          >
            <RefreshCw size={13} aria-hidden="true" /> Try again
          </ControlButton>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                Semantic ranking
                <span
                  className="rounded-capsule border border-border-subtle px-1.5 text-micro uppercase tracking-wider text-text-muted"
                  data-testid="semantic-memory-mode"
                >
                  {enabled ? "Requested" : "Not requested"}
                </span>
              </div>
              <p id="semantic-memory-description" className="mt-1 text-xs text-text-muted">
                Request semantic ranking for memory search and agent recall when it is available.
              </p>
            </div>
            <ControlButton
              role="switch"
              aria-label="Semantic ranking"
              aria-describedby="semantic-memory-description"
              aria-checked={enabled}
              data-testid="semantic-memory-toggle"
              disabled={saving}
              onClick={() => void toggle()}
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                enabled ? "border-accent bg-accent" : "border-border-strong bg-surface-muted",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                  enabled ? "translate-x-5" : "translate-x-0.5",
                )}
              />
            </ControlButton>
          </div>
          {message ? (
            <p
              className={cn(
                "mt-2 text-xs",
                message === "Saving…" || message === "Saved" ? "text-text-muted" : "text-danger",
              )}
              role={message === "Saving…" || message === "Saved" ? "status" : "alert"}
              data-testid="semantic-memory-save-status"
            >
              {message}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function MemoryScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const setError = useAppStore((state) => state.setError);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Monotonic request id: a slow response for a previously-selected project must
  // not clobber the list once a newer load (e.g. after switching projects) began.
  const loadSeq = useRef(0);
  // Recall search (native 11.8): runs the same recall engine the agent uses.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryItem[] | null>(null);
  const searchSeq = useRef(0);
  const [semanticPreferenceVersion, setSemanticPreferenceVersion] = useState(0);
  const semanticPreferenceChanged = useCallback((): void => {
    // Invalidate the old ranking immediately, then rerun a non-empty current
    // search under the newly persisted preference without a global resource
    // broadcast (which would incorrectly request Pi process replacement).
    searchSeq.current += 1;
    setSemanticPreferenceVersion((version) => version + 1);
  }, []);

  // Clearing the search or switching projects must invalidate any in-flight
  // request synchronously (bump the token) so a late response from the previous
  // query/project can't land and re-enter the recall-results branch — otherwise
  // an older fetch could clobber `null` back to `[]` or show stale hits.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !currentProjectId) {
      searchSeq.current += 1;
      setSearchResults(null);
      return;
    }
    const seq = ++searchSeq.current;
    void fetch(
      `/memory/search?projectId=${encodeURIComponent(currentProjectId)}&q=${encodeURIComponent(q)}`,
    )
      .then((r) => r.json() as Promise<{ memories?: MemoryItem[] }>)
      .then((data) => {
        if (seq === searchSeq.current) setSearchResults(data.memories ?? []);
      })
      .catch(() => {
        if (seq === searchSeq.current) setSearchResults([]);
      });
  }, [searchQuery, currentProjectId, resourcesVersion, semanticPreferenceVersion]);

  const load = useCallback(async (): Promise<void> => {
    if (!currentProjectId) {
      setMemories([]);
      return;
    }
    const seq = ++loadSeq.current;
    try {
      const response = await fetch(`/memory?projectId=${encodeURIComponent(currentProjectId)}`);
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { memories: MemoryItem[] };
      if (seq === loadSeq.current) setMemories(data.memories);
    } catch (err) {
      if (seq === loadSeq.current) setError(String(err));
    }
  }, [currentProjectId, setError]);

  useEffect(() => {
    void load();
  }, [load, resourcesVersion]);

  // useLayoutEffect (not useEffect) so the reset commits before paint — the
  // previous project's recall hits never flash under the new project.
  useLayoutEffect(() => {
    setDraft(null);
    // Drop the previous project's search so its recall hits can't render under
    // the new project before the re-keyed search effect resolves (native 11.8).
    searchSeq.current += 1;
    setSearchQuery("");
    setSearchResults(null);
  }, [currentProjectId]);

  const setStatus = async (id: string, status: MemoryStatus): Promise<void> => {
    if (!currentProjectId) return;
    try {
      const response = await fetch(`/memory/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: currentProjectId, status }),
      });
      if (!response.ok) throw new Error(await response.text());
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (!currentProjectId) return;
    try {
      const response = await fetch(
        `/memory/${id}?projectId=${encodeURIComponent(currentProjectId)}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) throw new Error(await response.text());
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const save = async (): Promise<void> => {
    if (!draft || !draft.title.trim() || !draft.summary.trim() || !draft.body.trim()) return;
    const fields = {
      type: draft.type,
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      body: draft.body.trim(),
    };
    try {
      const response = draft.id
        ? await fetch(`/memory/${draft.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId: draft.projectId, edit: fields }),
          })
        : await fetch("/memory", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId: draft.projectId, ...fields }),
          });
      if (!response.ok) throw new Error(await response.text());
      setDraft(null);
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  if (!currentProjectId) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="memory-screen">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2 pb-1">
            <Brain size={16} className="text-text-secondary" aria-hidden />
            <h2 className="text-base font-semibold text-text-primary">Memory</h2>
          </div>
          <p className="pb-2 text-xs text-text-muted">
            Durable project knowledge agents recall across sessions.
          </p>
          <SemanticMemoryPreference onChanged={semanticPreferenceChanged} />
          <div
            className="py-10 text-center text-sm text-text-muted"
            data-testid="memory-no-project"
          >
            Memory is project-scoped. Open a project to see and manage its memories.
          </div>
        </div>
      </div>
    );
  }

  const startNew = (): void =>
    setDraft({ type: "context", title: "", summary: "", body: "", projectId: currentProjectId });

  const startEdit = (memory: MemoryItem): void =>
    setDraft({
      id: memory.id,
      type: memory.type,
      title: memory.title,
      summary: memory.summary,
      body: memory.body,
      projectId: currentProjectId,
    });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="memory-screen">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between pb-1">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-text-secondary" aria-hidden />
            <h2
              className="text-base font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              Memory
            </h2>
          </div>
          <ControlButton
            data-testid="memory-new"
            className="rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule"
            style={{
              background:
                "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
              color: "var(--color-accent-foreground)",
            }}
            onClick={startNew}
          >
            New memory
          </ControlButton>
        </div>
        <p className="pb-2 text-xs text-text-muted">
          Durable project knowledge agents recall across sessions. Active and pinned memories are
          injected; stale and archived are kept but not injected.
        </p>
        <SemanticMemoryPreference onChanged={semanticPreferenceChanged} />
        <ControlInput
          data-testid="memory-search"
          className="mb-3 w-full rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          placeholder="Search memories (recall ranking)…"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />

        {draft ? (
          <div
            className="mb-4 space-y-2 rounded-2xl border border-border-strong bg-surface-elevated p-4"
            data-testid="memory-editor"
          >
            <div className="flex gap-2">
              <ControlSelect
                data-testid="memory-type"
                className="rounded-lg border border-border-strong bg-surface px-2 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryType })}
              >
                {MEMORY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </ControlSelect>
              <ControlInput
                data-testid="memory-title"
                className="flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
                placeholder="title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
            <ControlInput
              data-testid="memory-summary"
              className="w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="summary (a retrieval key)"
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            />
            <ControlTextArea
              data-testid="memory-body"
              className="h-40 w-full resize-none rounded-lg border border-border-strong bg-surface p-3 font-mono text-sm text-text-primary outline-none focus:border-accent"
              placeholder="the durable content"
              spellCheck={false}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <div className="flex items-center justify-end gap-2">
              <ControlButton
                className="rounded-capsule px-3 py-1 text-xs text-text-secondary hover:text-text-primary"
                onClick={() => setDraft(null)}
              >
                Cancel
              </ControlButton>
              <ControlButton
                data-testid="memory-save"
                className="rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule disabled:opacity-40"
                style={{
                  background:
                    "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                  color: "var(--color-accent-foreground)",
                }}
                disabled={!draft.title.trim() || !draft.summary.trim() || !draft.body.trim()}
                onClick={() => void save()}
              >
                Save
              </ControlButton>
            </div>
          </div>
        ) : null}

        <div className="space-y-4" data-testid="memory-list">
          {(searchResults !== null
            ? searchResults.length
              ? [{ status: "recall", label: "Recall results", memories: searchResults }]
              : []
            : groupMemoriesByStatus(memories)
          ).map((group) => (
            <section key={group.status} data-testid={`memory-section-${group.status}`}>
              <div className="flex items-center gap-1.5 px-1 pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                {group.label}
                <span className="rounded-capsule border border-border-subtle px-1 tabular-nums normal-case">
                  {group.memories.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {group.memories.map((memory) => (
                  <div
                    key={memory.id}
                    data-testid={`memory-${memory.id}`}
                    data-status={memory.status}
                    className="group flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5"
                  >
                    <ControlButton
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      onClick={() => startEdit(memory)}
                    >
                      <span className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted">
                        {memory.type}
                      </span>
                      <span
                        data-testid="memory-status-chip"
                        className={cn(
                          "rounded-capsule border px-1.5 text-micro",
                          STATUS_STYLE[memory.status],
                        )}
                      >
                        {memory.status}
                      </span>
                      <span className="truncate text-sm font-medium text-text-primary">
                        {memory.title}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                        {memory.summary}
                      </span>
                    </ControlButton>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <ControlButton
                        data-testid={`memory-pin-${memory.id}`}
                        className={cn(
                          "rounded p-1 hover:text-accent",
                          memory.status === "pinned" ? "text-accent" : "text-text-muted",
                        )}
                        title={memory.status === "pinned" ? "Unpin" : "Pin"}
                        onClick={() =>
                          void setStatus(
                            memory.id,
                            memory.status === "pinned" ? "active" : "pinned",
                          )
                        }
                      >
                        <Pin size={13} />
                      </ControlButton>
                      {memory.status === "stale" || memory.status === "archived" ? (
                        <ControlButton
                          data-testid={`memory-activate-${memory.id}`}
                          className="rounded p-1 text-text-muted hover:text-accent"
                          title="Re-activate"
                          onClick={() => void setStatus(memory.id, "active")}
                        >
                          <RotateCcw size={13} />
                        </ControlButton>
                      ) : (
                        <ControlButton
                          data-testid={`memory-archive-${memory.id}`}
                          className="rounded p-1 text-text-muted hover:text-text-secondary"
                          title="Archive"
                          onClick={() => void setStatus(memory.id, "archived")}
                        >
                          <Archive size={13} />
                        </ControlButton>
                      )}
                      <ControlButton
                        data-testid={`memory-delete-${memory.id}`}
                        className="rounded p-1 text-text-muted hover:text-danger"
                        title="Delete"
                        onClick={() => {
                          if (confirm("Delete this memory? This removes its file from disk.")) {
                            void remove(memory.id);
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </ControlButton>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {searchResults !== null ? (
            searchResults.length === 0 ? (
              <div
                className="py-8 text-center text-sm text-text-muted"
                data-testid="memory-search-empty"
              >
                No memories recalled for this query.
              </div>
            ) : null
          ) : memories.length === 0 && !draft ? (
            <div className="py-8 text-center text-sm text-text-muted" data-testid="memory-empty">
              No memories yet. Agents add them as they work, or create one manually.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
