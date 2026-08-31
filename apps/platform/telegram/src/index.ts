import { createClient } from "@atlas/client";
import {
  ChannelOrgStore,
  getChannelOrgSelectionPath,
} from "@atlas/core/channel-org";
import {
  ensureServerRunning,
  stopSpawnedServer,
} from "@atlas/core/ensure-server";
import { installErrorHandlers } from "@atlas/core/error-tracking";
import { installErrorTrackingSink } from "@atlas/core/error-tracking-sentry";
import { loadPlatformWorkerAuthToken } from "@atlas/core/local-auth";
import { resolveWebPublicUrl } from "@atlas/core/runtime";
import {
  clearTelegramWorkerHeartbeat,
  isHeartbeatAlive,
  readTelegramWorkerHeartbeat,
  writeTelegramWorkerHeartbeat,
} from "@atlas/core/telegram-worker";
import { TelegramAuthStore } from "./auth-store";
import { createBot } from "./bot";
import { loadConfig } from "./config";
import { SessionStore } from "./session-store";

installErrorHandlers("worker:telegram");
await installErrorTrackingSink();

let spawnedChild: Bun.Subprocess | null = null;
let botStop: (() => void) | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

registerCleanupHandlers(async () => {
  botStop?.();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  await clearTelegramWorkerHeartbeat();
  stopSpawnedServer(spawnedChild);
});

try {
  const workspaceId = process.env.ATLAS_WORKSPACE_ID?.trim() || undefined;
  const existingHeartbeat = await readTelegramWorkerHeartbeat();

  if (
    existingHeartbeat &&
    existingHeartbeat.pid !== process.pid &&
    isHeartbeatAlive(existingHeartbeat)
  ) {
    console.error(
      `Another Atlas Telegram bridge is already running (pid ${existingHeartbeat.pid}). ` +
        "Stop the existing bridge worker or disable it in the dashboard before starting a new one."
    );
    process.exit(1);
  }

  const config = await loadConfig(process.env, workspaceId);
  const { serverUrl, spawnedChild: child } = await ensureServerRunning();
  spawnedChild = child;

  const client = createClient({
    authToken: await loadPlatformWorkerAuthToken("telegram", workspaceId),
    baseUrl: serverUrl,
    clientOrigin: resolveWebPublicUrl(),
    orgId: workspaceId,
    tokenAuth: Boolean(workspaceId),
  });
  const health = await client.health();

  if (!health.providerConfigured) {
    console.warn(
      "Server has no provider configured. Chat runs in offline mode until an API key is set."
    );
  }

  try {
    if (workspaceId) {
      await client.listProfiles();
    } else {
      await client.listUserOrgs();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Atlas API authentication failed: ${message}\n` +
        "Restart the server so it can provision the local client user:\n" +
        "  bun run dev:server"
    );
    process.exit(1);
  }

  const sessionStore = new SessionStore();
  await sessionStore.load();

  const orgStore = new ChannelOrgStore(
    getChannelOrgSelectionPath("telegram", workspaceId)
  );
  await orgStore.load();

  const authStore = new TelegramAuthStore(workspaceId);
  await authStore.reload();

  const bot = await createBot(config, {
    authStore,
    client,
    fixedWorkspaceId: workspaceId,
    orgStore,
    sessionStore,
  });

  console.log("Atlas Telegram bridge running (long polling).");
  console.log(`Server: ${serverUrl}`);
  console.log(`Profile: ${config.profileId}`);
  console.log(`Workspace: ${workspaceId ?? "legacy selectable mode"}`);
  const authConfig = authStore.getConfig();
  const paired = authConfig?.pairedUserIds.length ?? 0;
  const pendingHandshake = authConfig?.handshakeCode ? "yes" : "no";
  console.log(
    `Paired users: ${paired} · Pending handshake: ${pendingHandshake}`
  );

  botStop = () => bot.stop();

  await writeTelegramWorkerHeartbeat();
  heartbeatTimer = setInterval(() => {
    void writeTelegramWorkerHeartbeat();
  }, 15_000);

  await bot.start({
    onStart: (info) => {
      console.log(`Bot @${info.username} is listening.`);
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  botStop?.();
  await clearTelegramWorkerHeartbeat();
  stopSpawnedServer(spawnedChild);
  process.exit(1);
} finally {
  stopSpawnedServer(spawnedChild);
}

function registerCleanupHandlers(cleanup: () => void | Promise<void>): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      void (async () => {
        try {
          await cleanup();
        } finally {
          process.exit(0);
        }
      })();
    });
  }
}
