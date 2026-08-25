import type { ChannelType, OrgRole } from "../contract";
import { LOCAL_CLIENT_USER_ID } from "../local-auth";

/**
 * Channel-native identity. Never used as ToolContext.userId.
 * Mapped to CanonicalPrincipal via channel_org_mappings before any
 * persist, tool, learning, or outbound action.
 */
export interface ExternalPrincipal {
  channel: ChannelType;
  channelUserId: string;
  orgId: string;
}

/** Atlas user that owns every execution, memory, approval, and audit action. */
export interface CanonicalPrincipal {
  isPlatformAdmin: boolean;
  orgId: string;
  orgRole: OrgRole;
  userId: string;
}

export class PrincipalRequiredError extends Error {
  readonly code = "PRINCIPAL_REQUIRED";

  constructor(message = "Canonical principal is required.") {
    super(message);
    this.name = "PrincipalRequiredError";
  }
}

export function isServiceAccountUserId(
  userId: string | null | undefined
): boolean {
  return (userId ?? "").trim() === LOCAL_CLIENT_USER_ID;
}

export function normalizeChannelUserId(channelUserId: string): string {
  const normalized = channelUserId.trim();
  if (!normalized) {
    throw new PrincipalRequiredError("channelUserId is required.");
  }
  return normalized;
}

export function assertExternalPrincipal(
  value: Partial<ExternalPrincipal> | null | undefined
): ExternalPrincipal {
  const channel = value?.channel;
  const channelUserId = value?.channelUserId?.trim();
  const orgId = value?.orgId?.trim();

  if (
    channel !== "telegram" &&
    channel !== "whatsapp" &&
    channel !== "discord"
  ) {
    throw new PrincipalRequiredError(
      "External principal channel must be telegram, whatsapp, or discord."
    );
  }

  if (!channelUserId) {
    throw new PrincipalRequiredError(
      "External principal channelUserId is required."
    );
  }

  if (!orgId) {
    throw new PrincipalRequiredError("External principal orgId is required.");
  }

  return { channel, channelUserId, orgId };
}

export function assertCanonicalPrincipal(
  value: Partial<CanonicalPrincipal> | null | undefined
): CanonicalPrincipal {
  const userId = value?.userId?.trim();
  const orgId = value?.orgId?.trim();
  const orgRole = value?.orgRole;

  if (!userId) {
    throw new PrincipalRequiredError("Canonical principal userId is required.");
  }

  if (isServiceAccountUserId(userId)) {
    throw new PrincipalRequiredError(
      "Channel service-account identity cannot act as the canonical principal."
    );
  }

  if (!orgId) {
    throw new PrincipalRequiredError("Canonical principal orgId is required.");
  }

  if (orgRole !== "admin" && orgRole !== "member" && orgRole !== "viewer") {
    throw new PrincipalRequiredError(
      "Canonical principal orgRole is required."
    );
  }

  return {
    isPlatformAdmin: value?.isPlatformAdmin === true,
    orgId,
    orgRole,
    userId,
  };
}

export function resolveCanonicalPrincipal(input: {
  mapping: { orgId: string; userId: string } | null | undefined;
  member: { orgRole: OrgRole; isPlatformAdmin?: boolean } | null | undefined;
  principal: ExternalPrincipal;
}): CanonicalPrincipal {
  const principal = assertExternalPrincipal(input.principal);

  if (!input.mapping) {
    throw new PrincipalRequiredError(
      `No canonical user mapping for ${principal.channel}:${principal.channelUserId}. Re-pair the channel.`
    );
  }

  if (input.mapping.orgId !== principal.orgId) {
    throw new PrincipalRequiredError(
      "Channel mapping org does not match the active workspace."
    );
  }

  if (!input.member) {
    throw new PrincipalRequiredError(
      "Mapped user is not a member of the active workspace."
    );
  }

  return assertCanonicalPrincipal({
    isPlatformAdmin: input.member.isPlatformAdmin === true,
    orgId: input.mapping.orgId,
    orgRole: input.member.orgRole,
    userId: input.mapping.userId,
  });
}

export function principalFromToolContext(context: {
  isPlatformAdmin?: boolean;
  orgId?: string;
  orgRole?: OrgRole;
  userId?: string;
}): CanonicalPrincipal {
  return assertCanonicalPrincipal({
    isPlatformAdmin: context.isPlatformAdmin,
    orgId: context.orgId,
    orgRole: context.orgRole,
    userId: context.userId,
  });
}

/** Bind work to a verified canonical principal. Fail closed if it is missing. */
export function runAsPrincipal<T>(
  principal: CanonicalPrincipal | null | undefined,
  fn: (principal: CanonicalPrincipal) => T
): T {
  return fn(assertCanonicalPrincipal(principal));
}

export interface ChannelEnvelope {
  canonicalPrincipal: CanonicalPrincipal;
  conversationId: string;
  orgId: string;
  profileId: string;
  replyTarget: import("../channels/outbound-envelope").ChannelReplyTarget;
}

export function assertChannelEnvelope(
  value: Partial<ChannelEnvelope> | null | undefined
): ChannelEnvelope {
  const principal = assertCanonicalPrincipal(value?.canonicalPrincipal);
  const orgId = value?.orgId?.trim();
  const profileId = value?.profileId?.trim();
  const conversationId = value?.conversationId?.trim();
  if (!orgId) {
    throw new PrincipalRequiredError("Channel envelope orgId is required.");
  }
  if (orgId !== principal.orgId) {
    throw new PrincipalRequiredError(
      "Channel envelope orgId must match the canonical principal."
    );
  }
  if (!profileId) {
    throw new PrincipalRequiredError("Channel envelope profileId is required.");
  }
  if (!conversationId) {
    throw new PrincipalRequiredError(
      "Channel envelope conversationId is required."
    );
  }
  if (!value?.replyTarget) {
    throw new PrincipalRequiredError(
      "Channel envelope replyTarget is required."
    );
  }
  return {
    canonicalPrincipal: principal,
    conversationId,
    orgId,
    profileId,
    replyTarget: value.replyTarget,
  };
}
