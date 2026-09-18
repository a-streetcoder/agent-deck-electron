import { useState } from "react";
import type { McpImportEntry, McpImportPreview } from "@agent-deck/contracts";
import { Button } from "@/design-system/components/Button";
import { Card } from "@/design-system/components/Card";
import { ControlInput, ControlSelect } from "@/design-system/components/NativeControls";
import { useAppStore } from "../state/store.ts";

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

/** One compact line of what the import translated; nothing here is a value. */
function settingsSummary(settings: NonNullable<McpImportEntry["settings"]>): string {
  const parts: string[] = [];
  if (settings.startupTimeoutMs !== undefined)
    parts.push(`startup ${seconds(settings.startupTimeoutMs)}`);
  if (settings.toolTimeoutMs !== undefined) parts.push(`tool ${seconds(settings.toolTimeoutMs)}`);
  if (settings.enabledTools) parts.push(`${settings.enabledTools} enabled tool(s)`);
  if (settings.disabledTools) parts.push(`${settings.disabledTools} disabled tool(s)`);
  if (settings.toolApprovals) parts.push(`${settings.toolApprovals} tool approval(s)`);
  if (settings.defaultToolApproval) parts.push(`default approval ${settings.defaultToolApproval}`);
  if (settings.envReferences) parts.push(`${settings.envReferences} environment reference(s)`);
  if (settings.envInterpolation) parts.push("resolves ${VAR} at launch");
  return parts.join(" · ");
}

const badge = "rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted";

