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
