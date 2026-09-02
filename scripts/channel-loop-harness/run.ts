import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@atlas/client";
import {
  ChannelOrgStore,
  getChannelOrgSelectionPath,
} from "@atlas/core/channel-org";
import { getDiscordConfigPath } from "@atlas/core/discord-config";
import { writePrivateTextFile } from "@atlas/core/fs";
import {
  createWorkspaceWorkerAuthToken,
  loadLocalAuthToken,
} from "@atlas/core/local-auth";
import { getTelegramConfigPath } from "@atlas/core/telegram-config";
import { getWhatsAppConfigPath } from "@atlas/core/whatsapp-config";
import { DiscordAuthStore } from "../../apps/platform/discord/src/auth-store";
import {
  createChatHandler as createDiscordChatHandler,
  resetChatLocksForTests as resetDiscordLocks,
} from "../../apps/platform/discord/src/chat-handler";
import { SessionStore as DiscordSessionStore } from "../../apps/platform/discord/src/session-store";
import { ThreadStore } from "../../apps/platform/discord/src/thread-store";
import { TelegramAuthStore } from "../../apps/platform/telegram/src/auth-store";
import {
  createChatHandler as createTelegramChatHandler,
  resetChatLocksForTests as resetTelegramLocks,
} from "../../apps/platform/telegram/src/chat-handler";
import { SessionStore as TelegramSessionStore } from "../../apps/platform/telegram/src/session-store";
import { WhatsAppAuthStore } from "../../apps/platform/whatsapp/src/auth-store";
import {
  createChatHandler as createWhatsAppChatHandler,
  resetChatLocksForTests as resetWhatsAppLocks,
} from "../../apps/platform/whatsapp/src/chat-handler";
import { SessionStore as WhatsAppSessionStore } from "../../apps/platform/whatsapp/src/session-store";
import { AuthService } from "../../apps/server/src/services/auth-service";
import { OrgService } from "../../apps/server/src/services/org-service";
import { AtlasServerHarness } from "../release-gate/atlas-server-harness";
import { provisionIsolatedEnvironment } from "../release-gate/environment-provisioner";
import { getFreePort } from "../release-gate/free-port";
import { MockLLMServerHarness } from "../release-gate/mock-llm-server-harness";
import { TestDatabaseHarness } from "../release-gate/test-database-harness";
import { TestTenantFactory } from "../release-gate/test-factories";
import { notesTxt, salesCsv, salesXlsx } from "./fixtures";
import {
  registerChannelLoopScenarios,
  runChannelLoopScenarios,
  type ScenarioResult,
} from "./scenarios";
import {
  createWhatsAppSocketProbe,
  installFileFetchInterceptor,
} from "./transports";

export interface ChannelLoopHarnessResult {
  failed: number;
  passed: number;
  reportPath: string;
  results: ScenarioResult[];
}

