import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import {
  listProviders,
  logoutProvider,
  reconcileNeuralWattCatalog,
  scanEnv,
  writeEnvVar,
} from "@agent-deck/resources";
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
  createExternalCommandLauncher,
  findDoctorFixCommand,
  type ExternalCommandLauncher,
} from "../terminalLauncher.ts";
import {
  ancestorDirsOf,
  projectPiDirEscapes,
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
    mcpAssignments,
  } = ctx;

  // Browser-CSRF guard for the terminal-launching POSTs (Codex): a hostile
  // webpage can fire a no-cors POST at a discovered loopback port; browsers
  // attach an Origin header to those, while the app's own renderer fetches are
  // same-origin. Reject any cross-origin browser request. (The platform-wide
  // control-plane posture is documented in apps/desktop/main.js — this narrows
  // the two routes that OPEN TERMINALS.)
  const rejectCrossOrigin = (request: { headers: Record<string, unknown> }): boolean => {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (typeof origin !== "string" || origin.length === 0) return false;
    try {
      return new URL(origin).host !== host;
    } catch {
      return true; // an unparseable Origin is not the app's renderer
    }
  };

  // The default fix-terminal launcher, created once (its scratch dir is
  // shared across launches); tests inject ctx.fixTerminal instead.
  let fixTerminalSingleton: ExternalCommandLauncher | null = null;
  const defaultFixTerminal = (): ExternalCommandLauncher =>
    (fixTerminalSingleton ??= createExternalCommandLauncher());

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

  const buildDoctorReport = async (projectId: string | undefined) => {
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
    return report;
  };

  fastify.get("/runtime/doctor", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    const report = await buildDoctorReport(projectId);
    // DOC-01: the UI shows Run-fix ONLY where the server would launch it —
    // the same findDoctorFixCommand boundary decides both.
    const checks = report.checks.map((check) => ({
      ...check,
      runnableFix: findDoctorFixCommand(report, check.id) !== null,
    }));
    return { report: { ...report, checks } };
  });

  // DOC-01 (native openPiInstallInTerminal / Doctor Fix): run ONE check's fix
  // command in the user's own terminal — a one-shot script with a real TTY,
  // never a pipe. The wire carries ONLY the check id; the command is the
  // server's own doctor fixCommand constant, re-resolved here at USE time
  // (findDoctorFixCommand is the boundary — client text never launches).
  fastify.post("/runtime/doctor/fix", async (request, reply) => {
    if (rejectCrossOrigin(request as unknown as { headers: Record<string, unknown> })) {
      return reply.status(403).send({ error: "cross-origin requests are not allowed" });
    }
    const { checkId, projectId } = (request.body ?? {}) as {
      checkId?: unknown;
      projectId?: unknown;
    };
    if (typeof checkId !== "string" || checkId.length === 0) {
      return reply.status(400).send({ error: "checkId is required" });
    }
    const report = await buildDoctorReport(typeof projectId === "string" ? projectId : undefined);
    const command = findDoctorFixCommand(report, checkId);
    if (command === null) {
      return reply.status(404).send({ error: "no fix command for this check" });
    }
    try {
      await (ctx.fixTerminal ?? defaultFixTerminal()).run(command);
    } catch (error) {
      // Stable public message; the detail stays in the server log (Codex).
      console.error("[doctor] fix launch failed:", error);
      return reply.status(500).send({ error: "The fix could not be launched in a terminal." });
    }
    return { ok: true };
  });

  // DOC-02 (native openPiSelfUpdateInTerminal): update pi in the user's own
  // terminal. NO client data is consumed at all — the server resolves its own
  // pi binary and composes the whole script (the resolved path is quoted by
  // the launcher's batch/posix quoters, the same rule as TER-01's resume).
  fastify.post("/runtime/doctor/update-pi", async (request, reply) => {
    if (rejectCrossOrigin(request as unknown as { headers: Record<string, unknown> })) {
      return reply.status(403).send({ error: "cross-origin requests are not allowed" });
    }
    try {
      await (ctx.fixTerminal ?? defaultFixTerminal()).runPiUpdate();
    } catch (error) {
      // Stable public message; the detail stays in the server log.
      console.error("[doctor] pi update launch failed:", error);
      return reply
        .status(500)
        .send({ error: "The pi update could not be launched in a terminal." });
    }
    return { ok: true };
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

  const publicSettings = (value: AppSettings = settings.get()): AppSettings => ({
    ...value,
    defaultMcpServers: [...mcpAssignments.defaultServerNames()],
  });

  fastify.get("/settings", async () => ({
    settings: publicSettings(),
    capabilities: { agentMemory: ctx.memoryEnabled },
  }));

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
        agentMemoryEnabled: z.boolean().optional(),
        agentMemoryInjectionCharacterBudget: z.number().int().min(1000).max(20000).optional(),
        agentMemorySubagentsEnabled: z.boolean().optional(),
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
      return { settings: publicSettings(result) };
    }
    if (parsed.data.setDefaultPromptTemplate) {
      const { name, enabled } = parsed.data.setDefaultPromptTemplate;
      const result = settings.setDefaultPromptTemplate(name, enabled);
      broadcast({ type: "resources_changed" });
      return { settings: publicSettings(result) };
    }
    if (parsed.data.setBuiltinPromptDisabled) {
      const { name, disabled } = parsed.data.setBuiltinPromptDisabled;
      const result = settings.setBuiltinPromptDisabled(name, disabled);
      broadcast({ type: "resources_changed" });
      return { settings: publicSettings(result) };
    }
    if (parsed.data.setDisabledSkill) {
      const { name, disabled } = parsed.data.setDisabledSkill;
      const result = settings.setDisabledSkill(name, disabled);
      broadcast({ type: "resources_changed" }); // dims the row, updates assignment
      return { settings: publicSettings(result) };
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
    if (d.agentMemoryEnabled !== undefined) patch.agentMemoryEnabled = d.agentMemoryEnabled;
    if (d.agentMemoryInjectionCharacterBudget !== undefined)
      patch.agentMemoryInjectionCharacterBudget = d.agentMemoryInjectionCharacterBudget;
    if (d.agentMemorySubagentsEnabled !== undefined)
      patch.agentMemorySubagentsEnabled = d.agentMemorySubagentsEnabled;
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
    if (d.semanticMemoryEnabled !== undefined) {
      // Preference mutation is intentionally passive: update only the lifecycle
      // snapshot. Initialization belongs to search or the explicit check route.
      ctx.semanticRecall.preferenceChanged(d.semanticMemoryEnabled);
    }
    if (
      d.defaultSkills !== undefined ||
      d.defaultPromptTemplates !== undefined ||
      d.agentMemoryEnabled !== undefined ||
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
    return {
      settings: publicSettings(updated),
      capabilities: { agentMemory: ctx.memoryEnabled },
    };
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
      // Native reconciles NeuralWatt's models.json block BEFORE asking pi for the
      // catalog (AppViewModel.refreshAvailableModels), so a refresh is what picks
      // up newly published models — and what removes the block after a sign-out,
      // since pi would otherwise keep listing models the user cannot call.
      // Best-effort: it never throws, and with no stored key it does not contact
      // NeuralWatt at all.
      const signedInToNeuralWatt = (await listProviders(rootsFor())).some(
        (provider) => provider.id === "neuralwatt" && provider.signedIn,
      );
      await reconcileNeuralWattCatalog(rootsFor(), { hasRealKey: signedInToNeuralWatt });
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

  // INS-01/02: the GLOBAL base-prompt override ~/.pi/agent/SYSTEM.md and append
  // prompt ~/.pi/agent/APPEND_SYSTEM.md. pi resolves precedence itself (project
  // file wins, else the global, else nothing/built-in) — these routes only catalog
  // and edit the candidates; paths are derived here, never client-sent. DELETE
  // removes the override: an EMPTY SYSTEM.md would replace pi's base prompt with
  // nothing, a different (dangerous) state.
  const registerGlobalPiPromptRoutes = (routeName: string, fileName: string): void => {
    const filePathFor = (): string => nodePath.join(resourceHome(), ".pi", "agent", fileName);

    fastify.get(`/runtime/${routeName}`, async (_request, reply) => {
      const filePath = filePathFor();
      let content = "";
      const exists = existsSync(filePath);
      if (exists) {
        if (statSync(filePath).size > INSTRUCTIONS_MAX) {
          return reply
            .status(413)
            .send({ error: "the instructions file is too large to edit here" });
        }
        content = readFileSync(filePath, "utf8");
      }
      return { content, path: filePath, exists };
    });

    fastify.put(`/runtime/${routeName}`, async (request, reply) => {
      const parsed = instructionsBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
      const filePath = filePathFor();
      if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
        return reply
          .status(400)
          .send({ error: "the instructions file is a symlink; refusing to write" });
      }
      mkdirSync(nodePath.dirname(filePath), { recursive: true });
      writeFileSync(filePath, parsed.data.content, "utf8");
      return { ok: true, path: filePath };
    });

    fastify.delete(`/runtime/${routeName}`, async (_request, _reply) => {
      const filePath = filePathFor();
      // rmSync on a symlink removes the ENTRY, never its target — deleting the link
      // is exactly how the user restores pi's fallback, so it is allowed (review, Codex)
      try {
        if (lstatSync(filePath)) rmSync(filePath);
      } catch {
        // already absent — idempotent
      }
      return { ok: true };
    });
  };
  registerGlobalPiPromptRoutes("system-prompt", "SYSTEM.md");
  registerGlobalPiPromptRoutes("append-prompt", "APPEND_SYSTEM.md");

  // INS-04: which file WINS per instruction slot (native status(for:activePath:)).
  // pi resolves at launch; this is the same precedence, computed once server-side:
  // base: project SYSTEM.md > global SYSTEM.md > the built-in prompt;
  // append: project > global > none (the project file REPLACES the global one);
  // context: per-directory AGENTS.md over CLAUDE.md — global and project context
  // BOTH load (they stack), so shadowing there is within a directory only.
  // INS-05: the assembled system-prompt PREVIEW — the same winners the status
  // route reports, in pi's assembly order (base, append, context: global then
  // ancestors then project), each with size-capped content. What electron cannot
  // know is a LABELED placeholder, never fabricated: pi's built-in base prompt
  // text and the runtime trailer pi adds at launch.
  const PREVIEW_CONTENT_MAX = 20_000;
  const previewContent = (
    filePath: string,
  ): { content: string; contentTruncated?: boolean } | null => {
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) return null;
      // gate on SIZE before reading: the editors refuse >INSTRUCTIONS_MAX files
      // and the preview must never read-then-slice an unbounded file (review, Codex)
      if (stat.size > INSTRUCTIONS_MAX) {
        return {
          content: "[file too large to preview — the editor refuses it too]",
          contentTruncated: true,
        };
      }
      const raw = readFileSync(filePath, "utf8");
      return raw.length > PREVIEW_CONTENT_MAX
        ? { content: raw.slice(0, PREVIEW_CONTENT_MAX), contentTruncated: true }
        : { content: raw };
    } catch {
      return null;
    }
  };

  fastify.get("/runtime/instruction-preview", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    const roots = rootsFor(projectId);
    const globalDir = nodePath.join(roots.home, ".pi", "agent");
    const contextWinner = (dir: string): string | undefined => {
      let onDisk: Set<string>;
      try {
        onDisk = new Set(readdirSync(dir));
      } catch {
        return undefined;
      }
      // the winner must be a real FILE — a directory named AGENTS.md never wins,
      // the usable sibling does (review, Codex; matches the status route)
      for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
        if (!onDisk.has(name)) continue;
        const candidate = nodePath.join(dir, name);
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // unreadable — try the next candidate
        }
      }
      return undefined;
    };

    const sections: Array<{
      kind: "base" | "append" | "context" | "placeholder";
      title: string;
      path?: string;
      content?: string;
      contentTruncated?: boolean;
    }> = [];

    // the same .pi containment guard the editors enforce: a junctioned .pi must
    // not leak outside content through the preview either (review, Codex)
    const projectPiSafe = roots.projectPath ? !projectPiDirEscapes(roots.projectPath) : false;
    // base: project SYSTEM.md > global SYSTEM.md > pi's built-in (placeholder)
    const basePaths = [
      projectPiSafe && roots.projectPath
        ? nodePath.join(roots.projectPath, ".pi", "SYSTEM.md")
        : undefined,
      nodePath.join(globalDir, "SYSTEM.md"),
    ];
    let baseAdded = false;
    for (const candidate of basePaths) {
      if (!candidate) continue;
      const body = previewContent(candidate);
      if (body) {
        sections.push({ kind: "base", title: "Base prompt", path: candidate, ...body });
        baseAdded = true;
        break;
      }
    }
    if (!baseAdded) {
      sections.push({
        kind: "placeholder",
        title: "pi's built-in base prompt",
        content:
          "[pi generates its built-in base prompt at runtime when no SYSTEM.md exists — its text is not available here.]",
      });
    }

    // append: project APPEND_SYSTEM.md > global (absent -> no section)
    for (const candidate of [
      projectPiSafe && roots.projectPath
        ? nodePath.join(roots.projectPath, ".pi", "APPEND_SYSTEM.md")
        : undefined,
      nodePath.join(globalDir, "APPEND_SYSTEM.md"),
    ]) {
      if (!candidate) continue;
      const body = previewContent(candidate);
      if (body) {
        sections.push({ kind: "append", title: "Append prompt", path: candidate, ...body });
        break;
      }
    }

    // context files STACK: global dir first, then ancestors outermost-first, then
    // the project dir — one winner per directory (native activeContextFiles)
    const contextDirs = [globalDir];
    if (roots.projectPath) {
      contextDirs.push(
        ...ancestorDirsOf(roots.projectPath).dirs,
        nodePath.resolve(roots.projectPath),
      );
    }
    const seenContext = new Set<string>();
    for (const dir of contextDirs) {
      const winner = contextWinner(dir);
      if (!winner || seenContext.has(winner)) continue;
      seenContext.add(winner);
      const body = previewContent(winner);
      if (!body) continue;
      sections.push({ kind: "context", title: "Context file", path: winner, ...body });
    }

    sections.push({
      kind: "placeholder",
      title: "Runtime additions",
      content:
        "[pi adds the skill catalog, current date, and working directory at launch; Agent Deck may append its agent catalog.]",
    });

    return { sections };
  });

  fastify.get("/runtime/instruction-status", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    const roots = rootsFor(projectId);
    const globalDir = nodePath.join(roots.home, ".pi", "agent");
    const projectPi = roots.projectPath ? nodePath.join(roots.projectPath, ".pi") : undefined;

    // a prompt slot counts only when the path is a real FILE — runtime resolution
    // (appendSystemPromptPath's isFile) skips a directory of the same name (review, Codex)
    const isPromptFile = (filePath: string): boolean => {
      try {
        return statSync(filePath).isFile();
      } catch {
        return false;
      }
    };
    const fileState = (dir: string, name: string): { path: string; exists: boolean } => {
      const filePath = nodePath.join(dir, name);
      return { path: filePath, exists: isPromptFile(filePath) };
    };

    const slot = (
      name: string,
      fallback: "builtin" | "none",
    ): {
      active: "project" | "global" | "builtin" | "none";
      project?: { path: string; exists: boolean };
      global: { path: string; exists: boolean };
    } => {
      const globalFile = fileState(globalDir, name);
      const projectFile = projectPi ? fileState(projectPi, name) : undefined;
      const active = projectFile?.exists ? "project" : globalFile.exists ? "global" : fallback;
      return { active, ...(projectFile ? { project: projectFile } : {}), global: globalFile };
    };

    // the per-directory context winner + the sibling it shadows, using the real
    // directory listing so a case-insensitive filesystem never invents files
    const contextState = (
      dir: string,
    ): { path: string; exists: boolean; shadowedSibling?: string } => {
      let onDisk: Set<string>;
      try {
        onDisk = new Set(readdirSync(dir));
      } catch {
        return { path: nodePath.join(dir, "AGENTS.md"), exists: false };
      }
      // family precedence: ANY AGENTS casing beats ANY CLAUDE casing — the same
      // order resolveInstructionsFile uses at runtime (review, Codex)
      const present = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].filter((n) => {
        if (!onDisk.has(n)) return false;
        try {
          return statSync(nodePath.join(dir, n)).isFile();
        } catch {
          return false;
        }
      });
      if (present.length === 0) return { path: nodePath.join(dir, "AGENTS.md"), exists: false };
      const winner = present[0]!;
      const shadowed = present.slice(1);
      return {
        path: nodePath.join(dir, winner),
        exists: true,
        ...(shadowed.length > 0
          ? { shadowedSibling: shadowed.map((n) => nodePath.join(dir, n)).join(", ") }
          : {}),
      };
    };

    return {
      base: slot("SYSTEM.md", "builtin"),
      append: slot("APPEND_SYSTEM.md", "none"),
      context: {
        global: contextState(globalDir),
        ...(roots.projectPath ? { project: contextState(roots.projectPath) } : {}),
      },
    };
  });
}
