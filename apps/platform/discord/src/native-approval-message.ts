import type { ApprovalRequest } from "@atlas/core/contract";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { DiscordMessenger } from "./messenger";
import type {
  DiscordCallbackBinding,
  DiscordCallbackRegistry,
} from "./native-callbacks";
import type { DiscordNativeCallback } from "./native-questionnaire";

export async function sendDiscordNativeApproval(input: {
  approval: ApprovalRequest;
  binding: DiscordCallbackBinding;
  decide(decision: "approved" | "denied"): Promise<unknown>;
  messenger: DiscordMessenger;
  registry: DiscordCallbackRegistry<DiscordNativeCallback>;
}): Promise<void> {
  if (input.approval.status !== "pending" || !input.messenger.sendComponents) {
    throw new Error("Discord native approval delivery is unavailable");
  }
  let messageId: string | undefined;
  let decided = false;
  const tickets = (["approved", "denied"] as const).map((decision) =>
    input.registry.issue(input.binding, {
      execute: async () => {
        if (decided) {
          throw new Error("Discord approval decision was already submitted");
        }
        decided = true;
        for (const ticket of tickets) {
          ticket.revoke();
        }
        await input.decide(decision);
        if (messageId) {
          await input.messenger.editComponents?.(messageId, {
            components: [],
            content: decision === "approved" ? "Approved." : "Denied.",
          });
        }
      },
    })
  );
  try {
    const message = await input.messenger.sendComponents({
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(tickets[0]!.customId)
            .setLabel("Approve")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(tickets[1]!.customId)
            .setLabel("Deny")
            .setStyle(ButtonStyle.Danger)
        ),
      ],
      content:
        `${input.approval.title}\n\n${input.approval.consequenceSummary}`.slice(
          0,
          2000
        ),
    });
    messageId = message.id;
    for (const ticket of tickets) {
      ticket.bindMessage(messageId);
    }
  } catch (error) {
    for (const ticket of tickets) {
      ticket.revoke();
    }
    throw error;
  }
}
