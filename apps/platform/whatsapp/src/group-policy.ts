import {
  effectiveChannelRules,
  loadChannelIntegrationPolicy,
} from "@atlas/core/channel-integration-policy";
import type { WhatsAppInboundChat } from "./inbound-message";

export async function allowUnaddressedWhatsAppGroup(
  orgId: string | undefined,
  inbound: WhatsAppInboundChat
): Promise<boolean> {
  if (!(orgId && inbound.isGroup)) {
    return false;
  }
  const policy = await loadChannelIntegrationPolicy(orgId, "whatsapp");
  const rules = effectiveChannelRules(policy, "whatsapp", {
    channelChatId: inbound.jid,
    channelIsGroup: true,
    channelUserAliases: inbound.senderJids,
    channelUserId: inbound.senderJid,
  });
  return (
    policy.enabled !== false &&
    rules.some((rule) => rule.requireMention === false) &&
    !rules.some(
      (rule) => rule.requireMention === true || rule.enabled === false
    )
  );
}
