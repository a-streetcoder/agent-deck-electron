import { describe, expect, it } from "vitest";
import { responseErrorMessage } from "./responseError.ts";

describe("responseErrorMessage", () => {
  it("extracts actionable JSON errors without rendering the JSON envelope", async () => {
    const response = new Response(
      JSON.stringify({ error: "The catalog path is unsafe or linked." }),
      {
        status: 409,
        headers: { "content-type": "application/json" },
      },
    );
    expect(await responseErrorMessage(response)).toBe("The catalog path is unsafe or linked.");
  });

  it("retains plain text and status fallbacks", async () => {
    expect(await responseErrorMessage(new Response("plain failure", { status: 500 }))).toBe(
      "plain failure",
    );
    expect(await responseErrorMessage(new Response(null, { status: 503 }))).toBe(
      "Request failed (503).",
    );
  });
});
