import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDiscordConfigFile } from "@atlas/core/discord-config";
import { loadTelegramConfigFile } from "@atlas/core/telegram-config";
import { loadWhatsAppConfigFile } from "@atlas/core/whatsapp-config";
import {
  getWorkspaceChannelDir,
  listConfiguredChannelWorkspaceIds,
} from "@atlas/core/workspace-channel-paths";
import { digest, type Messenger } from "./live-messengers";

/** Local filesystem only. Does not load public-settings helpers that may call bot APIs. */
export async function inspectMessengerPrerequisites() {
  const loaders = {
    discord: loadDiscordConfigFile,
    telegram: loadTelegramConfigFile,
    whatsapp: loadWhatsAppConfigFile,
  };
  const rows = [];
  for (const channel of ["telegram", "discord", "whatsapp"] as Messenger[]) {
    const orgs = await listConfiguredChannelWorkspaceIds(channel);
    const configurations = [];
    for (const orgId of orgs) {
      const config = await loaders[channel](orgId);
      if (!config) {
        continue;
      }
      let workerAlive = false;
      let connected = false;
      try {
        const h = JSON.parse(
          await readFile(
            join(
              getWorkspaceChannelDir(channel, orgId),
              "worker-heartbeat.json"
            ),
            "utf8"
          )
        ) as { pid: number; updatedAt: string; connected?: boolean };
        if (
          Number.isSafeInteger(h.pid) &&
          h.pid > 0 &&
          Date.now() - Date.parse(h.updatedAt) < 45_000
        ) {
          process.kill(h.pid, 0);
          workerAlive = true;
          connected = h.connected === true;
        }
      } catch {
        /* No process is started, restarted or stopped. */
      }
      configurations.push({
        accessMode: config.accessMode,
        allowCount:
          "allowedUserIds" in config
            ? config.allowedUserIds.length
            : config.allowedNumbers.length,
        blockCount:
          "blockedUserIds" in config
            ? config.blockedUserIds.length
            : config.blockedNumbers.length,
        configured: true,
        connected,
        credentialPresent:
          "botToken" in config
            ? Boolean(config.botToken)
            : Boolean(config.phoneNumber),
        orgRef: digest(orgId).slice(0, 12),
        pairedCount:
          "pairedUserIds" in config
            ? config.pairedUserIds.length
            : Number(Boolean(config.pairedJid)),
        profileConfigured: Boolean(config.profileId),
        workerAlive,
      });
    }
    const legacy = await loaders[channel](null);
    rows.push({
      channel,
      legacyConfigurationPresent: Boolean(legacy),
      legacyProof: legacy
        ? "UNSUPPORTED_UNSCOPED_CREDENTIALS"
        : "NOT_CONFIGURED",
      scopedConfigurations: configurations,
    });
  }
  return {
    capturedAt: new Date().toISOString(),
    channels: rows,
    messagesSent: 0,
    networkRequests: 0,
  };
}

if (import.meta.main) {
  inspectMessengerPrerequisites()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch(() => {
      console.log(
        JSON.stringify({
          messagesSent: 0,
          networkRequests: 0,
          reason: "LOCAL_INVENTORY_FAILED_DETAILS_REDACTED",
          status: "BLOCKED",
        })
      );
      process.exitCode = 2;
    });
}
