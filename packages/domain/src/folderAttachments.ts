import type { UserFolderRef } from "./transcript.ts";
import {
  appendFileAttachmentTags,
  fileAttachmentName,
  isFileAttachmentPath,
} from "./fileAttachments.ts";

export const MAX_FOLDER_ATTACHMENTS = 16;

const FOLDER_REFERENCE_SOURCE = String.raw`^[ \t]*folder:\s*\x60([^\x60\r\n]+)\x60[ \t]*(?:\r?\n|$)`;

function folderReferencePattern(): RegExp {
  return new RegExp(FOLDER_REFERENCE_SOURCE, "gm");
}

/**
 * Folder references use backticks as their native delimiter, so paths that
 * contain a backtick cannot be represented without changing Pi's prompt.
 */
export function isFolderAttachmentPath(value: string): boolean {
  return isFileAttachmentPath(value) && !value.includes("`");
}

/** Normalize a trusted directory-picker result without touching the filesystem. */
export function folderAttachmentRefs(paths: readonly string[]): UserFolderRef[] {
  const seen = new Set<string>();
  const refs: UserFolderRef[] = [];
  for (const path of paths) {
    if (refs.length >= MAX_FOLDER_ATTACHMENTS || !isFolderAttachmentPath(path) || seen.has(path)) {
      continue;
    }
    seen.add(path);
    refs.push({ name: fileAttachmentName(path), path });
  }
  return refs;
}

/** Append native-compatible folder references to Pi's existing text prompt contract. */
export function appendFolderAttachmentReferences(
  message: string,
  paths: readonly string[],
): string {
  const references = folderAttachmentRefs(paths).map(({ path }) => `folder: \`${path}\``);
  return [message.trim(), references.join("\n")].filter(Boolean).join("\n\n");
}

/** Emit files first, then folders, matching the native composer's one payload block. */
export function appendPathAttachmentPayload(
  message: string,
  filePaths: readonly string[],
  folderPaths: readonly string[],
): string {
  const fileTags = appendFileAttachmentTags("", filePaths);
  const folderReferences = appendFolderAttachmentReferences("", folderPaths);
  const payload = [fileTags, folderReferences].filter(Boolean).join("\n");
  return [message.trim(), payload].filter(Boolean).join("\n\n");
}

/**
 * Recover durable folder records from Pi's canonical text history. Malformed
 * or unsafe references remain ordinary visible text.
 */
export function extractFolderAttachments(message: string): {
  text: string;
  folders: UserFolderRef[];
} {
  const seen = new Set<string>();
  const folders: UserFolderRef[] = [];
  const text = message.replace(folderReferencePattern(), (reference, path: string) => {
    if (!isFolderAttachmentPath(path)) return reference;
    if (folders.length >= MAX_FOLDER_ATTACHMENTS || seen.has(path)) return "";
    seen.add(path);
    folders.push({ name: fileAttachmentName(path), path });
    return "";
  });
  return {
    text: folders.length > 0 ? text.replace(/(?:\r?\n)+$/, "") : text,
    folders,
  };
}
