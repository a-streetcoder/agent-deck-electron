import { describe, expect, it } from "vitest";
import {
  appendFolderAttachmentReferences,
  appendPathAttachmentPayload,
  extractFolderAttachments,
  folderAttachmentRefs,
  isFolderAttachmentPath,
  MAX_FOLDER_ATTACHMENTS,
} from "../src/folderAttachments.ts";

describe("durable folder attachment references", () => {
  it.each([
    ["/tmp/project with spaces", "project with spaces"],
    ["/tmp/valid\\posix-folder", "valid\\posix-folder"],
    ["C:\\Users\\Andrea\\Project", "Project"],
    ["\\\\server\\share\\Project", "Project"],
  ])("round-trips an absolute path without reading the directory: %s", (path, name) => {
    const prompt = appendFolderAttachmentReferences("Review this project", [path]);
    expect(extractFolderAttachments(prompt)).toEqual({
      text: "Review this project",
      folders: [{ name, path }],
    });
  });

  it("keeps selection order, removes duplicates, and supports folder-only messages", () => {
    const prompt = appendFolderAttachmentReferences("", ["/tmp/one", "/tmp/two", "/tmp/one"]);
    expect(prompt).toBe("folder: `/tmp/one`\nfolder: `/tmp/two`");
    expect(extractFolderAttachments(prompt)).toEqual({
      text: "",
      folders: [
        { name: "one", path: "/tmp/one" },
        { name: "two", path: "/tmp/two" },
      ],
    });
  });

  it("emits mixed native path attachments in one file-then-folder payload block", () => {
    expect(
      appendPathAttachmentPayload("Review both", ["/tmp/notes & plans.txt"], ["/tmp/project"]),
    ).toBe(
      'Review both\n\n<file name="/tmp/notes &amp; plans.txt"></file>\nfolder: `/tmp/project`',
    );
    expect(appendPathAttachmentPayload("Review", ["/tmp/only.txt"], [])).toBe(
      'Review\n\n<file name="/tmp/only.txt"></file>',
    );
  });

  it("leaves malformed, relative, and delimiter-ambiguous references visible", () => {
    const message =
      "Keep folder: `relative/path` and folder: `/tmp/unclosed\nMention folder: `/tmp/inline` here";
    expect(extractFolderAttachments(message)).toEqual({ text: message, folders: [] });
    expect(isFolderAttachmentPath("relative/path")).toBe(false);
    expect(isFolderAttachmentPath("/tmp/bad`folder")).toBe(false);
    expect(isFolderAttachmentPath("/tmp/bad\nfolder")).toBe(false);
  });

  it("preserves untouched whitespace exactly when no canonical reference exists", () => {
    const message = "Markdown hard break  \n\n\nnext paragraph  \n";
    expect(extractFolderAttachments(message)).toEqual({ text: message, folders: [] });
  });

  it("removes only the canonical line while preserving surrounding text bytes", () => {
    const message = "Markdown hard break  \nfolder: `/tmp/project`\nnext line";
    expect(extractFolderAttachments(message)).toEqual({
      text: "Markdown hard break  \nnext line",
      folders: [{ name: "project", path: "/tmp/project" }],
    });
  });

  it("bounds missing live-path references without resolving or checking them", () => {
    const paths = Array.from(
      { length: MAX_FOLDER_ATTACHMENTS + 2 },
      (_, index) => `/definitely-missing/ses-07/folder-${index}`,
    );
    expect(folderAttachmentRefs(paths)).toHaveLength(MAX_FOLDER_ATTACHMENTS);

    const parsed = extractFolderAttachments(paths.map((path) => `folder: \`${path}\``).join("\n"));
    expect(parsed.folders).toHaveLength(MAX_FOLDER_ATTACHMENTS);
    expect(parsed.text).toBe("");
  });
});
