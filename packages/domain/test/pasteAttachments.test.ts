import { describe, expect, it } from "vitest";
import {
  activePasteAttachments,
  expandPasteMarkers,
  normalizePastedText,
  pasteCharacterCount,
  pasteMarker,
  shouldCollapsePaste,
  stripPasteMarkers,
  validatePasteAttachments,
} from "../src/index.ts";

describe("large paste markers", () => {
  it("matches the native line and character boundaries", () => {
    expect(shouldCollapsePaste(Array.from({ length: 10 }, () => "line").join("\n"))).toBe(false);
    const elevenLines = Array.from({ length: 11 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(shouldCollapsePaste(elevenLines)).toBe(true);
    expect(pasteMarker(1, elevenLines)).toBe("[paste #1 +11 lines]");

    expect(shouldCollapsePaste("x".repeat(1_000))).toBe(false);
    expect(shouldCollapsePaste("x".repeat(1_001))).toBe(true);
    expect(pasteMarker(2, "x".repeat(1_001))).toBe("[paste #2 1001 chars]");
  });

  it("normalizes line endings and tabs before measuring", () => {
    expect(normalizePastedText("a\r\nb\rc\td")).toBe("a\nb\nc    d");
  });

  it("counts Unicode grapheme clusters like Swift String.count", () => {
    expect(pasteCharacterCount("👨‍👩‍👧‍👦e\u0301")).toBe(2);
  });

  it("expands only exact markers that remain active", () => {
    const first = { id: 1, text: "a".repeat(1_001), marker: "[paste #1 1001 chars]" };
    const second = { id: 2, text: "b".repeat(1_001), marker: "[paste #2 1001 chars]" };
    expect(activePasteAttachments(`before ${second.marker}`, [first, second])).toEqual([second]);
    expect(expandPasteMarkers(`before ${second.marker}`, [first, second])).toBe(
      `before ${second.text}`,
    );
    expect(expandPasteMarkers("marker deleted", [first])).toBe("marker deleted");
  });

  it("strips compact markers while retaining durable preview data", () => {
    const attachment = { id: 3, text: "x".repeat(1_001), marker: "[paste #3 1001 chars]" };
    expect(stripPasteMarkers(`before ${attachment.marker} after`, [attachment])).toEqual({
      text: "before  after",
      pastes: [attachment],
    });
  });

  it("rejects forged, duplicate, inactive, normalized, and bounded payload violations", () => {
    const text = "x".repeat(1_001);
    const valid = { id: 1, text, marker: pasteMarker(1, text) };
    expect(validatePasteAttachments(valid.marker, [valid])).toEqual([valid]);
    expect(() =>
      validatePasteAttachments(valid.marker, [{ ...valid, marker: "[paste #1 3 chars]" }]),
    ).toThrow(/marker/);
    expect(() => validatePasteAttachments("deleted", [valid])).toThrow(/marker/);
    expect(() => validatePasteAttachments(valid.marker, [valid, valid])).toThrow(/id/);
    expect(() =>
      validatePasteAttachments("[paste #1 +11 lines]", [
        { id: 1, marker: "[paste #1 +11 lines]", text: "a\r\n".repeat(10) + "a" },
      ]),
    ).toThrow(/text/);
  });
});
