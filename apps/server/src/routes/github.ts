import type { ServerContext } from "../context.ts";
import { GitHubConnectError } from "../githubConnections.ts";
import { requestUser } from "../trustedProxy.ts";

/**
 * SRV-06: the requesting user's GitHub connection (device flow). Status only:
 * no route ever returns the token. Shared server only; elsewhere GET reports
 * `available: false` and the mutating routes answer 409.
 */
export function registerGitHubRoutes(ctx: ServerContext): void {
  const { fastify } = ctx;
  const UNAVAILABLE = { error: "GitHub connections are only available on a shared server." };

  fastify.get("/runtime/github", async (request) => {
    const github = ctx.githubConnections;
    const user = requestUser(request.raw);
    if (!github || !user) return { available: false, configured: false, connection: null };
    return { available: true, configured: github.configured(), connection: github.status(user) };
  });

  fastify.post("/runtime/github/connect", async (request, reply) => {
    const github = ctx.githubConnections;
    const user = requestUser(request.raw);
    if (!github || !user) return reply.status(409).send(UNAVAILABLE);
    try {
      return reply.status(201).send(await github.start(user));
    } catch (error) {
      if (error instanceof GitHubConnectError) {
        return reply.status(error.status).send({ error: error.message });
      }
      console.warn(`[github] device flow start failed: ${(error as Error).message}`);
      return reply.status(502).send({ error: "GitHub could not be reached." });
    }
  });

  // Only the identity that started a flow can follow it (as providerLogin).
  fastify.get("/runtime/github/connect/:id", async (request, reply) => {
    const github = ctx.githubConnections;
    const user = requestUser(request.raw);
    const { id } = request.params as { id: string };
    const result = github && user ? await github.poll(id, user.id) : undefined;
    if (!result) return reply.status(404).send({ error: "unknown GitHub sign-in" });
    return result;
  });

  // Forgets the token here; revoking it is on github.com (needs the app secret otherwise).
  fastify.delete("/runtime/github", async (request, reply) => {
    const github = ctx.githubConnections;
    const user = requestUser(request.raw);
    if (!github || !user) return reply.status(409).send(UNAVAILABLE);
    github.remove(user);
    return { ok: true };
  });
}
