export async function responseErrorMessage(
  response: Response,
  fallback = `Request failed (${response.status}).`,
): Promise<string> {
  const text = await response.text();
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) return body.error;
    } catch {
      return text;
    }
  }
  return text || fallback;
}
