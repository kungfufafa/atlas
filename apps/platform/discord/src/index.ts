import { createClient } from "@atlas/client";
import {
  ChannelOrgStore,
  getChannelOrgSelectionPath,
} from "@atlas/core/channel-org";
import {
  clearDiscordWorkerHeartbeat,
  isHeartbeatAlive,
  readDiscordWorkerHeartbeat,
  writeDiscordWorkerHeartbeat,
} from "@atlas/core/discord-worker";
import {
  ensureServerRunning,
  stopSpawnedServer,
} from "@atlas/core/ensure-server";
import { installErrorHandlers } from "@atlas/core/error-tracking";
import { installErrorTrackingSink } from "@atlas/core/error-tracking-sentry";
import { loadPlatformWorkerAuthToken } from "@atlas/core/local-auth";
import { resolveWebPublicUrl } from "@atlas/core/runtime";
import { DiscordAuthStore } from "./auth-store";
import { createBot } from "./bot";
import { loadConfig } from "./config";
import { SessionStore } from "./session-store";
import { ThreadStore } from "./thread-store";

installErrorHandlers("worker:discord");
await installErrorTrackingSink();

let spawnedChild: Bun.Subprocess | null = null;
let clientStop: (() => Promise<void>) | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

registerCleanupHandlers(async () => {
  await clientStop?.();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  await clearDiscordWorkerHeartbeat();
  stopSpawnedServer(spawnedChild);
});

try {
  const workspaceId = process.env.ATLAS_WORKSPACE_ID?.trim() || undefined;
  const existingHeartbeat = await readDiscordWorkerHeartbeat();

  if (
    existingHeartbeat &&
    existingHeartbeat.pid !== process.pid &&
    isHeartbeatAlive(existingHeartbeat)
  ) {
    console.error(
      `Another Atlas Discord bridge is already running (pid ${existingHeartbeat.pid}). ` +
        "Stop the existing bridge worker or disable it in the dashboard before starting a new one."
    );
    process.exit(1);
  }

  const config = await loadConfig(process.env, workspaceId);
  const { serverUrl, spawnedChild: child } = await ensureServerRunning({
    autoStart: false,
  });
  spawnedChild = child;

  const client = createClient({
    authToken: await loadPlatformWorkerAuthToken("discord", workspaceId),
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

  const threadStore = new ThreadStore();
  await threadStore.load();

  const orgStore = new ChannelOrgStore(
    getChannelOrgSelectionPath("discord", workspaceId)
  );
  await orgStore.load();

  const authStore = new DiscordAuthStore(workspaceId);
  await authStore.reload();

  const discord = await createBot(config, {
    authStore,
    client,
    fixedWorkspaceId: workspaceId,
    orgStore,
    sessionStore,
    threadStore,
  });

  console.log("Atlas Discord bridge running.");
  console.log(`Server: ${serverUrl}`);
  console.log(`Profile: ${config.profileId}`);
  console.log(`Workspace: ${workspaceId ?? "legacy selectable mode"}`);
  const authConfig = authStore.getConfig();
  const paired = authConfig?.pairedUserIds.length ?? 0;
  const pendingHandshake = authConfig?.handshakeCode ? "yes" : "no";
  console.log(
    `Paired users: ${paired} · Pending handshake: ${pendingHandshake}`
  );
  console.log(`Bot: ${discord.user.tag}`);

  clientStop = async () => {
    await discord.destroy();
  };

  await writeDiscordWorkerHeartbeat(
    process.pid,
    new Date().toISOString(),
    true
  );
  heartbeatTimer = setInterval(() => {
    void writeDiscordWorkerHeartbeat(
      process.pid,
      new Date().toISOString(),
      true
    );
  }, 15_000);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    await clientStop?.();
  } catch {
    // Destroy is best-effort during fatal startup cleanup.
  }
  await clearDiscordWorkerHeartbeat();
  stopSpawnedServer(spawnedChild);
  process.exit(1);
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
