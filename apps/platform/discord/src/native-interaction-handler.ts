import { MessageFlags } from "discord.js";
import type {
  DiscordCallbackBinding,
  DiscordCallbackRegistry,
} from "./native-callbacks";
import type {
  DiscordNativeCallback,
  DiscordNativeInteraction,
} from "./native-questionnaire";

export async function handleDiscordNativeInteraction(input: {
  authorize(
    binding: DiscordCallbackBinding,
    callback: DiscordNativeCallback
  ): Promise<void>;
  interaction: DiscordNativeInteraction;
  registry: DiscordCallbackRegistry<DiscordNativeCallback>;
}): Promise<boolean> {
  const { interaction } = input;
  if (!interaction.customId.startsWith("atlas:")) {
    return false;
  }
  const ticket = input.registry.claim(interaction.customId, {
    channelId: interaction.channelId ?? "",
    channelUserId: interaction.user.id,
    guildId: interaction.guildId,
    messageId: interaction.message?.id ?? null,
  });
  if (!ticket) {
    await interaction.reply({
      content: "This control is unavailable for this message or account.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  try {
    if (!ticket.value.opensModal) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    await input.authorize(ticket.binding, ticket.value);
    await ticket.value.execute(interaction);
    if (interaction.deferred) {
      await interaction.editReply({ content: "Done." });
    }
  } catch {
    const content =
      "This action is unavailable. Check your current access and start a new request.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  }
  return true;
}
