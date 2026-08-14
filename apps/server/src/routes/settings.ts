import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import {
  discoverModelCatalog,
  hasEffectiveEnvValue,
  ModelCatalogError,
  resolveDoctorAgentDir,
  resolvePiBinary,
  runDoctor,
  webAccessChecks,
} from "@agent-deck/pi-host";
import { listProviders, logoutProvider, scanEnv, writeEnvVar } from "@agent-deck/resources";
import {
  isKeybindingCommand,
  isValidChord,
  MAX_KEYBINDINGS_COUNT,
  type KeybindingBinding,
} from "@agent-deck/contracts";
import { z } from "zod";
import type { AppSettings } from "../persistence.ts";
import { envDefaults, type ServerContext } from "../context.ts";
import {
  INSTRUCTIONS_MAX,
  RESOURCE_NAME,
  instructionsBody,
  resolveInstructionsFile,
} from "./shared.ts";

/**
 * App settings + runtime screens — /settings, the masked env inspector, the
 * doctor probe, provider auth/login, model curation, and the global
 * instructions editor. Moved verbatim from server.ts.
 */
export function registerSettingsRoutes(ctx: ServerContext): void {
  const {
    fastify,
    settings,
    providerLogin,
    broadcast,
    resourceHome,
    rootsFor,
    enabledExtensionPaths,
  } = ctx;

  // Runtime screens: masked env inspector and the doctor health probe.
  fastify.get("/runtime/env", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    return { entries: scanEnv(rootsFor(projectId)) };
  });

  // Set or add an env var (value provided) in the given scope's .env.
  fastify.put("/runtime/env", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: z.enum(["global", "project"]),
        key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalid env key"),
        value: z
          .string()
          .max(100_000)
          .refine((v) => !/[\r\n]/.test(v), "env values cannot contain newlines"),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, key, value } = parsed.data;
    if (scope === "project" && !rootsFor(projectId).projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    try {
      writeEnvVar(rootsFor(projectId), scope, key, value);
    } catch (error) {
      return reply.status(500).send({ error: String(error) });
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Delete an env var from the given scope's .env.
  fastify.delete("/runtime/env", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: z.enum(["global", "project"]),
        key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalid env key"),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, key } = parsed.data;
    if (scope === "project" && !rootsFor(projectId).projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    try {
      writeEnvVar(rootsFor(projectId), scope, key, null);
    } catch (error) {
      return reply.status(500).send({ error: String(error) });
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.get("/runtime/doctor", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    const roots = rootsFor(projectId);
    const defaults = envDefaults();
    const agentDir = resolveDoctorAgentDir(
      roots.home,
      roots.projectPath ?? defaults.cwd ?? process.cwd(),
      defaults.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR,
    );
    const report = await runDoctor(roots.home, roots.projectPath, agentDir);
    const envEntries = scanEnv(roots);
    report.checks.push(...webAccessChecks(hasEffectiveEnvValue(envEntries, "EXA_API_KEY")));
    const connectedProviders = (await listProviders(rootsFor())).filter(
      (provider) => provider.signedIn || provider.configured,
    );
    const authCheck = report.checks.find((check) => check.id === "auth");
    if (authCheck && connectedProviders.length > 0) {
      authCheck.status = "ok";
      authCheck.detail = `${connectedProviders.length} connected: ${connectedProviders
        .map((provider) => provider.name)
        .join(", ")}`;
      delete authCheck.fixCommand;
    }
    return { report };
  });

  // Provider auth (native provider-login surface): the OAuth-capable model
  // providers pi knows about, plus each one's sign-in status read from the
  // global ~/.pi/agent/auth.json. Interactive OAuth sign-in is a follow-up; this
  // covers the read side + logout (disconnect a stored credential).
  fastify.get("/runtime/providers", async () => ({ providers: await listProviders(rootsFor()) }));

  // Disconnect a stored provider credential (native logout). Only a known
  // provider id is accepted, so arbitrary keys can't be poked into auth.json.
  fastify.post("/runtime/providers/:id/logout", async (request, reply) => {
    const { id } = request.params as { id: string };
    const provider = (await listProviders(rootsFor())).find((entry) => entry.id === id);
    if (!provider) return reply.status(404).send({ error: `unknown provider: ${id}` });
    try {
      await logoutProvider(rootsFor(), id);
    } catch (error) {
      return reply.status(500).send({ error: String(error) });
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Interactive OAuth login (native PiProviderLoginService). start → a pollable
  // session that relays pi's AuthStorage.login callbacks (auth-url / device-code
  // / prompt / select / progress) to the client and threads responses back.
  fastify.post("/runtime/providers/:id/login", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ authType: z.enum(["api_key", "oauth"]) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const provider = (await listProviders(rootsFor())).find((entry) => entry.id === id);
    if (!provider) return reply.status(404).send({ error: `unknown provider: ${id}` });
    const supported =
      parsed.data.authType === "oauth" ? provider.supportsOAuth : provider.supportsAPIKey;
    if (!supported) return reply.status(400).send({ error: "authentication method unavailable" });
    const loginId = providerLogin.start(rootsFor(), id, parsed.data.authType);
    return reply.status(201).send({ loginId });
  });

  fastify.get("/runtime/providers/login/:loginId", async (request, reply) => {
    const { loginId } = request.params as { loginId: string };
    const since = Number((request.query as { since?: string }).since ?? 0);
    const result = providerLogin.poll(loginId, Number.isFinite(since) ? since : 0);
    if (!result) return reply.status(404).send({ error: "unknown login session" });
    // A finished login changes auth.json — nudge the Providers list to refresh.
    if (result.status === "done") broadcast({ type: "resources_changed" });
    return result;
  });

  fastify.post("/runtime/providers/login/:loginId/respond", async (request, reply) => {
    const { loginId } = request.params as { loginId: string };
    const parsed = z.object({ value: z.string().optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const ok = providerLogin.respond(loginId, parsed.data.value);
    return { ok };
  });

  fastify.post("/runtime/providers/login/:loginId/cancel", async (request) => {
    const { loginId } = request.params as { loginId: string };
    providerLogin.cancel(loginId);
    return { ok: true };
  });

  fastify.get("/settings", async () => ({ settings: settings.get() }));

  fastify.patch("/settings", async (request, reply) => {
    const parsed = z
      .object({
        defaultSkills: z.array(RESOURCE_NAME).optional(),
        defaultPromptTemplates: z.array(RESOURCE_NAME).optional(),
        /** Atomic membership ops — preferred over whole-array replacement. */
        setDefaultSkill: z.object({ name: RESOURCE_NAME, enabled: z.boolean() }).optional(),
        setDisabledSkill: z.object({ name: RESOURCE_NAME, disabled: z.boolean() }).optional(),
        setDefaultPromptTemplate: z
          .object({ name: RESOURCE_NAME, enabled: z.boolean() })
          .optional(),
        /** Silence/re-enable a bundled builtin prompt (PRM-06). */
        setBuiltinPromptDisabled: z
          .object({ name: RESOURCE_NAME, disabled: z.boolean() })
          .optional(),
        // Onboarding preferences (native OnboardingPreferencesView). null clears
        // defaultModel/defaultThinking back to "inherit the runtime default".
        autoTitle: z.boolean().optional(),
        semanticMemoryEnabled: z.boolean().optional(),
        piAgentIdleParkingEnabled: z.boolean().optional(),
        piAgentIdleParkingTimeoutMinutes: z.number().int().min(1).max(120).optional(),
        worktreeIsolation: z.boolean().optional(),
        keepWorktreeAfterMerge: z.boolean().optional(),
        gitAutomation: z.boolean().optional(),
        defaultModel: z.string().min(1).nullable().optional(),
        defaultThinking: z
          .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
          .nullable()
          .optional(),
        extensionLoadingMode: z.enum(["useMyExtensions", "agentDeckManaged"]).optional(),
        // The remembered open-in-editor choice (Slice 11). An id only — the
        // server maps it to its own detected editor list; never a command.
        preferredEditor: z.string().min(1).max(64).nullable().optional(),
        // Global transcript projection. Nested fields are partial so future
        // clients can update one category without racing unrelated preferences.
        piAgentTranscriptVisibility: z
          .object({
            showThinking: z.boolean().optional(),
            showWebActivity: z.boolean().optional(),
            showDiffs: z.boolean().optional(),
            showImages: z.boolean().optional(),
            showMemoryCards: z.boolean().optional(),
            showMCPCards: z.boolean().optional(),
          })
          .strict()
          .optional(),
        // User keybinding overrides (Slice 14): a whole-list replacement. Every
        // entry must name a known command and a chord with a real modifier —
        // the same validation the store applies on load, enforced here so a bad
        // rebind is a 400, not a silently-dropped row.
        keybindings: z
          .array(z.object({ command: z.string(), key: z.string() }))
          .max(MAX_KEYBINDINGS_COUNT)
          .refine(
            (list) => list.every((b) => isKeybindingCommand(b.command) && isValidChord(b.key)),
            "invalid keybinding (unknown command or malformed chord)",
          )
          .optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    if (parsed.data.setDefaultSkill) {
      const { name, enabled } = parsed.data.setDefaultSkill;
      const result = settings.setDefaultSkill(name, enabled);
      broadcast({ type: "resources_changed" });
      return { settings: result };
    }
    if (parsed.data.setDefaultPromptTemplate) {
      const { name, enabled } = parsed.data.setDefaultPromptTemplate;
      const result = settings.setDefaultPromptTemplate(name, enabled);
      broadcast({ type: "resources_changed" });
      return { settings: result };
    }
    if (parsed.data.setBuiltinPromptDisabled) {
      const { name, disabled } = parsed.data.setBuiltinPromptDisabled;
      const result = settings.setBuiltinPromptDisabled(name, disabled);
      broadcast({ type: "resources_changed" });
      return { settings: result };
    }
    if (parsed.data.setDisabledSkill) {
      const { name, disabled } = parsed.data.setDisabledSkill;
      const result = settings.setDisabledSkill(name, disabled);
      broadcast({ type: "resources_changed" }); // dims the row, updates assignment
      return { settings: result };
    }
    // Build a patch of ONLY the provided AppSettings fields — never spread
    // parsed.data directly (its undefined atomic-op keys would clobber existing
    // arrays like defaultSkills through the object spread in settings.update).
    const d = parsed.data;
    const patch: Partial<AppSettings> = {};
    if (d.defaultSkills !== undefined) patch.defaultSkills = d.defaultSkills;
    if (d.defaultPromptTemplates !== undefined)
      patch.defaultPromptTemplates = d.defaultPromptTemplates;
    if (d.autoTitle !== undefined) patch.autoTitle = d.autoTitle;
    if (d.semanticMemoryEnabled !== undefined)
      patch.semanticMemoryEnabled = d.semanticMemoryEnabled;
    if (d.piAgentIdleParkingEnabled !== undefined)
      patch.piAgentIdleParkingEnabled = d.piAgentIdleParkingEnabled;
    if (d.piAgentIdleParkingTimeoutMinutes !== undefined)
      patch.piAgentIdleParkingTimeoutMinutes = d.piAgentIdleParkingTimeoutMinutes;
    if (d.worktreeIsolation !== undefined) patch.worktreeIsolation = d.worktreeIsolation;
    if (d.keepWorktreeAfterMerge !== undefined)
      patch.keepWorktreeAfterMerge = d.keepWorktreeAfterMerge;
    if (d.gitAutomation !== undefined) patch.gitAutomation = d.gitAutomation;
    if (d.defaultModel !== undefined) patch.defaultModel = d.defaultModel;
    if (d.defaultThinking !== undefined) patch.defaultThinking = d.defaultThinking;
    if (d.extensionLoadingMode !== undefined) patch.extensionLoadingMode = d.extensionLoadingMode;
    if (d.preferredEditor !== undefined) patch.preferredEditor = d.preferredEditor;
    if (d.piAgentTranscriptVisibility !== undefined) {
      patch.piAgentTranscriptVisibility = {
        ...settings.get().piAgentTranscriptVisibility,
        ...d.piAgentTranscriptVisibility,
      };
    }
    // Refine above guarantees every command/chord is valid, so the plain
    // {command,key} shape is safe to store as KeybindingBinding[].
    if (d.keybindings !== undefined) patch.keybindings = d.keybindings as KeybindingBinding[];
    const updated = settings.update(patch);
    if (
      d.defaultSkills !== undefined ||
      d.defaultPromptTemplates !== undefined ||
      d.defaultModel !== undefined ||
      d.defaultThinking !== undefined ||
      d.extensionLoadingMode !== undefined
    ) {
      broadcast({ type: "resources_changed" });
    }
    if (
      d.piAgentIdleParkingEnabled !== undefined ||
      d.piAgentIdleParkingTimeoutMinutes !== undefined
    ) {
      ctx.sessions.configureIdleParking(
        updated.piAgentIdleParkingEnabled
          ? updated.piAgentIdleParkingTimeoutMinutes * 60_000
          : null,
      );
    }
    return { settings: updated };
  });

  // Session-independent model discovery. This runs Pi's exiting --list-models
  // mode with the same enabled global extensions as an ordinary no-project
  // session, plus server-configured provider registration extensions. It never
  // creates an RPC session or accepts client-controlled paths/environment.
  fastify.post("/runtime/models/discover", async (request, reply) => {
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      return reply.status(415).send({ error: "JSON request required" });
    }
    const parsed = z.object({}).strict().safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid discovery request" });

    const controller = new AbortController();
    let completed = false;
    const onDisconnect = (): void => {
      if (!completed) controller.abort();
    };
    reply.raw.once("close", onDisconnect);

    try {
      const defaults = envDefaults();
      const home = resourceHome();
      // Match an ordinary no-project launch: environment defaults first, then
      // enabled global extensions, then provider-registration fallbacks.
      const extensions = [
        ...new Set([
          ...(defaults.extensions ?? []),
          ...enabledExtensionPaths(),
          ...(defaults.providerExtensions ?? []),
        ]),
      ];
      const models = await discoverModelCatalog({
        binPath: resolvePiBinary().path,
        cwd: defaults.cwd ?? home,
        env: { ...defaults.env, HOME: home, USERPROFILE: home },
        extensions,
        signal: controller.signal,
      });
      const disabled = new Set(settings.get().disabledModels);
      return {
        models: models.map((model) => ({
          ...model,
          disabled: disabled.has(`${model.provider}:${model.id}`),
        })),
      };
    } catch (error) {
      if (error instanceof ModelCatalogError) {
        if (error.code === "aborted") {
          return reply.status(499).send({ error: "model discovery cancelled" });
        }
        if (error.code === "timeout") {
          return reply.status(504).send({ error: "model discovery timed out" });
        }
      }
      return reply.status(502).send({ error: "model discovery unavailable" });
    } finally {
      completed = true;
      reply.raw.off("close", onDisconnect);
    }
  });

  // Hide/show a model in the picker (app-level curation, the native Enabled/Disabled toggle).
  fastify.post("/runtime/models/disabled", async (request, reply) => {
    const parsed = z
      .object({ provider: z.string().min(1), id: z.string().min(1), disabled: z.boolean() })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    settings.setModelDisabled(`${parsed.data.provider}:${parsed.data.id}`, parsed.data.disabled);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Global instructions: ~/.pi/agent/AGENTS.md, which pi loads as global context
  // for every session (agent-deck-system-prompt-logic.md §context files).
  // Editable with no project selected — the project-scoped file is separate.
  const globalAgentsPath = (): string =>
    resolveInstructionsFile(nodePath.join(resourceHome(), ".pi", "agent"));

  fastify.get("/runtime/instructions", async (_request, reply) => {
    const filePath = globalAgentsPath();
    let content = "";
    if (existsSync(filePath)) {
      if (statSync(filePath).size > INSTRUCTIONS_MAX) {
        return reply.status(413).send({ error: "the instructions file is too large to edit here" });
      }
      content = readFileSync(filePath, "utf8");
    }
    return { content, path: filePath };
  });

  fastify.put("/runtime/instructions", async (request, reply) => {
    const parsed = instructionsBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const filePath = globalAgentsPath();
    // Never write THROUGH a symlink (same guard as the project file).
    if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
      return reply
        .status(400)
        .send({ error: "the instructions file is a symlink; refusing to write" });
    }
    mkdirSync(nodePath.dirname(filePath), { recursive: true });
    writeFileSync(filePath, parsed.data.content, "utf8");
    return { ok: true, path: filePath };
  });
}