/** Only opaque snapshot tokens cross back to persistence; protected values stay on the server. */
export function McpImportPanel({
  existingNames,
  onImported,
}: {
  existingNames: string[];
  onImported: () => Promise<void>;
}): React.JSX.Element {
  const projects = useAppStore((state) => state.projects).filter((project) => !project.hidden);
  const sessionProjectId = useAppStore((state) => state.session?.projectId);
  // Local scope: a project is only read when the user (or their active session) names it.
  // undefined = untouched (follow the session); "" = user-level chosen explicitly.
  const [selection, setSelection] = useState<string | undefined>(undefined);
  const projectId =
    selection === ""
      ? null
      : projects.some((project) => project.id === selection)
        ? selection!
        : (projects.find((project) => project.id === sessionProjectId)?.id ?? null);
  const [preview, setPreview] = useState<McpImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const entries =
    preview?.entries.filter((entry) => entry.token && selected.has(entry.token)) ?? [];
  const duplicates = entries.filter((entry) => existingNames.includes(entry.name));
  const repeated = new Set(entries.map((entry) => entry.name)).size !== entries.length;

  const discover = async (scope: string | null = projectId): Promise<void> => {
    setBusy(true);
    setMessage("");
    setPreview(null);
    setSelected(new Set());
    setOverwrite(false);
    try {
      const response = await fetch("/mcp/import/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scope ? { projectId: scope } : {}),
      });
      if (!response.ok) throw new Error();
      setPreview((await response.json()) as McpImportPreview);
    } catch {
      setMessage("Discovery failed. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const importSelected = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    const imported: string[] = [];
    const failed: string[] = [];
    // Continue past a failure: each definition is its own write.
    for (const entry of entries) {
      try {
        const response = await fetch("/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            importToken: entry.token,
            overwrite: overwrite && existingNames.includes(entry.name),
          }),
        });
        if (!response.ok) {
          failed.push(
            `${entry.name} (${response.status === 409 ? "already exists" : `failed, ${response.status}`})`,
          );
          continue;
        }
      } catch {
        failed.push(`${entry.name} (request failed)`);
        continue;
      }
      imported.push(entry.name);
      setSelected((current) => {
        const next = new Set(current);
        next.delete(entry.token!);
        return next;
      });
      setPreview((current) =>
        current
          ? { ...current, entries: current.entries.filter((item) => item.token !== entry.token) }
          : null,
      );
    }
    setMessage(
      [
        imported.length ? `Imported ${imported.length} server(s): ${imported.join(", ")}.` : "",
        failed.length
          ? `Not imported: ${failed.join(", ")}. Reload the catalog and discover again to retry; an expired preview needs a new discovery.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    setBusy(false);
    setOverwrite(false);
    if (imported.length) await onImported().catch(() => undefined);
  };
  return (
    <Card className="mb-3" padding="md">
      <h2 className="text-label font-medium text-text-primary">Import local MCP configuration</h2>
      <p className="text-caption text-text-muted">
        Discover reads Claude Code, Claude Desktop (macOS/Windows), Codex, and Claude plugin
        configuration only when requested. Source files are unchanged; no commands run during
        discovery and no OAuth sessions are copied.
      </p>
      <p className="text-caption text-text-muted">
        Selected definitions are saved to ~/.pi/agent/mcp.json. Values, commands, arguments, and
        URLs are hidden in preview. Review source files before trusting them. Replacing an assigned
        server may activate its commands immediately.
      </p>
      <p className="text-caption text-text-muted">
        Import only adds a definition. Assigning it to a project is what activates it (a server
        marked disabled in its source stays inert until assigned), and a remote server may still
        need a sign-in after assignment.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-detail text-text-muted">
          Scope
          <ControlSelect
            aria-label="Import scope"
            size="sm"
            fullWidth={false}
            value={projectId ?? ""}
            disabled={busy}
            onChange={(event) => {
              setSelection(event.target.value);
              if (preview) void discover(event.target.value || null);
            }}
          >
            <option value="">User-level only</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </ControlSelect>
        </label>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void discover()}>
          {busy ? "Working…" : "Discover local servers"}
        </Button>
      </div>
      {preview ? (
        <div className="space-y-2">
          {preview.sources.map((source) => (
            <p key={`${source.scope}-${source.label}`} className="text-caption text-text-muted">
              {source.label}: {source.status}
              {source.status === "found" || source.status === "invalid" ? (
                <span className="ml-1 font-mono" title={source.path}>
                  ({source.path})
                </span>
              ) : null}
            </p>
          ))}
          {preview.entries.length === 0 ? <p>No server entries found.</p> : null}
          {preview.entries.map((entry, index) => {
            const blocking = entry.diagnostics.filter((diagnostic) => diagnostic.blocking);
            const notes = entry.diagnostics.filter((diagnostic) => !diagnostic.blocking);
            return (
              <div
                key={entry.token ?? `${entry.source}-${index}`}
                className="text-caption text-text-secondary"
                data-testid={`mcp-import-${entry.name}`}
              >
                <label className="flex items-center gap-2">
                  <ControlInput
                    type="checkbox"
                    aria-label={`Import ${entry.name} from ${entry.source}`}
                    disabled={busy || !entry.token}
                    checked={!!entry.token && selected.has(entry.token)}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(entry.token!);
                        else next.delete(entry.token!);
                        return next;
                      });
                      setOverwrite(false);
                    }}
                  />
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span>
                      {entry.name} — {entry.source}
                      {entry.token
                        ? ` — ${entry.transport}; ${entry.protectedCount ?? 0} protected value(s)`
                        : " — cannot be imported"}
                      {existingNames.includes(entry.name)
                        ? " — Existing name: import replaces the global definition (project overrides remain)."
                        : ""}
                    </span>
                    {entry.plugin ? (
                      <span className={badge}>Plugin {entry.plugin}</span>
                    ) : entry.scope === "project" ? (
                      <span className={badge}>Project</span>
                    ) : null}
                    {entry.disabledInSource ? (
                      <span className={badge}>Disabled in source</span>
                    ) : null}
                    {entry.requiresAuth ? (
                      <span className={badge}>Sign-in required after assignment</span>
                    ) : null}
                  </span>
                </label>
                {entry.settings && settingsSummary(entry.settings) ? (
                  <p className="ml-6 text-detail text-text-muted">
                    {settingsSummary(entry.settings)}
                  </p>
                ) : null}
                {blocking.length ? (
                  <ul className="ml-6 list-disc pl-4 text-detail text-warning">
                    {blocking.map((diagnostic) => (
                      <li key={diagnostic.field}>
                        <span className="font-mono">{diagnostic.field}</span>: {diagnostic.reason}
                        {diagnostic.action ? ` ${diagnostic.action}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {notes.length ? (
                  <details className="ml-6 text-detail text-text-muted">
                    <summary className="cursor-pointer">{notes.length} note(s)</summary>
                    <ul className="list-disc pl-4">
                      {notes.map((diagnostic) => (
                        <li key={diagnostic.field}>
                          <span className="font-mono">{diagnostic.field}</span>: {diagnostic.reason}
                          {diagnostic.action ? ` ${diagnostic.action}` : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            );
          })}
          {repeated ? <p role="alert">Select only one source for each server name.</p> : null}
          {duplicates.length ? (
            <label className="flex items-center gap-2 text-caption text-warning">
              <ControlInput
                type="checkbox"
                checked={overwrite}
                disabled={busy}
                onChange={(event) => setOverwrite(event.target.checked)}
              />
              Confirm replacement of existing definitions:{" "}
              {duplicates.map((entry) => entry.name).join(", ")}
            </label>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !entries.length || repeated || (duplicates.length > 0 && !overwrite)}
            onClick={() => void importSelected()}
          >
            Import selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setSelected(new Set());
              setMessage("");
            }}
          >
            Close preview
          </Button>
        </div>
      ) : null}
      <p
        role={message ? "status" : undefined}
        aria-live="polite"
        className="text-caption text-text-muted"
      >
        {message}
      </p>
    </Card>
  );
}
