import { useState } from "react";
import type { McpImportPreview } from "@agent-deck/contracts";
import { Button } from "@/design-system/components/Button";
import { Card } from "@/design-system/components/Card";
import { ControlInput } from "@/design-system/components/NativeControls";

/** Only opaque snapshot tokens cross back to persistence; protected values stay on the server. */
export function McpImportPanel({
  existingNames,
  onImported,
}: {
  existingNames: string[];
  onImported: () => Promise<void>;
}): React.JSX.Element {
  const [preview, setPreview] = useState<McpImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const entries =
    preview?.entries.filter((entry) => entry.token && selected.has(entry.token)) ?? [];
  const duplicates = entries.filter((entry) => existingNames.includes(entry.name));
  const repeated = new Set(entries.map((entry) => entry.name)).size !== entries.length;

  const discover = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    setPreview(null);
    setSelected(new Set());
    setOverwrite(false);
    try {
      const response = await fetch("/mcp/import/discover", { method: "POST" });
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
    let count = 0;
    try {
      for (const entry of entries) {
        const response = await fetch("/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            importToken: entry.token,
            overwrite: overwrite && existingNames.includes(entry.name),
          }),
        });
        if (!response.ok) {
          setMessage(
            response.status === 409
              ? "A definition already exists. Reload the catalog, discover again, and confirm replacement."
              : "Import failed or preview expired. Discover again to retry remaining entries.",
          );
          break;
        }
        count++;
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
      if (count === entries.length) setMessage(`Imported ${count} server(s).`);
      if (count) await onImported();
    } catch {
      setMessage(`Imported ${count} server(s); request failed. Reload before retrying.`);
    } finally {
      setBusy(false);
      setOverwrite(false);
    }
  };
  return (
    <Card className="mb-3" padding="md">
      <h2 className="text-label font-medium text-text-primary">Import local MCP configuration</h2>
      <p className="text-caption text-text-muted">
        Discover reads Claude Code, Claude Desktop (macOS/Windows), and Codex configuration only
        when requested. Source files are unchanged; no commands run during discovery and no OAuth
        sessions are copied.
      </p>
      <p className="text-caption text-text-muted">
        Selected definitions are saved to ~/.pi/agent/mcp.json. Values, commands, arguments, and
        URLs are hidden in preview. Review source files before trusting them. Replacing an assigned
        server may activate its commands immediately.
      </p>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void discover()}>
        {busy ? "Working…" : "Discover local servers"}
      </Button>
      {preview ? (
        <div className="space-y-2">
          {preview.sources.map((source) => (
            <p key={source.label} className="text-caption text-text-muted">
              {source.label}: {source.status}
            </p>
          ))}
          {preview.entries.length === 0 ? <p>No server entries found.</p> : null}
          {preview.entries.map((entry, index) => (
            <label
              key={entry.token ?? `${entry.source}-${index}`}
              className="flex items-center gap-2 text-caption text-text-secondary"
            >
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
              <span>
                {entry.name} — {entry.source} —{" "}
                {entry.unsupported ??
                  `${entry.transport}; ${entry.protectedCount ?? 0} protected value(s)`}
                {existingNames.includes(entry.name)
                  ? " — Existing name: import replaces the global definition (project overrides remain)."
                  : ""}
              </span>
            </label>
          ))}
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
