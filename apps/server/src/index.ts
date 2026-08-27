import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "bun";
import { ensureProcessPath } from "./lib/ensure-process-path";

// Static ESM dependencies are evaluated before this statement; crashes after
// module initialization are covered by the process-level handlers.
installErrorHandlers("server");
await installErrorTrackingSink();
void flushPendingErrorReports();
ensureProcessPath();

import {
  generateSkillCuratorConsolidationMarkdown,
  mergeOrgMemoryWithApprovedBullet,
} from "@atlas/agent";
import {
  ATLAS_API_VERSION,
  clearRuntimeServerUrl,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  ensureBundledSkillFiles,
  flushPendingErrorReports,
  getActiveProviderInstance,
  getUserConfigDir,
  installErrorHandlers,
  installErrorTrackingSink,
  loadConfig,
  officeConverter,
  registerBrowserHandler,
  writeRuntimeServerUrl,
} from "@atlas/core";
import { serverHasTaskChat } from "@atlas/core/ensure-server";
import {
  createDatabase,
  type Database,
  ensureBundledSkillsAssigned,
  seedDatabase,
} from "@atlas/db";
import { createHonoApp } from "./http/app";
import { disableBunIdleTimeoutForSse } from "./http/sse-idle-timeout";
import { runFirstBootSeed } from "./seed";
import { AgentService } from "./services/agent-service";
import { AuthService } from "./services/auth-service";
import { AutomationDeliveryService } from "./services/automation-delivery-service";
import { AutomationRunner } from "./services/automation-runner";
import { AutomationService } from "./services/automation-service";
import { browserSessionService } from "./services/browser-session-service";
import { createChatCapabilityAwareProvider } from "./services/chat-capability-policy";
import { ComposioService } from "./services/composio-service";
import { LlmUsageTracker } from "./services/llm-usage-tracker";
import { McpClientManager } from "./services/mcp-client-manager";
import {
  createMcpAwareEmailOutboundAdapter,
  hasAutomationEmailDeliveryPath,
} from "./services/mcp-email-delivery";
import { McpService } from "./services/mcp-service";
import { OrgMemoryService } from "./services/org-memory-service";
import { OrgService } from "./services/org-service";
import {
  resolveDefaultModelForInstance,
  resolveProfileProviderSelection,
} from "./services/provider-instance-helpers";
import { SkillCuratorService } from "./services/skill-curator-service";
import { SkillProposalService } from "./services/skill-proposal-service";
import { SkillSuggestionService } from "./services/skill-suggestion-service";
import { SkillsService } from "./services/skills-service";
import { SystemStatusService } from "./services/system-status-service";
import { TaskRunner } from "./services/task-runner";
import { TaskService } from "./services/task-service";
import {
  registerGenerateImageTool,
  registerSubAgentTool,
} from "./services/tool-resolver";
import { WorkerManagerService } from "./services/worker-manager-service";
import { ensureProviderConfigured } from "./setup";
import { resolveWebDistDir } from "./static-web";
import {
  createAutomationRunHistoryTools,
  createAutomationTools,
} from "./tools/automation-tools";
import { createGenerateImageTool } from "./tools/generate-image-tool";
import { createSubAgentTool } from "./tools/sub-agent-tool";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const host = process.env.ATLAS_HOST ?? DEFAULT_SERVER_HOST;
const requestedPort = parsePort(process.env.ATLAS_PORT);
const canFallbackToNextPort = process.env.ATLAS_PORT == null;

const existingServerUrl = await findRunningAtlasServerUrl(host, requestedPort);

if (existingServerUrl) {
  const runtimeServerUrl = writeRuntimeServerUrl(existingServerUrl);
  console.log(`Atlas server already running on ${runtimeServerUrl}`);
  console.log(
    "Stop it before restarting to pick up code changes (for example: kill $(lsof -ti :4310))."
  );
  console.log("Or run: bun run dev:server");
  process.exit(0);
}

const { provider, userConfig } = await ensureProviderConfigured();
const config = loadConfig();
const database = await createDatabase(config.databaseUrl, {
  baseDir: getUserConfigDir(),
});

await seedDatabase(database.adapter);

const authService = new AuthService();

const llmUsageTracker = await LlmUsageTracker.create(database.adapter);
const agent = new AgentService(
  userConfig,
  provider,
  database.adapter,
  llmUsageTracker
);
const bootstrapInstance = getActiveProviderInstance(userConfig);
const bootstrapModelId = bootstrapInstance
  ? resolveDefaultModelForInstance(bootstrapInstance)
  : "";
const bootstrapCapabilityProvider =
  bootstrapInstance && bootstrapModelId
    ? createChatCapabilityAwareProvider({
        config: userConfig,
        instance: bootstrapInstance,
        modelId: bootstrapModelId,
      })
    : null;
