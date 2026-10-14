import { describe, expect, it } from "vitest";
import { toolFileReference, toolPresentation } from "./toolPresentation.tsx";

describe("toolPresentation for native MCP tools", () => {
  it("labels server and tool with the Agent Deck id when the session map is known", () => {
    const names = { "my-srv_v2": "my-srv.v2", my: "my" };
    expect(toolPresentation("mcp__my_srv_v2__get__item", names)).toMatchObject({
      name: "my-srv.v2 › get__item",
      variant: "mcp",
    });
  });

  it("splits the Pi name on the first `__` without a map", () => {
    expect(toolPresentation("mcp__docs__search_docs").name).toBe("docs › search_docs");
    expect(toolPresentation("mcp__docs__search", { other: "other" }).name).toBe("docs › search");
    expect(toolPresentation("mcp").name).toBe("MCP");
    // A name reused for another server ("" in the map) is labelled from the Pi name.
    expect(toolPresentation("mcp__acme__q", { acme: "" }).name).toBe("acme › q");
  });
});

describe("toolFileReference", () => {
  it("extracts parsed or raw JSON file fields and preserves the display value", () => {
    expect(toolFileReference({ file_path: "src/./feature.ts" }, "/work/repo")).toEqual({
      displayPath: "src/./feature.ts",
      rpcPath: "src/feature.ts",
    });
    expect(toolFileReference('{"path":"src/nested/../feature.ts"}', "/work/repo")).toEqual({
      displayPath: "src/nested/../feature.ts",
      rpcPath: "src/feature.ts",
    });
  });

  it("accepts absolute POSIX paths only when lexically below the cwd", () => {
    expect(toolFileReference({ path: "/work/repo/src/a.ts" }, "/work/repo")).toEqual({
      displayPath: "/work/repo/src/a.ts",
      rpcPath: "src/a.ts",
    });
    expect(toolFileReference({ path: "/work/repository/a.ts" }, "/work/repo")).toBeUndefined();
    expect(toolFileReference({ path: "/work/repo" }, "/work/repo")).toBeUndefined();
    expect(toolFileReference({ path: "/../work/repo/a.ts" }, "/work/repo")).toBeUndefined();
  });

  it("normalizes Windows separators and compares drives and containment case-insensitively", () => {
    expect(toolFileReference({ file_path: "c:\\WORK\\repo\\src\\a.ts" }, "C:\\work\\repo")).toEqual(
      {
        displayPath: "c:\\WORK\\repo\\src\\a.ts",
        rpcPath: "src/a.ts",
      },
    );
    expect(toolFileReference({ path: "src\\nested\\..\\a.ts" }, "C:\\work\\repo")).toEqual({
      displayPath: "src\\nested\\..\\a.ts",
      rpcPath: "src/a.ts",
    });
    expect(toolFileReference({ path: "D:\\work\\repo\\a.ts" }, "C:\\work\\repo")).toBeUndefined();
    expect(
      toolFileReference({ path: "C:\\work\\repo-other\\a.ts" }, "C:\\work\\repo"),
    ).toBeUndefined();
  });

  it("rejects traversal underflow, ambiguous drive paths, UNC, NUL, and cwd itself", () => {
    const cwd = "C:\\work\\repo";
    for (const value of [
      "../outside.ts",
      "src/../../outside.ts",
      "C:src\\a.ts",
      "\\\\server\\share\\a.ts",
      "src/a.ts\0tail",
      ".",
      "src/..",
      "",
    ]) {
      expect(toolFileReference({ path: value }, cwd), value).toBeUndefined();
    }
  });

  it("does not infer references from prose, arrays, invalid JSON, or unrelated fields", () => {
    expect(toolFileReference("read /work/repo/src/a.ts", "/work/repo")).toBeUndefined();
    expect(toolFileReference("{bad json", "/work/repo")).toBeUndefined();
    expect(toolFileReference(["src/a.ts"], "/work/repo")).toBeUndefined();
    expect(toolFileReference({ command: "cat src/a.ts" }, "/work/repo")).toBeUndefined();
  });
});
