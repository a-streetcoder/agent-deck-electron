let imageReadToken = "";
const listeners = new Set<() => void>();

/** Set only from the schema-validated same-origin RPC hello frame. */
export function setImageReadToken(token: string): void {
  if (token === imageReadToken) return;
  imageReadToken = token;
  for (const listener of listeners) listener();
}

export function getImageReadToken(): string {
  return imageReadToken;
}

export function subscribeImageReadToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sessionImageUrl(sessionId: string, imageId: string): string {
  if (!imageReadToken) return "";
  return `/session-images/${encodeURIComponent(sessionId)}/${encodeURIComponent(imageId)}?token=${encodeURIComponent(imageReadToken)}`;
}
