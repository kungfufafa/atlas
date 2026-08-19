import { loadDiscordConfigFile } from "./discord-config";
import { loadTelegramConfigFile } from "./telegram-config";
import {
  loadWhatsAppConfigFile,
  normalizePhoneNumberDigits,
} from "./whatsapp-config";
import { listConfiguredChannelWorkspaceIds } from "./workspace-channel-paths";

export const TELEGRAM_BOT_TOKEN_IN_USE_MESSAGE =
  "This bot token is already used by another workspace.";
export const DISCORD_BOT_TOKEN_IN_USE_MESSAGE =
  "This bot token is already used by another workspace.";
export const WHATSAPP_PHONE_IN_USE_MESSAGE =
  "This phone number is already used by another workspace.";

export async function telegramBotTokenUsedByAnotherWorkspace(
  orgId: string,
  botToken: string
): Promise<boolean> {
  const token = botToken.trim();
  if (!token) {
    return false;
  }

  const workspaces = await listConfiguredChannelWorkspaceIds("telegram");
  for (const workspaceId of workspaces) {
    if (workspaceId === orgId) {
      continue;
    }

    const config = await loadTelegramConfigFile(workspaceId);
    if (config?.botToken === token) {
      return true;
    }
  }

  return false;
}

export async function discordBotTokenUsedByAnotherWorkspace(
  orgId: string,
  botToken: string
): Promise<boolean> {
  const token = botToken.trim();
  if (!token) {
    return false;
  }

  const workspaces = await listConfiguredChannelWorkspaceIds("discord");
  for (const workspaceId of workspaces) {
    if (workspaceId === orgId) {
      continue;
    }

    const config = await loadDiscordConfigFile(workspaceId);
    if (config?.botToken === token) {
      return true;
    }
  }

  return false;
}

export async function whatsAppPhoneUsedByAnotherWorkspace(
  orgId: string,
  phoneNumber: string
): Promise<boolean> {
  const digits = normalizePhoneNumberDigits(phoneNumber);
  if (!digits) {
    return false;
  }

  const workspaces = await listConfiguredChannelWorkspaceIds("whatsapp");
  for (const workspaceId of workspaces) {
    if (workspaceId === orgId) {
      continue;
    }

    const config = await loadWhatsAppConfigFile(workspaceId);
    if (config && normalizePhoneNumberDigits(config.phoneNumber) === digits) {
      return true;
    }
  }

  return false;
}
