import type { UserPasteRef } from "./transcript.ts";

export const LARGE_PASTE_LINE_THRESHOLD = 10;
export const LARGE_PASTE_CHARACTER_THRESHOLD = 1_000;
export const MAX_PASTE_ATTACHMENTS = 16;
export const MAX_PASTE_ATTACHMENT_CHARS = 1_000_000;
export const MAX_PASTE_ATTACHMENTS_AGGREGATE_CHARS = 2_000_000;

export interface PasteAttachment {
  id: number;
  marker: string;
  text: string;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Swift String.count parity: count user-perceived characters, not UTF-16 code units. */
export function pasteCharacterCount(text: string): number {
  let count = 0;
  for (const _segment of graphemeSegmenter.segment(text)) count += 1;
  return count;
}

export function normalizePastedText(rawText: string): string {
  return rawText.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ");
}

export function pasteLineCount(text: string): number {
  return text.split("\n").length;
}

export function shouldCollapsePaste(text: string): boolean {
  return (
    pasteLineCount(text) > LARGE_PASTE_LINE_THRESHOLD ||
    pasteCharacterCount(text) > LARGE_PASTE_CHARACTER_THRESHOLD
  );
}

export function pasteMarker(id: number, text: string): string {
  const lines = pasteLineCount(text);
  return lines > LARGE_PASTE_LINE_THRESHOLD
    ? `[paste #${id} +${lines} lines]`
    : `[paste #${id} ${pasteCharacterCount(text)} chars]`;
}

export function activePasteAttachments(
  text: string,
  attachments: readonly PasteAttachment[],
): PasteAttachment[] {
  if (attachments.length === 0 || !text.includes("[paste #")) return [];
  return attachments.filter((attachment) => text.includes(attachment.marker));
}

export function expandPasteMarkers(text: string, attachments: readonly PasteAttachment[]): string {
  let expanded = text;
  for (const attachment of activePasteAttachments(text, attachments)) {
    expanded = expanded.replaceAll(attachment.marker, attachment.text);
  }
  return expanded;
}

export function stripPasteMarkers(
  text: string,
  attachments: readonly PasteAttachment[],
): { text: string; pastes: UserPasteRef[] } {
  const active = activePasteAttachments(text, attachments);
  let visible = text;
  for (const attachment of active) visible = visible.replaceAll(attachment.marker, "");
  return {
    text: visible,
    pastes: active.map(({ id, marker, text: pasteText }) => ({ id, marker, text: pasteText })),
  };
}

export function validatePasteAttachments(
  transcriptText: string,
  attachments: readonly PasteAttachment[],
): PasteAttachment[] {
  if (attachments.length === 0 || attachments.length > MAX_PASTE_ATTACHMENTS) {
    throw new Error("invalid paste attachment count");
  }
  const ids = new Set<number>();
  const markers = new Set<string>();
  let aggregateChars = 0;
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.id) || attachment.id < 1 || ids.has(attachment.id)) {
      throw new Error("invalid paste attachment id");
    }
    ids.add(attachment.id);
    if (
      attachment.text.length === 0 ||
      attachment.text.length > MAX_PASTE_ATTACHMENT_CHARS ||
      attachment.text !== normalizePastedText(attachment.text)
    ) {
      throw new Error("invalid paste attachment text");
    }
    aggregateChars += attachment.text.length;
    if (aggregateChars > MAX_PASTE_ATTACHMENTS_AGGREGATE_CHARS) {
      throw new Error("paste attachment payload is too large");
    }
    if (
      !shouldCollapsePaste(attachment.text) ||
      attachment.marker !== pasteMarker(attachment.id, attachment.text) ||
      markers.has(attachment.marker) ||
      !transcriptText.includes(attachment.marker)
    ) {
      throw new Error("invalid paste attachment marker");
    }
    markers.add(attachment.marker);
  }
  return [...attachments];
}
