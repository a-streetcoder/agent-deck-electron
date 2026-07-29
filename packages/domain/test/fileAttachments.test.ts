import { describe, expect, it } from "vitest";
import {
  appendFileAttachmentTags,
  extractFileAttachments,
  fileAttachmentName,
  fileAttachmentRefs,
  isFileAttachmentPath,
  MAX_FILE_ATTACHMENTS,
} from "../src/fileAttachments.ts";

describe("durable file attachment tags", () => {
  it.each([
    "/tmp/notes with spaces.txt",
    '/tmp/naïve & "quoted" <draft>.md',
    "/tmp/valid\\posix-name.txt",
    "C:\\Users\\Andrea\\notes.txt",
    "\\\\server\\share\\folder\\report.txt",
  ])("round-trips an absolute path without touching the source: %s", (path) => {
    const prompt = appendFileAttachmentTags("Review this", [path]);
    const parsed = extractFileAttachments(prompt);
    expect(parsed).toEqual({
      text: "Review this",
      files: [{ name: fileAttachmentName(path), path }],
    });
  });

  it("uses the recognized host syntax when deriving a display basename", () => {
    expect(fileAttachmentName("/tmp/valid\\posix-name.txt")).toBe("valid\\posix-name.txt");
    expect(fileAttachmentName("C:\\tmp/mixed\\windows-name.txt")).toBe("windows-name.txt");
  });

  it("keeps selection order, removes exact duplicates, and supports file-only messages", () => {
    const prompt = appendFileAttachmentTags("", ["/tmp/a.txt", "/tmp/b.txt", "/tmp/a.txt"]);
    expect(extractFileAttachments(prompt)).toEqual({
      text: "",
      files: [
        { name: "a.txt", path: "/tmp/a.txt" },
        { name: "b.txt", path: "/tmp/b.txt" },
      ],
    });
  });

  it("leaves malformed and unsafe tags visible as ordinary text", () => {
    const message = 'Keep <file name="relative.txt"></file> and <file name="/tmp/unclosed.txt">';
    expect(extractFileAttachments(message)).toEqual({ text: message, files: [] });
    expect(isFileAttachmentPath("/tmp/bad\nname.txt")).toBe(false);
    expect(isFileAttachmentPath("relative.txt")).toBe(false);
  });

  it("bounds the picker result without resolving, reading, or checking paths", () => {
    const paths = Array.from({ length: MAX_FILE_ATTACHMENTS + 2 }, (_, index) => {
      return `/definitely-missing/link-${index}/file.txt`;
    });
    const refs = fileAttachmentRefs(paths);
    expect(refs).toHaveLength(MAX_FILE_ATTACHMENTS);
    expect(refs[0]).toEqual({
      name: "file.txt",
      path: "/definitely-missing/link-0/file.txt",
    });

    const parsed = extractFileAttachments(
      paths.map((path) => `<file name="${path}"></file>`).join("\n"),
    );
    expect(parsed.files).toHaveLength(MAX_FILE_ATTACHMENTS);
    expect(parsed.text).toBe("");
  });
});
