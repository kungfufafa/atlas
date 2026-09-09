import {
  isDiscordSnowflake,
  loadDiscordConfigFile,
  loadTelegramConfigFile,
  loadWhatsAppConfigFile,
  PrincipalRequiredError,
} from "@atlas/core";
import {
  authorizeExternalActorFromWorkspaceConfig,
  type ChannelGuestPrincipalInput,
  normalizeExternalActor,
} from "./channel-guest-principal-service";

/** A pairing code can admit a new sender, but cannot override an active block. */
export async function assertChannelPairingAllowed(
  input: ChannelGuestPrincipalInput
): Promise<void> {
  const actor = await normalizeExternalActor(input);
  const sender = actor.primaryChannelUserId;
  if (input.channel === "telegram") {
    const id = Number(sender);
    if (!(/^\d+$/.test(sender) && Number.isSafeInteger(id)) || id <= 0) {
      throw new PrincipalRequiredError("Invalid Telegram sender identity.");
    }
  }
  if (input.channel === "discord" && !isDiscordSnowflake(sender)) {
    throw new PrincipalRequiredError("Invalid Discord sender identity.");
  }
  const config =
    input.channel === "telegram"
      ? await loadTelegramConfigFile(input.orgId)
      : input.channel === "discord"
        ? await loadDiscordConfigFile(input.orgId)
        : await loadWhatsAppConfigFile(input.orgId);
  if (!config) {
    throw new PrincipalRequiredError("Workspace channel is not configured.");
  }
  if (
    config.accessMode === "denylist" &&
    !(await authorizeExternalActorFromWorkspaceConfig({
      ...input,
      channelUserAliases: actor.channelUserIds.filter(
        (id) => id !== actor.primaryChannelUserId
      ),
      channelUserId: actor.primaryChannelUserId,
    }))
  ) {
    throw new PrincipalRequiredError("This channel sender is blocked.");
  }
}
