import type { UserFileRef } from "./transcript.ts";

export const MAX_FILE_ATTACHMENTS = 16;
export const MAX_FILE_ATTACHMENT_PATH_CHARS = 4_096;

const FILE_TAG_SOURCE = String.raw`<file name="((?:&(?:amp|quot|lt|gt);|[^"&<>])*)"><\/file>`;

function fileTagPattern(): RegExp {
  return new RegExp(FILE_TAG_SOURCE, "g");
}

function encodeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function decodeAttribute(value: string): string {
  return value.replaceAll(/&(amp|quot|lt|gt);/g, (entity, name: string) => {
    switch (name) {
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "lt":
        return "<";
      default:
        return ">";
    }
  });
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Host-independent absolute-path check for POSIX, drive-letter, and UNC paths. */
export function isFileAttachmentPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_FILE_ATTACHMENT_PATH_CHARS ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  return (
    value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

/** Basename display that remains correct when replaying either host path syntax. */
export function fileAttachmentName(value: string): string {
  const separator = value.startsWith("/") ? /\// : /[\\/]/;
  return value.split(separator).filter(Boolean).at(-1) ?? value;
}

/** Normalize a trusted picker result without touching the filesystem. */
export function fileAttachmentRefs(paths: readonly string[]): UserFileRef[] {
  const seen = new Set<string>();
  const refs: UserFileRef[] = [];
  for (const path of paths) {
    if (refs.length >= MAX_FILE_ATTACHMENTS || !isFileAttachmentPath(path) || seen.has(path)) {
      continue;
    }
    seen.add(path);
    refs.push({ name: fileAttachmentName(path), path });
  }
  return refs;
}

/** Append native-compatible path tags to Pi's existing text prompt contract. */
export function appendFileAttachmentTags(message: string, paths: readonly string[]): string {
  const tags = fileAttachmentRefs(paths).map(
    ({ path }) => `<file name="${encodeAttribute(path)}"></file>`,
  );
  return [message.trim(), tags.join("\n")].filter(Boolean).join("\n\n");
}

/**
 * Recover first-class file records from Pi's canonical text history.
 * Malformed/unsafe tags remain visible ordinary text; recognized tags are hidden
 * from the message body and rendered as attachment chips instead.
 */
export function extractFileAttachments(message: string): {
  text: string;
  files: UserFileRef[];
} {
  const seen = new Set<string>();
  const files: UserFileRef[] = [];
  const text = message.replace(fileTagPattern(), (tag, encodedPath: string) => {
    const path = decodeAttribute(encodedPath);
    if (!isFileAttachmentPath(path)) return tag;
    if (files.length >= MAX_FILE_ATTACHMENTS || seen.has(path)) return "";
    seen.add(path);
    files.push({ name: fileAttachmentName(path), path });
    return "";
  });
  return { text: text.trim(), files };
}
