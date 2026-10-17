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

/**
 * SRV-10: provider credential env names, copied from pi-ai 1.2.0
 * dist/env-api-keys.js (getApiKeyEnvVars, not exported). EXA_API_KEY is absent on
 * purpose: web search is shared by design.
 */
export const PROVIDER_CREDENTIAL_ENV_KEYS: ReadonlySet<string> = new Set([
  "COPILOT_GITHUB_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANT_LING_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "NVIDIA_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "TYPESAFE_API_KEY",
  "RADIUS_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "META_API_KEY",
  "CLOUDFLARE_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  // CRB-02: Bedrock's bearer token and the AWS credentials pi-ai signs with.
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

/** CRB-02: `layered` with every provider credential unset (undefined, which
 * spawn drops from the inherited process env too): a brokered session must
 * not reach a provider with a key that bypasses the broker. */
export function withoutProviderCredentialEnv(
  layered: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...layered,
    ...Object.fromEntries([...PROVIDER_CREDENTIAL_ENV_KEYS].map((name) => [name, undefined])),
  };
}
