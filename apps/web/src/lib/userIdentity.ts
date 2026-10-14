/** Display helpers for the verified identities a shared server stamps on data. */
export interface UserIdentityLike {
  id: string;
  name?: string;
}

/** The person's name, else the local part of their email, else the raw id. */
export function userDisplayName(user: UserIdentityLike): string {
  const name = user.name?.trim();
  if (name) return name;
  const at = user.id.indexOf("@");
  return at > 0 ? user.id.slice(0, at) : user.id;
}

/** One or two uppercase initials for a compact avatar. */
export function userInitials(user: UserIdentityLike): string {
  const words = userDisplayName(user)
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * SRV-14: a session always runs on its owner's Pi credentials, whoever prompts
 * it. Returns "runs on <owner>'s credentials" when the viewer is not the owner;
 * null on loopback (no `me`), legacy sessions (no createdBy) or own sessions.
 */
export function credentialsOwnerLabel(
  me: UserIdentityLike | null | undefined,
  createdBy: UserIdentityLike | null | undefined,
): string | null {
  if (!me || !createdBy || me.id === createdBy.id) return null;
  return `runs on ${userDisplayName(createdBy)}'s credentials`;
}