registerBrowserHandler((input, context) =>
  browserSessionService.executeBrowserAction(input, {
    orgId: context.orgId,
    profileId: context.profileId,
    runId: context.runId,
    sessionId: context.sessionId,
    userId: context.userId,
  })
);
registerSubAgentTool(createSubAgentTool(agent));
registerGenerateImageTool(
  createGenerateImageTool({
    db: database.adapter,
    ensureSettingsLoaded: () => agent.ensureImageGenerationSettingsLoaded(),
    getUserConfig: (orgId) => agent.getUserConfigForOrg(orgId),
    recordUsage: (modelId, inputTokens, outputTokens, instance) => {
      llmUsageTracker.record(modelId, inputTokens, outputTokens, {
        provider: instance.type,
        providerInstance: instance,
      });
    },
  })
);
await agent.ensureVisionSettingsLoaded();
await agent.ensureTranscriptionSettingsLoaded();
await agent.ensureImageGenerationSettingsLoaded();
await agent.ensureProviderSettingsLoaded();
const mcpClientManager = new McpClientManager();
const mcpService = new McpService(database.adapter, mcpClientManager);
const composioService = new ComposioService(database.adapter, authService);
const skillsService = new SkillsService(database.adapter);

agent.setMcpClientManager(mcpClientManager);
agent.setMcpService(mcpService);
agent.setComposioService(composioService);
agent.setSkillsService(skillsService);

const automationService = new AutomationService(database.adapter, {
  canSendEmail: (profileId, _orgId) =>
    hasAutomationEmailDeliveryPath(database.adapter, profileId),
  getUserTimezone: () => agent.getUserTimezone(),
});
const automationDeliveryService = new AutomationDeliveryService(
  automationService,
  {
    email: createMcpAwareEmailOutboundAdapter(
      database.adapter,
      mcpClientManager
    ),
  }
);
const automationRunner = new AutomationRunner(
  automationService,
  agent,
  automationDeliveryService,
  agent.executionPlane,
  agent.identityService
);

agent.setAutomationTools(
  createAutomationTools(automationService, automationRunner)
);
agent.setAutomationRunHistoryTools(
  createAutomationRunHistoryTools(automationService)
);
agent.setAutomationRunner(automationRunner);

const taskService = new TaskService(database.adapter);
const taskRunner = new TaskRunner(taskService, agent);
taskService.setTaskRunner(taskRunner);
agent.setTaskRunner(taskRunner);

const workerManager = new WorkerManagerService(projectRoot);

const orgService = new OrgService(database.adapter, authService);
const orgMemoryService = new OrgMemoryService(database.adapter, {
  approvedBulletMerger: {
    merge(content, bullet, options) {
      return mergeOrgMemoryWithApprovedBullet(content, bullet, {
        dateUtc: options.dateUtc,
        pin: options.pin,
        provider: bootstrapCapabilityProvider ?? undefined,
      });
    },
  },
});
const skillProposalService = new SkillProposalService(
  database.adapter,
  skillsService
);
agent.setSkillProposalService(skillProposalService);
const skillCuratorService = new SkillCuratorService(
  database.adapter,
  skillProposalService,
  async (input) => {
    const profile = await database.adapter.getProfile(input.profileId);
    if (!profile?.orgId) {
      return null;
    }
    const profileConfig = await agent.getUserConfigForOrg(profile.orgId);
    if (!profileConfig) {
      return null;
    }
    const selection = resolveProfileProviderSelection({
      defaultProviderId: profileConfig.defaultProviderId,
      profileModel: profile.model,
      providers: profileConfig.providers,
    });
    if (!selection) {
      return null;
    }
    const selectedProvider = createChatCapabilityAwareProvider({
      config: profileConfig,
      instance: selection.instance,
      modelId: selection.model,
    });
    if (!selectedProvider) {
      return null;
    }
    return generateSkillCuratorConsolidationMarkdown({
      losers: input.losers,
      provider: selectedProvider,
      winner: input.winner,
    });
  }
);
const skillSuggestionService = new SkillSuggestionService(
  database.adapter,
  skillsService,
  skillProposalService
);
agent.setSkillSuggestionService(skillSuggestionService);

const seedResult = await runFirstBootSeed({
  authService,
  databaseAdapter: database.adapter,
  orgService,
});
if (seedResult.providerWritten) {
  await agent.reloadAfterDataRestore();
}

const systemStatus = new SystemStatusService(
  agent,
  automationRunner,
  taskRunner,
  workerManager,
  mcpService,
  composioService,
  database.adapter
);

