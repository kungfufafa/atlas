import { createClient } from "@atlas/client";
import { loadOrCreateWhatsAppOutboundAuthToken } from "@atlas/core";
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
import { syncWhatsAppOwnerPairing } from "@atlas/core/whatsapp-config";
import {
  clearWhatsAppDevicePairingCode,
  clearWhatsAppQrCode,
  clearWhatsAppWorkerHeartbeat,
  isWhatsAppHeartbeatAlive,
  readWhatsAppWorkerHeartbeat,
  writeWhatsAppDevicePairingCode,
  writeWhatsAppQrCode,
  writeWhatsAppWorkerHeartbeat,
} from "@atlas/core/whatsapp-worker";
import { WhatsAppAuthStore } from "./auth-store";
import { createChatHandler } from "./chat-handler";
import { loadConfig } from "./config";
import { resolveWhatsAppChannelOrgKey } from "./group-message";
import { allowUnaddressedWhatsAppGroup } from "./group-policy";
import { startWhatsAppOutboundServer } from "./outbound-server";
import { SessionStore } from "./session-store";
import { createWhatsAppSocket } from "./socket";

installErrorHandlers("worker:whatsapp");
await installErrorTrackingSink();

let spawnedChild: Bun.Subprocess | null = null;
let socketHandle: {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  socket: {
    sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
  } | null;
} | null = null;
let outboundServer: { port: number; stop: () => void } | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let bridgeConnected = false;

function persistWorkerHeartbeat(): void {
  void writeWhatsAppWorkerHeartbeat(
    process.pid,
    new Date().toISOString(),
    bridgeConnected
  );
}

registerProcessLifecycleLogging();
registerCleanupHandlers(async () => {
  outboundServer?.stop();
  await socketHandle?.stop();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  await clearWhatsAppWorkerHeartbeat();
  await clearWhatsAppQrCode();
  await clearWhatsAppDevicePairingCode();
  stopSpawnedServer(spawnedChild);
});

try {
  const workspaceId = process.env.ATLAS_WORKSPACE_ID?.trim() || undefined;
  const existingHeartbeat = await readWhatsAppWorkerHeartbeat();

  if (
    existingHeartbeat &&
    existingHeartbeat.pid !== process.pid &&
    isWhatsAppHeartbeatAlive(existingHeartbeat)
  ) {
    console.error(
      `Another Atlas WhatsApp bridge is already running (pid ${existingHeartbeat.pid}). ` +
        "Stop the existing bridge worker or disable it in the dashboard before starting a new one."
    );
    process.exit(1);
  }

  const config = await loadConfig(process.env, workspaceId);
  const { serverUrl, spawnedChild: child } = await ensureServerRunning();
  spawnedChild = child;

  const client = createClient({
    authToken: await loadPlatformWorkerAuthToken("whatsapp", workspaceId),
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

  if (workspaceId) {
    await client.listProfiles();
  }

  const sessionStore = new SessionStore();
  await sessionStore.load();

  const orgStore = new ChannelOrgStore(
    getChannelOrgSelectionPath("whatsapp", workspaceId)
  );
  await orgStore.load();

  const authStore = new WhatsAppAuthStore(workspaceId);
  await authStore.reload();

  const handleMessage = createChatHandler({
    authStore,
    client,
    config,
    fixedWorkspaceId: workspaceId,
    getSocket: () =>
      socketHandle ? ((socketHandle as any).socket ?? null) : null,
    orgStore,
    sessionStore,
  });

  const socket = await createWhatsAppSocket({
    allowUnaddressedGroup: (inbound) =>
      allowUnaddressedWhatsAppGroup(
        workspaceId ??
          orgStore.get(resolveWhatsAppChannelOrgKey(inbound.jid, true))?.orgId,
        inbound
      ),
    onConnected: (me) => {
      bridgeConnected = true;
      persistWorkerHeartbeat();
      console.log("WhatsApp connected.");
      void clearWhatsAppQrCode();
      void clearWhatsAppDevicePairingCode();
      void syncWhatsAppOwnerPairing({
        orgId: workspaceId,
        ownerJid: me.id,
        ownerLid: me.lid,
      }).then(() => authStore.reload());
    },
    onDevicePairingCode: (code) => {
      console.log(
        "WhatsApp pairing code ready. Enter it under Linked Devices."
      );
      void writeWhatsAppDevicePairingCode(code);
    },
    onDisconnected: () => {
      bridgeConnected = false;
      persistWorkerHeartbeat();
    },
    onMessage: handleMessage,
    onPhoneNumberShare: (lid, phoneJid) => {
      void authStore.rememberSenderPn(lid, phoneJid);
    },
    onQr: (qr) => {
      void writeWhatsAppQrCode(qr);
    },
    onReaction: handleMessage.onReaction,
    phoneNumber: config.phoneNumber,
  });

  socketHandle = socket;

  const outboundAuthorizationToken =
    await loadOrCreateWhatsAppOutboundAuthToken(workspaceId);

  outboundServer = await startWhatsAppOutboundServer({
    authorizationToken: outboundAuthorizationToken,
    getSendHandle: () => {
      const activeSocket = socketHandle?.socket;

      if (!activeSocket) {
        return null;
      }

      return {
        invalidate: () => {
          const currentHandle = socketHandle;
          if (!currentHandle || currentHandle.socket !== activeSocket) {
            return true;
          }

          bridgeConnected = false;
          persistWorkerHeartbeat();
          void currentHandle.start().catch((error) => {
            console.error(
              "WhatsApp socket restart after outbound timeout failed.",
              {
                errorType: error instanceof Error ? error.name : typeof error,
              }
            );
          });
          return currentHandle.socket !== activeSocket;
        },
        sendMessage: (jid, content) => activeSocket.sendMessage(jid, content),
      };
    },
    orgId: workspaceId,
  });

  console.log(
    `WhatsApp outbound server listening on 127.0.0.1:${outboundServer.port}`
  );

  const authConfig = authStore.getConfig();
  const paired = authConfig?.pairedJid ? "yes" : "no";
  const pendingCode = authConfig?.pairingCode ? "yes" : "no";
  console.log(
    `Atlas WhatsApp bridge · ${serverUrl} · workspace ${workspaceId ?? "legacy selectable mode"} · profile ${config.profileId} · paired ${paired} · pairing code ${pendingCode}`
  );

  await socket.start();

  await writeWhatsAppWorkerHeartbeat(
    process.pid,
    new Date().toISOString(),
    bridgeConnected
  );
  heartbeatTimer = setInterval(() => {
    persistWorkerHeartbeat();
  }, 15_000);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  outboundServer?.stop();
  try {
    await socketHandle?.stop();
  } catch {
    // Socket stop is best-effort during fatal startup cleanup.
  }
  await clearWhatsAppWorkerHeartbeat();
  await clearWhatsAppQrCode();
  await clearWhatsAppDevicePairingCode();
  stopSpawnedServer(spawnedChild);
  process.exit(1);
}

function registerCleanupHandlers(cleanup: () => void | Promise<void>): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      console.log(`WhatsApp worker received ${signal}. Shutting down.`);
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

function registerProcessLifecycleLogging(): void {
  process.on("exit", (code) => {
    console.log(`WhatsApp worker exiting with code ${code}.`);
  });
}
