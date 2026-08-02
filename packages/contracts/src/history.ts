import type { SessionMeta } from "./protocol.ts";
import type { ImageAttachment, PasteAttachment } from "./protocol.ts";

export interface HistoryDraftFile {
  id: string;
  name: string;
  path: string;
}

export interface HistoryDraftFolder {
  id: string;
  name: string;
  path: string;
}

/** Server-owned editable projection of one canonical Pi user entry. */
export interface HistoryDraft {
  text: string;
  images: Array<ImageAttachment & { id: string; name: string }>;
  files: HistoryDraftFile[];
  folders: HistoryDraftFolder[];
  pastes: PasteAttachment[];
}

export type HistoryActionResult =
  | { outcome: "forked"; session: SessionMeta; draft: HistoryDraft }
  | { outcome: "rerun"; session: SessionMeta };
