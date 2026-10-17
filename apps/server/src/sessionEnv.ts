/**
 * Variables the server's image sets for the server itself (the Dockerfile's
 * ENV) that a session must not inherit: `NODE_ENV=production` makes npm, pnpm
 * and yarn skip devDependencies, and `PORT` is the server's own port, which a
 * project's dev server would take as its own. The rest of that ENV only
 * points the server and Pi at their files. A session still gets either when
 * the owner's `.env` layer or the launch env sets it.
 */
export const SERVER_ONLY_ENV: readonly string[] = ["NODE_ENV", "PORT"];

/** `layered` over the server-only variables unset: each is undefined (which
 * spawn drops from the inherited process env) unless `layered` sets it. */
export function withoutServerOnlyEnv(
  layered: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(SERVER_ONLY_ENV.map((name) => [name, undefined])),
    ...layered,
  };
}
