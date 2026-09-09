import {
  AtlasApiError,
  type CanonicalPrincipal,
  type ChannelPrincipalAuthorizationInput,
  LOCAL_CLIENT_USER_ID,
  PrincipalRequiredError,
} from "@atlas/core";
import {
  assertChannelIntegrationPolicy,
  loadChannelIntegrationPolicy,
} from "@atlas/core/channel-integration-policy";
import type { DatabaseAdapter } from "@atlas/db";
import {
  authorizeExternalActorFromWorkspaceConfig,
  normalizeExternalActor,
} from "./channel-guest-principal-service";
import type { IdentityService } from "./identity-service";

/** A scoped worker is transport authority, never the sender's current RBAC role. */
export async function authorizeChannelAction(
  db: DatabaseAdapter,
  identities: IdentityService,
  input: ChannelPrincipalAuthorizationInput & {
    orgId: string;
    channel: "telegram" | "whatsapp" | "discord";
  }
): Promise<CanonicalPrincipal> {
  const organization = await db.getOrganizationById(input.orgId);
  if (!organization || organization.archivedAt) {
    throw new AtlasApiError("Workspace not found", 404);
  }
  const normalized = await normalizeExternalActor(input);
  const normalizedInput = {
    ...input,
    channelUserAliases: normalized.channelUserIds.filter(
      (id) => id !== normalized.primaryChannelUserId
    ),
    channelUserId: normalized.primaryChannelUserId,
  };
  if (!(await authorizeExternalActorFromWorkspaceConfig(normalizedInput))) {
    throw new AtlasApiError("Channel sender is not authorized", 403);
  }
  let requestedProfileId = input.profileId;
  if (requestedProfileId) {
    const profile =
      requestedProfileId === "default"
        ? await db.getDefaultProfileForOrg(input.orgId)
        : await db.getProfileForOrg(requestedProfileId, input.orgId);
    if (!profile || profile.isSuper) {
      throw new AtlasApiError("Profile not found", 404);
    }
    requestedProfileId = profile.id;
  }
  const intent = input.intent ?? "files";
  const userIds = new Set<string>();
  for (const id of normalized.channelUserIds) {
    const mapping = await db.getChannelOrgMapping(
      input.orgId,
      input.channel,
      id
    );
    if (mapping) {
      userIds.add(mapping.userId);
    }
  }
  // Admission may provision a least-privilege guest for a new conversation.
  // Reads, file writes and existing-session requests never create a principal.
  let userId: string;
  if (userIds.size === 0 && intent === "invoke" && !input.sessionId) {
    const admitted = await identities.resolveForChannelSession({
      authUserId: LOCAL_CLIENT_USER_ID,
      channel: input.channel,
      channelUserAliases: normalizedInput.channelUserAliases,
      channelUserId: normalizedInput.channelUserId,
      isPlatformAdmin: false,
      orgId: input.orgId,
      orgRole: "member",
    });
    userId = admitted.userId;
  } else if (userIds.size === 1) {
    userId = [...userIds][0]!;
  } else {
    throw new AtlasApiError("Channel identity is missing or conflicting", 403);
  }
  if (!(await db.getUserById(userId))) {
    throw new AtlasApiError("Channel identity is no longer available", 403);
  }
  let principal: CanonicalPrincipal;
  try {
    principal = await identities.resolveForUser(input.orgId, userId);
  } catch (error) {
    if (error instanceof PrincipalRequiredError) {
      throw new AtlasApiError("Channel membership is no longer available", 403);
    }
    throw error;
  }
  if (
    intent !== "read" &&
    principal.orgRole === "viewer" &&
    !principal.isPlatformAdmin
  ) {
    throw new AtlasApiError("Viewer access is read-only", 403);
  }
  // File persistence follows current channel authorization, independently of pairing.
  if (intent === "read" && !input.sessionId) {
    throw new AtlasApiError(
      "Reading channel artifacts requires a session",
      400
    );
  }
  if (input.nativeAction && !input.sessionId) {
    throw new AtlasApiError("Native actions require a session", 403);
  }
  if (input.sessionId) {
    const session = await db.getSession(input.sessionId);
    if (
      !session ||
      session.orgId !== input.orgId ||
      session.channel !== input.channel ||
      session.userId !== principal.userId ||
      (requestedProfileId && session.profileId !== requestedProfileId)
    ) {
      throw new AtlasApiError("Session not found", 404);
    }
    const profile = await db.getProfileForOrg(session.profileId, input.orgId);
    if (!profile || profile.isSuper) {
      throw new AtlasApiError("Profile not found", 404);
    }
    if (input.nativeAction) {
      const assigned = await db.listToolsForProfile(profile.id);
      if (
        !assigned.some(
          (tool) =>
            tool.name === "channel_action" &&
            tool.handlerType === "builtin" &&
            (!tool.orgId || tool.orgId === input.orgId)
        )
      ) {
        throw new AtlasApiError(
          "Native channel tool is no longer assigned",
          403
        );
      }
    }
  }
  assertChannelIntegrationPolicy(
    await loadChannelIntegrationPolicy(input.orgId, input.channel),
    input.channel,
    normalizedInput,
    principal,
    {
      action: input.nativeAction,
      tool: input.nativeAction ? "channel_action" : undefined,
    }
  );
  return principal;
}