const webDistDir = resolveWebDistDir(projectRoot);
const app = createHonoApp({
  agent,
  authService,
  automationService,
  composioService,
  databaseAdapter: database.adapter,
  mcpService,
  onDataRestored: async () => {
    await database.reopen();
    await agent.reloadAfterDataRestore();
  },
  orgMemoryService,
  orgService,
  skillCuratorService,
  skillProposalService,
  skillSuggestionService,
  systemStatus,
  taskService,
  webDistDir,
  workerManager,
});

const server = startServer({
  canFallbackToNextPort,
  fetch: app.fetch,
  host,
  preferredPort: requestedPort,
});
const serverUrl = writeRuntimeServerUrl(
  `http://${server.hostname}:${server.port}`
);

registerRuntimeCleanup(server, serverUrl, database, mcpClientManager);

if (server.port !== requestedPort) {
  console.log(`Port ${requestedPort} is busy. Using ${server.port} instead.`);
}

console.log(`Atlas server listening on ${serverUrl}`);
console.log(`Atlas database ready at ${config.databaseUrl}`);

const officeBinary = await officeConverter.resolveConverterBinary();
if (officeBinary) {
  console.log(`Office preview converter ready (${officeBinary})`);
} else {
  console.warn(
    "LibreOffice (soffice) not found. PPTX/DOCX/XLSX thumbnails and fidelity previews are disabled until it is installed."
  );
}

void initializeOptionalServices({
  agent,
  database,
  mcpService,
  skillsService,
});

try {
  await workerManager.recoverDesiredWorkers();
} catch (error) {
  console.warn("Could not recover platform workers:", error);
}

if (webDistDir) {
  console.log(`Atlas web dashboard ready at ${serverUrl}`);
}

const humanUserCount = await database.adapter.countHumanUsers();
if (humanUserCount > 0 && !agent.providerConfigured) {
  console.warn(
    `Provider not configured — complete the setup wizard at ${serverUrl}/setup to enable chat and automations.`
  );
}

function parsePort(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_SERVER_PORT;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid ATLAS_PORT: ${value}`);
  }

  return port;
}

async function initializeOptionalServices(options: {
  mcpService: McpService;
  skillsService: SkillsService;
  agent: AgentService;
  database: Database;
}): Promise<void> {
  try {
    await options.mcpService.connectEnabledServers();
  } catch (error) {
    console.warn("Could not connect MCP servers:", error);
  }

  try {
    await ensureBundledSkillFiles();
  } catch (error) {
    console.warn("Could not install bundled skills:", error);
  }

  try {
    await options.skillsService.syncDiscoveredSkills();
    await ensureBundledSkillsAssigned(options.database.adapter);
  } catch (error) {
    console.warn("Could not sync skills:", error);
  }

  try {
    await options.agent.ensureSoulScaffolded();
  } catch (error) {
    console.warn("Could not scaffold soul templates:", error);
  }
}

function startServer(options: {
  host: string;
  preferredPort: number;
  canFallbackToNextPort: boolean;
  fetch: (request: Request) => Response | Promise<Response>;
}): ReturnType<typeof Bun.serve> {
  const lastPort = options.canFallbackToNextPort
    ? Math.min(options.preferredPort + 2000, 65_535)
    : options.preferredPort;
  let lastError: unknown;

  for (let port = options.preferredPort; port <= lastPort; port += 1) {
    try {
      return Bun.serve({
        async fetch(request, server: Server<undefined>) {
          const response = await options.fetch(request);
          disableBunIdleTimeoutForSse(request, response, server);
          return response;
        },
        hostname: options.host,
        idleTimeout: 255,
        port,
      });
    } catch (error) {
      if (!(isAddressInUseError(error) && options.canFallbackToNextPort)) {
        throw error;
      }

      lastError = error;
    }
  }

  throw (
    lastError ?? new Error("Failed to find an open port for the Atlas server.")
  );
}

function isAddressInUseError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

function registerRuntimeCleanup(
  server: ReturnType<typeof Bun.serve>,
  serverUrl: string,
  database: Database,
  mcpClientManager: McpClientManager
): void {
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    void mcpClientManager.disconnectAll();
    clearRuntimeServerUrl(serverUrl);
    database.close();
  };

  process.on("exit", cleanup);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      cleanup();
      server.stop(true);
      process.exit(0);
    });
  }
}

async function findRunningAtlasServerUrl(
  host: string,
  port: number
): Promise<string | null> {
  const serverUrl = `http://${normalizeHealthCheckHost(host)}:${port}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 400);

  try {
    const response = await fetch(`${serverUrl}/health`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      apiVersion?: number;
    };
    const hasTaskChat = await serverHasTaskChat(serverUrl, controller.signal);
    return payload.ok === true &&
      payload.apiVersion === ATLAS_API_VERSION &&
      hasTaskChat
      ? serverUrl
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeHealthCheckHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    return DEFAULT_SERVER_HOST;
  }

  return host;
}
