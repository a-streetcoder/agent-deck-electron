import {
  AGENT_DEFAULT_READ_TOTAL_MAX_BYTES,
  normalizeAgentDefaultReads,
  projectRelativeReadError,
  validateAgentDefaultReadsForAuthoring,
} from "../src/resources.ts";
import { describe, expect, it } from "vitest";

describe("agent default reads", () => {
  it.each([
    ["POSIX relative", "src/main.ts", undefined],
    ["backslash relative", "src\\main.ts", undefined],
    ["tilde-relative hint", "~/notes.md", undefined],
    ["POSIX absolute", "/etc/passwd", "project-relative"],
    ["Windows rooted", "\\Windows\\system.ini", "project-relative"],
    ["UNC", "\\\\server\\share\\file", "project-relative"],
    ["drive absolute", "C:\\Windows\\system.ini", "project-relative"],
    ["drive relative", "C:secret.txt", "project-relative"],
    ["forward traversal", "src/../secret", "project-relative"],
    ["backslash traversal", "src\\..\\secret", "project-relative"],
    ["newline", "src/main.ts\nother", "control"],
    ["NUL", "src/\u0000main.ts", "control"],
    ["Unicode separator", "src/main.ts\u2028other", "control"],
    ["multibyte exact", "é".repeat(256), undefined],
    ["multibyte oversized", "é".repeat(257), "512 UTF-8 bytes"],
  ])("classifies %s consistently", (_label, value, message) => {
    const error = projectRelativeReadError(value);
    if (message === undefined) expect(error).toBeUndefined();
    else expect(error).toContain(message);
  });

  it("drops unsafe entries independently and preserves trimmed stable order", () => {
    expect(
      normalizeAgentDefaultReads([
        " AGENTS.md ",
        "../unsafe",
        "src\\main.ts",
        "AGENTS.md",
        "C:\\unsafe",
      ]),
    ).toEqual(["AGENTS.md", "src\\main.ts"]);
  });

  it("rejects sanitized authoring count and UTF-8 totals without truncation", () => {
    expect(() =>
      validateAgentDefaultReadsForAuthoring(
        Array.from({ length: 33 }, (_, index) => `path-${index}.md`),
      ),
    ).toThrow(/32 safe, unique paths.*Remove 1 path/u);

    const exact = ["é".repeat(256), "a".repeat(512), "c".repeat(78)];
    expect(Buffer.byteLength(exact.join(""), "utf8")).toBe(AGENT_DEFAULT_READ_TOTAL_MAX_BYTES);
    expect(validateAgentDefaultReadsForAuthoring(exact)).toEqual(exact);
    expect(() => validateAgentDefaultReadsForAuthoring([...exact, "b"])).toThrow(
      /1,102 UTF-8 bytes.*received 1,103.*Shorten or remove paths/u,
    );
  });
});
