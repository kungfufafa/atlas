import {
  isChannelGuestUserId,
  isWhatsAppUserAuthorized,
  loadWhatsAppConfigFile,
  normalizeWhatsAppUserJid,
  PrincipalRequiredError,
  toWhatsAppPhoneJid,
  whatsAppUserDigits,
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";
import { normalizeExternalActor } from "./channel-guest-principal-service";

export interface ChannelGuestKnowledgeBaseInput {
  actor?: { channelUserAliases?: string[]; channelUserId: string };
  channel?: string;
  orgId: string;
  profileId: string;
  userId?: string | null;
}

/**
 * Catalog eligibility only: execution also requires the currently bound sender
 * and channel policy. A whitelist grant never changes the guest's identity.
 */
export async function canGuestSearchKnowledgeBase(
  db: DatabaseAdapter,
  input: ChannelGuestKnowledgeBaseInput
): Promise<boolean> {
  const { channel, orgId, profileId, userId } = input;
  if (channel !== "whatsapp" || !userId || !isChannelGuestUserId(userId)) {
    return false;
  }

  const [organization, user, member, profile, assigned, mappings, config] =
    await Promise.all([
      db.getOrganizationById(orgId),
      db.getUserById(userId),
      db.getOrgMember(orgId, userId),
      db.getProfileForOrg(profileId, orgId),
      db.listToolsForProfile(profileId),
      db.listChannelOrgMappingsForOrg(orgId),
      loadWhatsAppConfigFile(orgId),
    ]);
  if (
    !organization ||
    organization.archivedAt ||
    !user ||
    user.isPlatformAdmin ||
    !member ||
    member.role === "viewer" ||
    !profile ||
    profile.isSuper ||
    !config ||
    !assigned.some(
      (tool) =>
        tool.name === "knowledge_base_search" &&
        tool.handlerType === "builtin" &&
        (!tool.orgId || tool.orgId === orgId)
    )
  ) {
    return false;
  }

  const actors = mappings.filter(
    (mapping) => mapping.channel === channel && mapping.userId === userId
  );
  const primary = input.actor?.channelUserId ?? actors[0]?.channelUserId;
  if (!primary) {
    return false;
  }

  try {
    const normalized = await normalizeExternalActor({
      channel,
      channelUserAliases:
        input.actor?.channelUserAliases ??
        (input.actor
          ? []
          : actors.slice(1).map((actor) => actor.channelUserId)),
      channelUserId: primary,
      orgId,
    });
    const ids = new Set(normalized.channelUserIds);
    const matching = mappings.filter(
      (mapping) =>
        mapping.channel === channel &&
        ids.has(normalizeWhatsAppUserJid(mapping.channelUserId.trim()))
    );
    if (
      !matching.length ||
      matching.some((mapping) => mapping.userId !== userId)
    ) {
      return false;
    }
    const phoneJid = normalized.channelUserIds
      .map(toWhatsAppPhoneJid)
      .find((phone) => phone !== null);
    return Boolean(
      phoneJid &&
        config.allowedNumbers.includes(whatsAppUserDigits(phoneJid)) &&
        isWhatsAppUserAuthorized(
          {
            jid: normalized.primaryChannelUserId,
            mappedPhoneJid: phoneJid,
          },
          config
        )
    );
  } catch (error) {
    if (error instanceof PrincipalRequiredError) {
      return false;
    }
    throw error;
  }
}
