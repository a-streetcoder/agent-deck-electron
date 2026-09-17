// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpImportPanel } from "./McpImportPanel.tsx";

const preview = {
  sources: [{ label: "fixture", status: "found" }],
  entries: [
    {
      token: "opaque-token",
      name: "existing",
      source: "fixture",
      transport: "stdio",
      protectedCount: 1,
    },
    { name: "unsupported", source: "fixture", unsupported: "Unsupported settings" },
  ],
};
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MCP import approval", () => {
  it("discovers only on request, requires selection and duplicate confirmation, and imports through POST /mcp", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response({ ok: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const imported = vi.fn().mockResolvedValue(undefined);
    render(<McpImportPanel existingNames={["existing"]} onImported={imported} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discover local servers" }));
    const select = await screen.findByRole("checkbox", { name: "Import existing from fixture" });
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Import unsupported from fixture",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    const submit = screen.getByRole("button", { name: "Import selected" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(select);
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm replacement/ }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(imported).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[1]).toEqual([
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importToken: "opaque-token", overwrite: true }),
      },
    ]);
    expect(screen.queryByRole("checkbox", { name: "Import existing from fixture" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Imported 1");
  });

  it("blocks same-name selections across sources and exposes safe conflict errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({
            ...preview,
            entries: [
              preview.entries[0],
              { ...preview.entries[0], token: "other", source: "other" },
            ],
          }),
        )
        .mockResolvedValueOnce(response({ error: "must-not-display-secret" }, 409)),
    );
    render(<McpImportPanel existingNames={[]} onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Discover local servers" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Import existing from fixture" }));
    const other = screen.getByRole("checkbox", { name: "Import existing from other" });
    fireEvent.click(other);
    expect(
      (screen.getByRole("button", { name: "Import selected" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("one source");
    fireEvent.click(other);
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("already exists"));
    expect(document.body.textContent).not.toContain("must-not-display-secret");
  });
});
