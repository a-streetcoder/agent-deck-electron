/**
 * A session's attention EPISODE — the raise that made it need review, not the
 * fact that it does. The shell remembers what it has notified about; keying that
 * memory by session id alone means a session acknowledged and flagged again is
 * silently suppressed, because the id is still in the set. The backend stamps
 * `needsAttentionAt` on each raise, so a new episode is a new key.
 *
 * A record persisted before the stamp existed falls back to a constant, which
 * keeps the previous one-notification-per-pending-session behaviour instead of
 * inventing a fresh episode on every refresh.
 */
export function attentionEpisodeKey(session) {
  if (!session || typeof session.id !== "string" || session.needsAttention !== true) return null;
  const raisedAt =
    typeof session.needsAttentionAt === "string" && session.needsAttentionAt
      ? session.needsAttentionAt
      : "unstamped";
  return `${session.id}:${raisedAt}`;
}
