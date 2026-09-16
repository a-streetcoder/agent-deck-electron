import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { HistoryDraft } from "@agent-deck/contracts";
import { z } from "zod";
import type { ServerContext } from "./context.ts";
import { syncDirectoryStrict } from "./sessionImages.ts";

export const MAX_COMPOSER_DRAFT_BYTES = 32 * 1024 * 1024;
const draftPath = z.object({
  id: z.string().max(200),
  name: z.string().max(4096),
  path: z.string().max(32768),
});
export const composerDraftSchema = z.object({
  text: z.string().max(MAX_COMPOSER_DRAFT_BYTES),
  images: z
    .array(
      z.object({
        id: z.string().max(200),
        name: z.string().max(4096),
        type: z.literal("image"),
        data: z.string().max(MAX_COMPOSER_DRAFT_BYTES),
        mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      }),
    )
    .max(64),
  files: z.array(draftPath).max(256),
  folders: z.array(draftPath).max(256),
  pastes: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        marker: z.string().max(4096),
        text: z.string().max(MAX_COMPOSER_DRAFT_BYTES),
      }),
    )
    .max(256),
});

/** Device-local unsent content. Never mixed into public session metadata. */
export interface ComposerDraftStore {
  get(sessionId: string): HistoryDraft | null;
  put(sessionId: string, draft: HistoryDraft | null): void;
  delete(sessionId: string): void;
}

export class ComposerDraftError extends Error {
  readonly code = "COMPOSER_DRAFT_STORAGE_FAILED";
}

export class FileComposerDraftStore implements ComposerDraftStore {
  private readonly root: string;
  constructor(dataDir: string) {
    this.root = path.join(dataDir, "composer-drafts");
    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700 });
    this.verifyRoot();
  }
  private verifyRoot(): void {
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ComposerDraftError("Unsafe composer draft directory.");
  }
  private file(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new ComposerDraftError("Invalid session identity.");
    this.verifyRoot();
    return path.join(this.root, `${id}.json`);
  }
  get(id: string): HistoryDraft | null {
    let fd: number | undefined;
    try {
      const file = this.file(id);
      // NOFOLLOW protects the leaf on platforms that support it; lstat also
      // rejects Windows symlinks before opening. No user-supplied paths enter here.
      if (!existsSync(file)) return null;
      if (lstatSync(file).isSymbolicLink()) throw new Error("linked draft");
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_COMPOSER_DRAFT_BYTES)
        throw new Error("invalid draft file");
      return composerDraftSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    } catch {
      throw new ComposerDraftError(
        "The saved message could not be read. Its file has been retained.",
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  put(id: string, draft: HistoryDraft | null): void {
    if (draft === null) return this.delete(id);
    let tmp: string | undefined;
    let fd: number | undefined;
    try {
      const data = JSON.stringify(composerDraftSchema.parse(draft));
      if (Buffer.byteLength(data) > MAX_COMPOSER_DRAFT_BYTES) throw new Error("draft too large");
      const file = this.file(id);
      if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("linked draft");
      tmp = `${file}.tmp-${randomUUID()}`;
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.verifyRoot();
      renameSync(tmp, file);
      tmp = undefined;
      syncDirectoryStrict(this.root);
    } catch {
      throw new ComposerDraftError(
        "The unsent message could not be saved. Keep this window open and retry.",
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (tmp) rmSync(tmp, { force: true });
    }
  }
  delete(id: string): void {
    try {
      const file = this.file(id);
      rmSync(file, { force: true });
      syncDirectoryStrict(this.root);
    } catch {
      throw new ComposerDraftError("The saved message could not be removed.");
    }
  }
}

export function registerComposerDraftRoutes(ctx: ServerContext, store: ComposerDraftStore): void {
  ctx.fastify.get("/sessions/:id/composer-draft", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ctx.index.find((session) => session.id === id))
      return reply.status(404).send({ error: "unknown session" });
    try {
      return { draft: store.get(id) };
    } catch (error) {
      return reply
        .status(500)
        .send({ code: "COMPOSER_DRAFT_STORAGE_FAILED", error: (error as Error).message });
    }
  });
  ctx.fastify.put(
    "/sessions/:id/composer-draft",
    { bodyLimit: MAX_COMPOSER_DRAFT_BYTES },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!ctx.index.find((session) => session.id === id))
        return reply.status(404).send({ error: "unknown session" });
      if (ctx.sessions.mutationClaims.owner(id) === "delete")
        return reply.status(409).send({ error: "Session deletion is in progress." });
      const parsed = z.object({ draft: composerDraftSchema.nullable() }).safeParse(request.body);
      if (!parsed.success)
        return reply.status(400).send({ error: "Invalid or oversized composer draft." });
      try {
        store.put(id, parsed.data.draft);
        return { ok: true };
      } catch (error) {
        return reply
          .status(500)
          .send({ code: "COMPOSER_DRAFT_STORAGE_FAILED", error: (error as Error).message });
      }
    },
  );
}
