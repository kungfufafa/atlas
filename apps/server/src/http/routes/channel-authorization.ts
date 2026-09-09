import {
  AtlasApiError,
  addDiscordAllowedUserId,
  PrincipalRequiredError,
} from "@atlas/core";
import {
  assertChannelIntegrationPolicy,
  loadChannelIntegrationPolicy,
  saveChannelIntegrationPolicy,
} from "@atlas/core/channel-integration-policy";
import {
  channelActionReceiptSchema,
  nativeChannelSchema,
} from "@atlas/core/channel-native-actions";
import { z } from "zod";
import { authorizeChannelAction } from "../../services/channel-action-authorization";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requireOrgAdminOrPlatformAdminFromContext,
} from "../org-guards";
import {
  errorResponse,
  getRequestAuth,
  json,
  readJsonWithLimit,
} from "../shared";
import type { HonoApp } from "../types";
import { registerChannelVoiceRoutes } from "./channel-voice";

const sourceId = z.string().trim().min(1).max(200);
const authorizationSchema = z
  .object({
    channel: z.enum(["telegram", "whatsapp", "discord"]).optional(),
    channelUserId: sourceId,
    channelUserAliases: z.array(sourceId).max(8).optional(),
    profileId: sourceId.optional(),
    sessionId: sourceId.optional(),
    intent: z.enum(["files", "invoke", "read"]).optional(),
    channelChatId: sourceId.optional(),
    channelIsGroup: z.boolean().optional(),
    channelAddressed: z.boolean().optional(),
    channelThreadId: sourceId.optional(),
    nativeAction: z
      .enum([
        "react",
        "poll",
        "edit",
        "delete",
        "pin",
        "unpin",
        "topic_create",
        "topic_edit",
        "thread_create",
        "send_media",
      ])
      .optional(),
  })
  .strict();
const allowSchema = z
  .object({
    requesterChannelUserId: sourceId,
    targetChannelUserId: z.string().regex(/^\d{17,20}$/),
  })
  .strict();

export function registerChannelAuthorizationRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  registerNativeActionRoutes(app, options);
  registerChannelVoiceRoutes(app, options);
  app.post("/v1/channel-principals/authorize", async (c) => {
    const auth = getRequestAuth(c);
    if (!auth.workspaceWorker) {
      return errorResponse(
        "Channel authorization requires a scoped worker",
        403
      );
    }
    const parsed = authorizationSchema.safeParse(
      await readJsonWithLimit<unknown>(c.req.raw, 1024 * 1024)
    );
    if (!parsed.success) {
      return errorResponse("Invalid channel authorization request", 400);
    }
    const channel = auth.workspaceWorker.channel;
    if (!channel || (parsed.data.channel && parsed.data.channel !== channel)) {
      return errorResponse("Channel does not match the worker", 403);
    }
    if (
      channel !== "telegram" &&
      channel !== "whatsapp" &&
      channel !== "discord"
    ) {
      return errorResponse("Invalid worker channel", 403);
    }
    if (!options.databaseAdapter) {
      throw new AtlasApiError("Database unavailable", 500);
    }
    try {
      const principal = await authorizeChannelAction(
        options.databaseAdapter,
        options.agent.identityService,
        {
          ...parsed.data,
          channel,
          orgId: requireActiveOrgIdFromContext(c),
        }
      );
      return json(principal);
    } catch (error) {
      if (error instanceof PrincipalRequiredError) {
        return errorResponse("Invalid channel identity", 403);
      }
      throw error;
    }
  });

  app.post("/v1/channels/discord/allowed-users", async (c) => {
    const auth = getRequestAuth(c);
    if (auth.workspaceWorker?.channel !== "discord") {
      return errorResponse(
        "Discord authorization requires its scoped worker",
        403
      );
    }
    const parsed = allowSchema.safeParse(
      await readJsonWithLimit<unknown>(c.req.raw, 1024 * 1024)
    );
    if (!parsed.success) {
      return errorResponse("Invalid Discord allow request", 400);
    }
    if (!options.databaseAdapter) {
      throw new AtlasApiError("Database unavailable", 500);
    }
    const orgId = requireActiveOrgIdFromContext(c);
    const principal = await authorizeChannelAction(
      options.databaseAdapter,
      options.agent.identityService,
      {
        channel: "discord",
        channelUserId: parsed.data.requesterChannelUserId,
        intent: "files",
        orgId,
      }
    );
    if (principal.orgRole !== "admin" && !principal.isPlatformAdmin) {
      return errorResponse("Workspace Admin access required", 403);
    }
    return json(
      await addDiscordAllowedUserId(parsed.data.targetChannelUserId, orgId)
    );
  });
}

