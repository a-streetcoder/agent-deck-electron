import assert from "node:assert/strict";
import test from "node:test";
import { windowsAttentionDescription, windowsAttentionPng } from "./attention-overlay.js";

test("Windows attention overlays are non-empty PNGs with grammatical descriptions", () => {
  const one = windowsAttentionPng(1);
  const many = windowsAttentionPng(12);
  assert.ok(one.length > 100);
  assert.ok(many.length > 100);
  assert.deepEqual([...one.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.notDeepEqual(one, many);
  assert.equal(windowsAttentionDescription(1), "1 session needs attention");
  assert.equal(windowsAttentionDescription(2), "2 sessions need attention");
});
