import type { ComposerDraftImage } from "../state/store.ts";

const IMAGE_MIME_BY_EXTENSION: Record<string, ComposerDraftImage["mimeType"]> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Resolve a supported prompt-image MIME even when a desktop drop omits File.type. */
export function promptImageMime(
  file: Pick<File, "name" | "type">,
): ComposerDraftImage["mimeType"] | null {
  if (
    file.type === "image/png" ||
    file.type === "image/jpeg" ||
    file.type === "image/gif" ||
    file.type === "image/webp"
  ) {
    return file.type;
  }
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

export function isFileDrag(dataTransfer: Pick<DataTransfer, "types">): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

/** Electron can durably represent every OS file drop; browsers advertise copy only for images. */
export function supportsComposerDrop(
  dataTransfer: Pick<DataTransfer, "types" | "items">,
  electron: boolean,
): boolean {
  if (!isFileDrag(dataTransfer)) return false;
  if (electron) return true;
  return Array.from(dataTransfer.items).some(
    (item) =>
      item.kind === "file" &&
      (item.type === "image/png" ||
        item.type === "image/jpeg" ||
        item.type === "image/gif" ||
        item.type === "image/webp"),
  );
}