export async function runChannelLoopHarness(): Promise<ChannelLoopHarnessResult> {
  const hostTmp = tmpdir();
  const mockPort = await getFreePort();
  const serverPort = await getFreePort();
  const env = await provisionIsolatedEnvironment({ mockPort });

  writeFileSync(
    env.configPath,
    readFileSync(env.configPath, "utf8").replace(
      "thinking_enabled = true",
      "thinking_enabled = false"
    ),
    "utf8"
  );

  const previousWebPublicUrl = process.env.ATLAS_WEB_PUBLIC_URL;
  const previousWorkspaceId = process.env.ATLAS_WORKSPACE_ID;
  process.env.ATLAS_WEB_PUBLIC_URL = `http://127.0.0.1:${serverPort}`;

  let dbHarness: TestDatabaseHarness | null = null;
  let mockLlm: MockLLMServerHarness | null = null;
  let atlasServer: AtlasServerHarness | null = null;
  let restoreFetch: (() => void) | undefined;

  console.log("============================================================");
  console.log("CHANNEL LOOP HARNESS");
  console.log("============================================================");
  console.log(`[env] ${env.root}`);

  try {
    dbHarness = new TestDatabaseHarness(env.databaseUrl, env.configDir);
    const dbAdapter = await dbHarness.initialize();
    const authService = new AuthService();
    const orgService = new OrgService(dbAdapter, authService);

    mockLlm = new MockLLMServerHarness();
    await mockLlm.start(mockPort);
    registerChannelLoopScenarios(mockLlm);
    console.log(`[mock-llm] ${mockLlm.baseUrl}`);

    const tenantFactory = new TestTenantFactory(
      orgService,
      authService,
      dbAdapter
    );
    const tenant = await tenantFactory.createTenant({
      adminEmail: "channel-loop@atlas.local",
      adminName: "Channel Loop",
      name: "Channel Loop Org",
    });
    process.env.ATLAS_WORKSPACE_ID = tenant.orgId;

    await loadLocalAuthToken();
    await writeChannelConfigs();
    const channelUserIds: Array<{
      channel: "telegram" | "whatsapp" | "discord";
      channelUserId: string;
    }> = [
      { channel: "telegram", channelUserId: "4242" },
      { channel: "telegram", channelUserId: "4243" },
      { channel: "discord", channelUserId: "424242424242424242" },
      { channel: "discord", channelUserId: "424242424242424243" },
      { channel: "whatsapp", channelUserId: "6281111111111@s.whatsapp.net" },
      { channel: "whatsapp", channelUserId: "6282000000001@s.whatsapp.net" },
      { channel: "whatsapp", channelUserId: "6282000000002@s.whatsapp.net" },
      { channel: "whatsapp", channelUserId: "6282000000003@s.whatsapp.net" },
      { channel: "whatsapp", channelUserId: "6282000000004@s.whatsapp.net" },
      { channel: "whatsapp", channelUserId: "6282000000009@s.whatsapp.net" },
      { channel: "whatsapp", channelUserId: "236283431522503@lid" },
    ];
    const mappedAt = new Date().toISOString();
    for (const principal of channelUserIds) {
      await dbAdapter.upsertChannelOrgMapping({
        ...principal,
        createdAt: mappedAt,
        orgId: tenant.orgId,
        userId: tenant.adminId,
      });
    }
    resetWhatsAppLocks();
    resetTelegramLocks();
    resetDiscordLocks();

    atlasServer = new AtlasServerHarness({
      env,
      preferredPort: serverPort,
    });
    const { baseUrl } = await atlasServer.start(30_000);
    console.log(`[atlas] ${baseUrl}`);

    const authToken = await loadLocalAuthToken();
    if (!authToken) {
      throw new Error("Failed to mint local auth token for the isolated env.");
    }

    const client = createClient({
      authToken,
      baseUrl,
      orgId: tenant.orgId,
    });

    const createWorkerClient = async (
      channel: "discord" | "telegram" | "whatsapp"
    ) =>
      createClient({
        authToken: await createWorkspaceWorkerAuthToken({
          channel,
          orgId: tenant.orgId,
        }),
        baseUrl,
        orgId: tenant.orgId,
        tokenAuth: true,
      });
    const [discordClient, telegramClient, whatsappClient] = await Promise.all([
      createWorkerClient("discord"),
      createWorkerClient("telegram"),
      createWorkerClient("whatsapp"),
    ]);

    const profiles = await client.listProfiles();
    const profile =
      profiles.profiles.find((item) => item.isDefault) ?? profiles.profiles[0];
    if (!profile) {
      throw new Error("No profile available after tenant bootstrap.");
    }

    const csv = salesCsv();
    const notes = notesTxt();
    const xlsx = await salesXlsx();
    restoreFetch = installFileFetchInterceptor(
      new Map([
        [
          `documents/${csv.filename}`,
          { bytes: csv.bytes, contentType: csv.mediaType },
        ],
        [
          `documents/${xlsx.filename}`,
          { bytes: xlsx.bytes, contentType: xlsx.mediaType },
        ],
        [
          `documents/${notes.filename}`,
          { bytes: notes.bytes, contentType: notes.mediaType },
        ],
        [
          `cdn.channel-loop.test/${xlsx.filename}`,
          { bytes: xlsx.bytes, contentType: xlsx.mediaType },
        ],
      ])
    );

    const whatsappProbe = createWhatsAppSocketProbe();
    const authStore = new WhatsAppAuthStore();
    await authStore.reload();
    const whatsappSessions = new WhatsAppSessionStore();
    await whatsappSessions.load();
    const whatsappOrgs = new ChannelOrgStore(
      getChannelOrgSelectionPath("whatsapp")
    );
    await whatsappOrgs.load();
    const whatsappHandle = createWhatsAppChatHandler({
      authStore,
      client: whatsappClient,
      config: { phoneNumber: "1234567890", profileId: "default" },
      downloadMedia: (message) => whatsappProbe.probe.download(message),
      fixedWorkspaceId: tenant.orgId,
      getSocket: () => whatsappProbe.probe.socket as never,
      orgStore: whatsappOrgs,
      sessionStore: whatsappSessions,
    });

    const telegramAuth = new TelegramAuthStore();
    await telegramAuth.reload();
    const telegramSessions = new TelegramSessionStore();
    await telegramSessions.load();
    const telegramOrgs = new ChannelOrgStore(
      getChannelOrgSelectionPath("telegram")
    );
    await telegramOrgs.load();
    const telegramHandle = createTelegramChatHandler({
      authStore: telegramAuth,
      client: telegramClient,
      config: { botToken: "1234567890:CHANNELLOOP", profileId: "default" },
      fixedWorkspaceId: tenant.orgId,
      orgStore: telegramOrgs,
      sessionStore: telegramSessions,
    });

    const discordAuth = new DiscordAuthStore();
    await discordAuth.reload();
    const discordSessions = new DiscordSessionStore();
    await discordSessions.load();
    const discordOrgs = new ChannelOrgStore(
      getChannelOrgSelectionPath("discord")
    );
    await discordOrgs.load();
    const threadStore = new ThreadStore();
    await threadStore.load();
    const discordHandler = createDiscordChatHandler({
      authStore: discordAuth,
      client: discordClient,
      config: { botToken: "discord-bot-token", profileId: "default" },
      fixedWorkspaceId: tenant.orgId,
      orgStore: discordOrgs,
      sessionStore: discordSessions,
      threadStore,
    });

    const results = await runChannelLoopScenarios({
      authStore,
      client,
      discordHandle: (message) => discordHandler.handleMessage(message),
      mockLlm,
      orgId: tenant.orgId,
      profileId: profile.id,
      reloadWhatsAppConfig: async (ini) => {
        await writePrivateTextFile(getWhatsAppConfigPath(), ini);
        await authStore.reload();
      },
      telegramHandle,
      whatsapp: {
        handle: whatsappHandle,
        sent: whatsappProbe.probe.sent,
        setDownload: whatsappProbe.setDownload,
      },
    });

    const reportPath = join(hostTmp, "atlas-channel-loop-report.json");
    const passed = results.filter((item) => item.status === "pass").length;
    const failed = results.filter((item) => item.status === "fail").length;
    const report = {
      failed,
      passed,
      results,
      runId: env.root,
      serverLogsTail: atlasServer.logs.slice(-40),
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    for (const result of results) {
      const mark = result.status === "pass" ? "PASS" : "FAIL";
      console.log(`[${mark}] ${result.id} (${result.durationMs}ms)`);
      if (result.status === "fail") {
        console.log(`       ${result.message}`);
      }
      for (const line of result.evidence) {
        console.log(`       ${line}`);
      }
    }

    console.log("------------------------------------------------------------");
    console.log(`${passed} passed, ${failed} failed`);
    console.log(`[report] ${reportPath}`);

    return { failed, passed, reportPath, results };
  } finally {
    restoreFetch?.();
    if (atlasServer) {
      await atlasServer.stop();
    }
    if (mockLlm) {
      await mockLlm.stop();
    }
    if (dbHarness) {
      await dbHarness.close();
    }
    await env.destroy();
    if (previousWebPublicUrl === undefined) {
      delete process.env.ATLAS_WEB_PUBLIC_URL;
    } else {
      process.env.ATLAS_WEB_PUBLIC_URL = previousWebPublicUrl;
    }
    if (previousWorkspaceId === undefined) {
      delete process.env.ATLAS_WORKSPACE_ID;
    } else {
      process.env.ATLAS_WORKSPACE_ID = previousWorkspaceId;
    }
  }
}

async function writeChannelConfigs(): Promise<void> {
  await writePrivateTextFile(
    getWhatsAppConfigPath(),
    [
      "# Atlas WhatsApp bridge",
      "phone_number=1234567890",
      "profile_id=default",
      "access_mode=open",
      "paired_jid=6281111111111@s.whatsapp.net",
      "",
    ].join("\n")
  );

  await writePrivateTextFile(
    getTelegramConfigPath(),
    [
      "# Atlas Telegram bridge",
      "bot_token=1234567890:CHANNELLOOP",
      "profile_id=default",
      "paired_user_ids=4242,4243",
      "allowed_user_ids=4242,4243",
      "",
    ].join("\n")
  );

  await writePrivateTextFile(
    getDiscordConfigPath(),
    [
      "# Atlas Discord bridge",
      "bot_token=discord-bot-token",
      "profile_id=default",
      "paired_user_ids=424242424242424242,424242424242424243",
      "",
    ].join("\n")
  );
}

const isDirectRun = import.meta.main;

if (isDirectRun) {
  const result = await runChannelLoopHarness();
  process.exit(result.failed > 0 ? 1 : 0);
}