const channelActorSchema = z
  .object({
    channelIsGroup: z.boolean().optional(),
    channelAddressed: z.boolean().optional(),
    channel: nativeChannelSchema.optional(),
    channelUserId: sourceId,
    channelUserAliases: z.array(sourceId).max(8).optional(),
    channelChatId: sourceId,
    channelThreadId: sourceId.optional(),
    sessionId: sourceId,
  })
  .strict();

function registerNativeActionRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  app.get("/v1/settings/channels/:channel/policy", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const channel = nativeChannelSchema.parse(c.req.param("channel"));
    return json(
      await loadChannelIntegrationPolicy(
        requireActiveOrgIdFromContext(c),
        channel
      )
    );
  });
  app.put("/v1/settings/channels/:channel/policy", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const channel = nativeChannelSchema.parse(c.req.param("channel"));
    return json(
      await saveChannelIntegrationPolicy(
        requireActiveOrgIdFromContext(c),
        channel,
        await readJsonWithLimit<unknown>(c.req.raw, 1024 * 1024)
      )
    );
  });
  const claims = channelActorSchema.extend({ requestId: sourceId });
  const receipts = claims.extend({ receipt: channelActionReceiptSchema });
  for (const operation of ["context", "claim", "complete"] as const) {
    app.post(`/v1/channel-actions/${operation}`, async (c) => {
      const auth = getRequestAuth(c);
      const channel = nativeChannelSchema.safeParse(
        auth.workspaceWorker?.channel
      );
      if (!channel.success) {
        return errorResponse("A scoped messenger worker is required", 403);
      }
      const schema =
        operation === "context"
          ? channelActorSchema
          : operation === "claim"
            ? claims
            : receipts;
      const parsed = schema.safeParse(
        await readJsonWithLimit<unknown>(c.req.raw, 1024 * 1024)
      );
      if (!parsed.success) {
        return errorResponse("Invalid native channel action request", 400);
      }
      if (parsed.data.channel && parsed.data.channel !== channel.data) {
        return errorResponse("Worker channel mismatch", 403);
      }
      const orgId = requireActiveOrgIdFromContext(c);
      const service = options.agent.channelNativeActions;
      if (operation === "context") {
        return json(
          await service.bind(
            orgId,
            channel.data,
            channelActorSchema.parse(parsed.data)
          )
        );
      }
      if (operation === "claim") {
        return json(
          await service.claim(orgId, channel.data, claims.parse(parsed.data))
        );
      }
      return json(
        await service.complete(orgId, channel.data, receipts.parse(parsed.data))
      );
    });
  }
  app.post("/v1/channel-principals/approvals/decide", async (c) => {
    const auth = getRequestAuth(c);
    const channel = nativeChannelSchema.safeParse(
      auth.workspaceWorker?.channel
    );
    if (!channel.success) {
      return errorResponse("A scoped messenger worker is required", 403);
    }
    const schema = authorizationSchema
      .omit({ intent: true, nativeAction: true })
      .extend({
        approvalId: sourceId,
        channelChatId: sourceId,
        channelIsGroup: z.boolean(),
        sessionId: sourceId,
        decision: z.enum(["approved", "denied"]),
      });
    const parsed = schema.safeParse(
      await readJsonWithLimit<unknown>(c.req.raw, 1024 * 1024)
    );
    if (!parsed.success) {
      return errorResponse("Invalid channel approval decision", 400);
    }
    if (parsed.data.channel && parsed.data.channel !== channel.data) {
      return errorResponse("Worker channel mismatch", 403);
    }
    if (!options.databaseAdapter) {
      throw new AtlasApiError("Database unavailable", 500);
    }
    const principal = await authorizeChannelAction(
      options.databaseAdapter,
      options.agent.identityService,
      {
        ...parsed.data,
        orgId: requireActiveOrgIdFromContext(c),
        channel: channel.data,
        intent: "files",
      }
    );
    assertChannelIntegrationPolicy(
      await loadChannelIntegrationPolicy(principal.orgId, channel.data),
      channel.data,
      parsed.data,
      principal,
      { approval: true }
    );
    options.agent.channelNativeActions.assertBoundActor(
      principal.orgId,
      channel.data,
      parsed.data,
      principal.userId
    );
    return json(
      await options.agent.decideChatToolApproval({
        approvalId: parsed.data.approvalId,
        decision: parsed.data.decision,
        sessionId: parsed.data.sessionId,
        principal,
      })
    );
  });
}
