import { Button } from "@/design-system/components/Button";
import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useState } from "react";
import { CornerLeftUp, Folder } from "lucide-react";

/**
 * Choose a folder ON THE SERVER (remote-server POC, docs/remote-server-poc.md).
 *
 * A browser tab cannot pick paths on the machine that runs the agents, so this
 * lists `GET /fs/dirs`
 * (confined to AGENT_DECK_PROJECT_ROOT) and lets the user walk down to the
 * folder they want, or type its path. Used by the project picker, the Projects
 * screen and the new-session card so every "add a project" entry reaches it.
 */

interface ServerDirListing {
  root: string;
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

export function ServerFolderBrowser({
  path,
  onNavigate,
}: {
  /** Folder being shown; "" = the server's browse root. */
  path: string;
  onNavigate: (path: string) => void;
}) {
  const [listing, setListing] = useState<ServerDirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    fetch(`/fs/dirs${query}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("This folder cannot be browsed on the server.");
        return (await response.json()) as ServerDirListing;
      })
      .then((next) => {
        if (cancelled) return;
        setListing(next);
        setError(null);
        // The root is only known once listed; make it the folder a confirm would add.
        if (!path) onNavigate(next.path);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [path, onNavigate]);

  if (error) {
    return <div className="px-1 py-1 text-detail text-danger">{error}</div>;
  }
  if (!listing) {
    return <div className="px-1 py-1 text-detail text-text-muted">Loading server folders…</div>;
  }
  const rowClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-label text-text-secondary hover:bg-hover";
  return (
    <div className="max-h-48 overflow-y-auto" data-testid="server-folder-browser">
      {listing.parent !== null ? (
        <ControlButton
          className={rowClass}
          data-testid="server-folder-up"
          onClick={() => onNavigate(listing.parent!)}
        >
          <CornerLeftUp size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate">Up one level</span>
        </ControlButton>
      ) : null}
      {listing.dirs.map((dir) => (
        <ControlButton
          key={dir.path}
          className={rowClass}
          title={dir.path}
          data-testid={`server-folder-${dir.name}`}
          onClick={() => onNavigate(dir.path)}
        >
          <Folder size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{dir.name}</span>
        </ControlButton>
      ))}
      {listing.dirs.length === 0 ? (
        <div className="px-2 py-1 text-detail text-text-muted">No subfolders</div>
      ) : null}
    </div>
  );
}

/**
 * The complete "pick a server folder" flow: browser + editable path + confirm.
 * `onConfirm` receives the chosen absolute path (as the server reported it, or
 * as typed).
 */
export function ServerProjectPathPicker({
  onConfirm,
  confirmLabel = "Add project",
  testIdPrefix = "add-project",
}: {
  onConfirm: (path: string) => void | Promise<void>;
  confirmLabel?: string;
  testIdPrefix?: string;
}) {
  const [browsePath, setBrowsePath] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const navigate = useCallback((next: string) => {
    setBrowsePath(next);
    setDraftPath(next);
  }, []);
  const submit = (): void => {
    const path = draftPath.trim();
    if (path) void onConfirm(path);
  };
  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-server-picker`}>
      <ServerFolderBrowser path={browsePath} onNavigate={navigate} />
      <ControlInput
        data-testid={`${testIdPrefix}-path`}
        aria-label="Project folder path on the server"
        className="w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent"
        placeholder="/path/to/project"
        value={draftPath}
        onChange={(event) => setDraftPath(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      <Button
        size="sm"
        variant="primary"
        fullWidth
        className="rounded-capsule"
        data-testid={`${testIdPrefix}-confirm`}
        disabled={!draftPath.trim()}
        onClick={submit}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}
