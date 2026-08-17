import assert from "node:assert/strict";
import test from "node:test";
import { attentionEpisodeKey } from "./attention-episodes.js";

test("an attention key is scoped to the raise that caused it", () => {
  const first = attentionEpisodeKey({
    id: "s1",
    needsAttention: true,
    needsAttentionAt: "2026-08-17T10:00:00.000Z",
  });
  const second = attentionEpisodeKey({
    id: "s1",
    needsAttention: true,
    needsAttentionAt: "2026-08-17T11:00:00.000Z",
  });
  // The same session needing review a SECOND time is a new episode, so the key
  // recorded for the first delivery cannot suppress the second notification.
  assert.notEqual(first, second);
  assert.match(first, /^s1:/);
});

test("a session that needs no review has no attention key", () => {
  assert.equal(attentionEpisodeKey({ id: "s1", needsAttention: false }), null);
  assert.equal(attentionEpisodeKey({ id: "s1" }), null);
  assert.equal(attentionEpisodeKey(null), null);
  assert.equal(attentionEpisodeKey({ needsAttention: true }), null);
});

test("a record written before stamps existed keeps one notification per pending session", () => {
  // Such a session must not look like a fresh episode on every refresh — that
  // would notify repeatedly. It falls back to a constant: the old behaviour.
  assert.equal(
    attentionEpisodeKey({ id: "s1", needsAttention: true }),
    attentionEpisodeKey({ id: "s1", needsAttention: true, needsAttentionAt: "" }),
  );
});
