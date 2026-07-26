import type { ComponentType } from "react";
import {
  FileText,
  FolderTree,
  Globe,
  ListChecks,
  Pencil,
  Search,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";
import type { ToolGroupVariant } from "./ToolGroupCard";

/**
 * Per-tool presentation (native PiAgentTranscriptNativeToolGroup toolVerb /
 * toolIcon): a friendly display name + a distinct icon for each known pi tool,
 * so a bash/read/edit call reads as "Shell" / "Read" / "Edit" with its own glyph
 * instead of the raw tool name under one generic terminal icon.
 */
export interface ToolPresentation {
  name: string;
  Icon: ComponentType<{ className?: string }>;
  variant: ToolGroupVariant;
}

interface ToolMeta {
  name: string;
  Icon: ComponentType<{ className?: string }>;
  variant?: ToolGroupVariant;
}

const TOOL_META: Record<string, ToolMeta> = {
  bash: { name: "Shell", Icon: Terminal },
  read: { name: "Read", Icon: FileText },
  edit: { name: "Edit", Icon: Pencil, variant: "diff" },
  write: { name: "Write", Icon: Pencil, variant: "diff" },
  grep: { name: "Search", Icon: Search },
  glob: { name: "Find files", Icon: Search },
  ls: { name: "List", Icon: FolderTree },
  web_search: { name: "Search web", Icon: Globe, variant: "web" },
  web_fetch: { name: "Fetch URL", Icon: Globe, variant: "web" },
  fetch_content: { name: "Fetch content", Icon: Globe, variant: "web" },
  get_search_content: { name: "Read web content", Icon: Globe, variant: "web" },
  set_session_plan: { name: "Plan", Icon: ListChecks },
  update_session_plan: { name: "Plan", Icon: ListChecks },
  managed_subagent: { name: "Agent", Icon: Users },
  subagent: { name: "Agent", Icon: Users },
};

/** Resolve a tool's card presentation; unknown tools keep their raw name + a wrench. */
export function toolPresentation(toolName: string): ToolPresentation {
  const meta = TOOL_META[toolName.toLowerCase()];
  if (meta) return { name: meta.name, Icon: meta.Icon, variant: meta.variant ?? "generic" };
  // MCP tools are namespaced `mcp__<server>__<tool>` — surface the tool part.
  if (toolName.startsWith("mcp__")) {
    const leaf = toolName.split("__").pop() || toolName;
    return { name: leaf, Icon: Wrench, variant: "mcp" };
  }
  return { name: toolName, Icon: Wrench, variant: "generic" };
}

/** The file path an edit/write/read tool acted on, if the args carry one. The
 * args may be a parsed object OR the raw JSON string Pi forwards. This only
 * examines structured `file_path` / `path` fields; prose and tool output are
 * deliberately never scanned for path-like text. */
export function toolFilePath(args: unknown): string | undefined {
  let obj: unknown = args;
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;
    const value = record.file_path ?? record.path;
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export interface ToolFileReference {
  /** Exact structured argument value, retained for transcript display. */
  displayPath: string;
  /** Lexically normalized session-relative path accepted by editor_open. */
  rpcPath: string;
}

const WINDOWS_DRIVE_ABSOLUTE = /^([a-zA-Z]):[\\/]/;
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/;
const UNC_PREFIX = /^(?:\\\\|\/\/)/;

function normalizedSegments(value: string, windows: boolean): string[] | null {
  const parts = value.split(windows ? /[\\/]+/ : /\/+/);
  const segments: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments;
}

function startsWithSegments(
  target: readonly string[],
  base: readonly string[],
  caseInsensitive: boolean,
): boolean {
  if (target.length <= base.length) return false;
  return base.every((segment, index) =>
    caseInsensitive
      ? target[index]?.toLocaleLowerCase("en-US") === segment.toLocaleLowerCase("en-US")
      : target[index] === segment,
  );
}

/**
 * Convert a structured tool file argument into the repo-relative shape used by
 * `editor_open`. This is a renderer eligibility check only: the server remains
 * authoritative for session identity, existence, realpath/symlink containment,
 * and editor allowlisting.
 */
export function toolFileReference(args: unknown, cwd: string): ToolFileReference | undefined {
  const displayPath = toolFilePath(args);
  if (!displayPath || displayPath.includes("\0") || !cwd || UNC_PREFIX.test(displayPath)) {
    return undefined;
  }

  const cwdDrive = WINDOWS_DRIVE_ABSOLUTE.exec(cwd);
  const pathDrive = WINDOWS_DRIVE_ABSOLUTE.exec(displayPath);
  const windows = cwdDrive !== null;

  // Drive-relative paths (`C:foo`) depend on process state and must never be
  // interpreted in the renderer. A drive-absolute path is likewise ineligible
  // for a POSIX session (and vice versa).
  if (WINDOWS_DRIVE_PREFIX.test(displayPath) && pathDrive === null) return undefined;
  if (pathDrive !== null && !windows) return undefined;

  if (windows) {
    if (UNC_PREFIX.test(cwd) || cwdDrive === null) return undefined;
    const cwdSegments = normalizedSegments(cwd.slice(cwdDrive[0].length), true);
    if (!cwdSegments) return undefined;

    if (pathDrive) {
      if (pathDrive[1]?.toLowerCase() !== cwdDrive[1]?.toLowerCase()) return undefined;
      const target = normalizedSegments(displayPath.slice(pathDrive[0].length), true);
      if (!target || !startsWithSegments(target, cwdSegments, true)) return undefined;
      return { displayPath, rpcPath: target.slice(cwdSegments.length).join("/") };
    }

    // A leading separator is rooted on the current drive, not session-relative.
    if (/^[\\/]/.test(displayPath)) return undefined;
    const relative = normalizedSegments(displayPath, true);
    if (!relative || relative.length === 0) return undefined;
    return { displayPath, rpcPath: relative.join("/") };
  }

  if (!cwd.startsWith("/") || WINDOWS_DRIVE_PREFIX.test(cwd)) return undefined;
  const cwdSegments = normalizedSegments(cwd, false);
  if (!cwdSegments) return undefined;

  if (displayPath.startsWith("/")) {
    const target = normalizedSegments(displayPath, false);
    if (!target || !startsWithSegments(target, cwdSegments, false)) return undefined;
    return { displayPath, rpcPath: target.slice(cwdSegments.length).join("/") };
  }

  const relative = normalizedSegments(displayPath, false);
  if (!relative || relative.length === 0) return undefined;
  return { displayPath, rpcPath: relative.join("/") };
}
