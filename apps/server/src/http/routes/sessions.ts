import {
  AtlasApiError,
  type BranchSessionRequest,
  type BranchSessionResponse,
  type CompactionResponse,
  type CompactSessionRequest,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ListSessionsResponse,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  PrincipalRequiredError,
  type SendMessageRequest,
  type SendMessageResponse,
  type SessionMessagesResponse,
  type SessionStatusResponse,
  sanitizeArtifactShareFilename,
  type UpdateSessionRequest,
  validateCombinedAttachmentCount,
  validateDocumentAttachments,
} from "@atlas/core";
import { createRoute, z } from "@hono/zod-openapi";
import { authorizeChannelAction } from "../../services/channel-action-authorization";
import { assertChannelPairingAllowed } from "../../services/channel-pairing-authorization";
import { resolveRequestClientOrigin } from "../../services/composio-callback-url";
import { validateDecodedImageAttachments } from "../../services/image-decoder-validation";
import { sessionTurnRegistry } from "../../services/session-turn-registry";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requireNotViewerFromContext,
} from "../org-guards";
import { sessionActorFromAuth } from "../session-actor";
import {
  errorResponse,
  getRequestAuth,
  json,
  parseChannel,
  readJson,
  readJsonWithLimit,
  readOptionalJson,
  streamMessage,
  streamTurnSubscribe,
} from "../shared";
import type { HonoApp } from "../types";

const ATTACHMENT_JSON_OVERHEAD_BYTES = 1024 * 1024;
const MAX_SESSION_MESSAGE_BODY_BYTES =
  Math.ceil(
    (MAX_ATTACHMENTS_PER_MESSAGE *
      Math.max(MAX_IMAGE_BYTES, MAX_DOCUMENT_BYTES) *
      4) /
      3
  ) + ATTACHMENT_JSON_OVERHEAD_BYTES;
const SAFE_ATTACHMENT_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

function safeAttachmentMediaType(mediaType: string): string {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SAFE_ATTACHMENT_MEDIA_TYPES.has(normalized)
    ? normalized
    : "application/octet-stream";
}

const EXTERNAL_SESSION_CHANNELS = new Set(["telegram", "whatsapp", "discord"]);

export function registerSessionRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const { agent } = options;
  const errorSchema = z
    .object({ error: z.string() })
    .openapi("ApiErrorResponse");
  const agentChannelSchema = z
    .enum([
      "web",
      "cli",
      "telegram",
      "whatsapp",
      "discord",
      "automation",
      "task",
      "subagent",
    ])
    .openapi("AgentChannel");
  const createSessionRequestSchema = z
    .object({
      channel: agentChannelSchema,
      externalPrincipal: z
        .object({
          channelUserAliases: z
            .array(z.string().trim().min(1))
            .max(8)
            .optional(),
          channelUserId: z.string().min(1),
          channelChatId: z.string().trim().min(1).max(200).optional(),
          channelIsGroup: z.boolean().optional(),
          channelAddressed: z.boolean().optional(),
          channelThreadId: z.string().trim().min(1).max(200).optional(),
        })
        .optional(),
      model: z.string().trim().min(1).optional(),
      profileId: z.string().optional(),
    })
    .openapi("CreateSessionRequest");
  const createSessionResponseSchema = z
    .object({ sessionId: z.string() })
    .openapi("CreateSessionResponse");
  const sessionSummarySchema = z
    .object({
      channel: agentChannelSchema,
      createdAt: z.string().optional(),
      id: z.string(),
      messageCount: z.number().optional(),
      preview: z.string().nullable().optional(),
      profileId: z.string(),
      title: z.string().nullable().optional(),
      updatedAt: z.string().optional(),
    })
    .passthrough()
    .openapi("SessionSummary");
  const listSessionsResponseSchema = z
    .object({
      sessions: z.array(sessionSummarySchema),
    })
    .openapi("ListSessionsResponse");
  const compactSessionRequestSchema = z
    .object({ force: z.boolean().optional() })
    .openapi("CompactSessionRequest");
  const compactionResponseSchema = z
    .object({
      action: z.enum(["none", "pruned", "summarized"]),
      messagesAfter: z.number(),
      messagesBefore: z.number(),
      prunedTokens: z.number().optional(),
    })
    .openapi("CompactionResponse");
  const sessionMessageMetaSchema = z
    .object({
      createdAt: z.string(),
      id: z.string(),
      seq: z.number(),
    })
    .openapi("SessionMessageMeta");
  const agentTodoSchema = z
    .object({
      content: z.string(),
      id: z.string(),
      status: z.string(),
    })
    .openapi("AgentTodo");
  const agentQuestionChoiceSchema = z
    .object({
      id: z.string(),
      label: z.string(),
    })
    .openapi("AgentQuestionChoice");
  const agentQuestionItemSchema = z
    .object({
      allowCustomAnswer: z.boolean(),
      selectionMode: z.enum(["single", "multiple"]).optional(),
      choices: z.array(agentQuestionChoiceSchema),
      id: z.string(),
      placeholder: z.string().optional(),
      prompt: z.string(),
    })
    .openapi("AgentQuestionItem");
  const agentQuestionnaireSchema = z
    .object({
      id: z.string(),
      questions: z.array(agentQuestionItemSchema),
      title: z.string(),
    })
    .openapi("AgentQuestionnaire");
  const sessionMessagesResponseSchema = z
    .object({
      canUpdateModel: z.boolean(),
      channel: agentChannelSchema,
      messageMeta: z.array(sessionMessageMetaSchema),
      messages: z.array(z.object({}).passthrough()),
      model: z.string().nullable(),
      questionnaire: agentQuestionnaireSchema.nullable(),
      todos: z.array(agentTodoSchema),
    })
    .openapi("SessionMessagesResponse");
  const branchSessionRequestSchema = z
    .object({ messageIndex: z.number() })
    .openapi("BranchSessionRequest");
  const branchSessionResponseSchema = z
    .object({ sessionId: z.string() })
    .openapi("BranchSessionResponse");
  const updateSessionRequestSchema = z
    .object({ model: z.string().trim().min(1).nullable() })
    .openapi("UpdateSessionRequest");
  const imageAttachmentSchema = z
    .object({
      data: z.string().min(1),
      mediaType: z.string().trim().min(1),
    })
    .strict();
  const documentAttachmentSchema = z
    .object({
      data: z.string().min(1),
      filename: z.string().trim().min(1),
      mediaType: z.string(),
    })
    .strict();
  const sendMessageRequestSchema = z
    .object({
      expectedQuestionnaire: agentQuestionnaireSchema.optional(),
      clientOrigin: z.string().optional(),
      documents: z
        .array(documentAttachmentSchema)
        .max(MAX_ATTACHMENTS_PER_MESSAGE)
        .optional(),
      images: z
        .array(imageAttachmentSchema)
        .max(MAX_ATTACHMENTS_PER_MESSAGE)
        .optional(),
      message: z.string(),
      policy: z
        .enum(["auto", "fast", "standard", "research", "agent"])
        .optional(),
      relatedQuestions: z.boolean().optional(),
      stream: z.boolean().optional(),
    })
    .strict()
    .openapi("SendMessageRequest");
  const sendMessageResponseSchema = z
    .object({ reply: z.string() })
    .openapi("SendMessageResponse");
  const sessionIdParamSchema = z.object({
    sessionId: z.string().openapi({ param: { in: "path", name: "sessionId" } }),
  });
  const sessionAttachmentParamSchema = z.object({
    attachmentId: z
      .string()
      .openapi({ param: { in: "path", name: "attachmentId" } }),
    sessionId: z.string().openapi({ param: { in: "path", name: "sessionId" } }),
  });
  const sessionListQuerySchema = z.object({
    channel: agentChannelSchema,
    profileId: z.string().optional(),
  });
  const streamQuerySchema = z.object({
    stream: z.enum(["true", "false"]).optional(),
  });
  const attachmentQuerySchema = z.object({
    inline: z.enum(["1"]).optional(),
  });

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "createSession",
      path: "/v1/sessions",
      request: {
        body: {
          content: {
            "application/json": { schema: createSessionRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        201: {
          content: {
            "application/json": { schema: createSessionResponseSchema },
          },
          description: "Session created",
        },
      },
      summary: "Create a chat session",
      tags: ["Chat"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "listSessions",
      path: "/v1/sessions",
      request: { query: sessionListQuerySchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: listSessionsResponseSchema },
          },
          description: "Sessions",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "List chat sessions",
      tags: ["Chat"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "patch",
      operationId: "updateSession",
      path: "/v1/sessions/{sessionId}",
      request: {
        body: {
          content: {
            "application/json": { schema: updateSessionRequestSchema },
          },
          required: true,
        },
        params: sessionIdParamSchema,
      },
      responses: {
        204: { description: "Session updated" },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Invalid model",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Forbidden",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Session not found",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Response in progress",
        },
      },
      summary: "Update a chat session",
      tags: ["Chat"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "delete",
      operationId: "deleteSession",
      path: "/v1/sessions/{sessionId}",
      request: { params: sessionIdParamSchema },
      responses: {
        204: { description: "Deleted" },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Delete or purge a session",
      tags: ["Chat"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "compactSession",
      path: "/v1/sessions/{sessionId}/compact",
      request: {
        body: {
          content: {
            "application/json": { schema: compactSessionRequestSchema },
          },
          required: false,
        },
        params: sessionIdParamSchema,
      },
      responses: {
        200: {
          content: { "application/json": { schema: compactionResponseSchema } },
          description: "Compaction result",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Compact a session",
      tags: ["Chat"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getSessionMessages",
      path: "/v1/sessions/{sessionId}/messages",
      request: { params: sessionIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: sessionMessagesResponseSchema },
          },
          description: "Messages",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Get session messages",
      tags: ["Chat"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getSessionAttachment",
      path: "/v1/sessions/{sessionId}/attachments/{attachmentId}",
      request: {
        params: sessionAttachmentParamSchema,
        query: attachmentQuerySchema,
      },
      responses: {
        200: { description: "Attachment bytes" },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Download a session attachment",
      tags: ["Chat"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "branchSession",
      path: "/v1/sessions/{sessionId}/branch",
      request: {
        body: {
          content: {
            "application/json": { schema: branchSessionRequestSchema },
          },
          required: true,
        },
        params: sessionIdParamSchema,
      },
      responses: {
        201: {
          content: {
            "application/json": { schema: branchSessionResponseSchema },
          },
          description: "Branched session",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Branch a session from a message index",
      tags: ["Chat"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "sendMessage",
      path: "/v1/sessions/{sessionId}/messages",
      request: {
        body: {
          content: { "application/json": { schema: sendMessageRequestSchema } },
          required: true,
        },
        params: sessionIdParamSchema,
        query: streamQuerySchema,
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: sendMessageResponseSchema },
          },
          description: "Assistant reply",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Send a message to a session",
      tags: ["Chat"],
    })
  );

  app.post("/v1/sessions", async (c) => {
    requireNotViewerFromContext(c);
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const parsedBody = createSessionRequestSchema.safeParse(
      await readJson<unknown>(c.req.raw)
    );
    if (!parsedBody.success) {
      return errorResponse("Invalid session request.", 400);
    }
    const body: CreateSessionRequest = parsedBody.data;
    const channel = parseChannel(body.channel);
    if (EXTERNAL_SESSION_CHANNELS.has(channel) && !auth.workspaceWorker) {
      return errorResponse(
        "External channel sessions require a scoped workspace worker credential",
        403
      );
    }
    if (auth.workspaceWorker && auth.workspaceWorker.channel !== channel) {
      return errorResponse("Workspace worker channel mismatch", 403);
    }
    try {
      if (auth.workspaceWorker) {
        const channelUserId = body.externalPrincipal?.channelUserId?.trim();
        if (!channelUserId) {
          throw new PrincipalRequiredError(
            "Channel sessions require an external principal."
          );
        }
        if (
          channel !== "telegram" &&
          channel !== "whatsapp" &&
          channel !== "discord"
        ) {
          throw new AtlasApiError("Invalid workspace worker channel", 403);
        }
        if (!options.databaseAdapter) {
          throw new AtlasApiError("Database unavailable", 500);
        }
        await authorizeChannelAction(
          options.databaseAdapter,
          agent.identityService,
          {
            channel,
            channelUserAliases: body.externalPrincipal?.channelUserAliases,
            channelUserId,
            channelChatId: body.externalPrincipal?.channelChatId,
            channelIsGroup: body.externalPrincipal?.channelIsGroup,
            channelAddressed: body.externalPrincipal?.channelAddressed,
            channelThreadId: body.externalPrincipal?.channelThreadId,
            intent: "invoke",
            orgId,
            profileId: body.profileId,
          }
        );
      }
      const sessionId = await agent.createSession(
        orgId,
        channel,
        body.profileId,
        auth.user.id,
        {
          excludeSuperAgent:
            (auth.mode === "local-token" || auth.mode === "workspace-worker") &&
            channel !== "cli",
          externalPrincipal: body.externalPrincipal,
          isPlatformAdmin: auth.isPlatformAdmin,
          model: body.model,
          orgRole: auth.orgRole,
        }
      );
      return json<CreateSessionResponse>({ sessionId }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        error instanceof AtlasApiError
          ? error.status
          : error instanceof Error && error.name === "PrincipalRequiredError"
            ? 403
            : 400;
      return errorResponse(message, status);
    }
  });

  app.post("/v1/channel-principals", async (c) => {
    requireNotViewerFromContext(c);
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<{
      channel: "telegram" | "whatsapp" | "discord";
      channelUserId: string;
      expectedUserId?: string;
      pairingAssertion?: string;
      userId?: string;
    }>(c.req.raw);
    if (!auth.workspaceWorker) {
      return errorResponse(
        "Channel identity binding requires a scoped workspace worker credential",
        403
      );
    }
    if (auth.workspaceWorker && auth.workspaceWorker.channel !== body.channel) {
      return errorResponse("Workspace worker channel mismatch", 403);
    }
    try {
      await assertChannelPairingAllowed({
        channel: body.channel,
        channelUserId: body.channelUserId,
        orgId,
      });
      const principal = await agent.identityService.bindExternalPrincipal({
        actor: {
          mode: auth.mode,
          userId: auth.user.id,
        },
        channel: body.channel,
        channelUserId: body.channelUserId,
        expectedUserId: body.expectedUserId,
        orgId,
        pairingAssertion: body.pairingAssertion,
      });
      return json({ orgId: principal.orgId, userId: principal.userId }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof PrincipalRequiredError ? 403 : 400;
      return errorResponse(message, status);
    }
  });

  app.post("/v1/sessions/:sessionId/approvals/:approvalId", async (c) => {
    requireNotViewerFromContext(c);
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const approvalId = decodeURIComponent(c.req.param("approvalId"));
    const body = await readJson<{ decision: "approved" | "denied" }>(c.req.raw);
    if (body.decision !== "approved" && body.decision !== "denied") {
      return errorResponse("Invalid approval decision.", 400);
    }
    try {
      if (
        !(await agent.canAccessSession(
          orgId,
          sessionId,
          sessionActorFromAuth(auth),
          "invoke"
        ))
      ) {
        return errorResponse("Session not found", 404);
      }
      const result = await agent.decideChatToolApproval({
        approvalId,
        decision: body.decision,
        principal: {
          isPlatformAdmin: auth.isPlatformAdmin === true,
          orgId,
          orgRole: auth.orgRole ?? "member",
          userId: auth.user.id,
        },
        sessionId,
      });
      return json(result);
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.get("/v1/sessions", async (c) => {
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = c.req.query("profileId")?.trim();
    const channel = parseChannel(c.req.query("channel"));

    if (!profileId) {
      return errorResponse("profileId is required.", 400);
    }

    return json<ListSessionsResponse>(
      await agent.listSessions(
        orgId,
        profileId,
        channel,
        sessionActorFromAuth(auth)
      )
    );
  });

  app.patch("/v1/sessions/:sessionId", async (c) => {
    requireNotViewerFromContext(c);
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const parsedBody = updateSessionRequestSchema.safeParse(
      await readJson<unknown>(c.req.raw)
    );
    if (!parsedBody.success) {
      return errorResponse("Invalid session model.", 400);
    }
    const body: UpdateSessionRequest = parsedBody.data;

    try {
      const updated = await agent.updateSessionModel(
        orgId,
        sessionId,
        body.model,
        sessionActorFromAuth(auth)
      );
      if (!updated) {
        return errorResponse("Session not found", 404);
      }
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      throw error;
    }
  });

  app.delete("/v1/sessions/:sessionId", async (c) => {
    requireNotViewerFromContext(c);
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const purge = c.req.query("purge") === "true";
    const actor = sessionActorFromAuth(auth);
    const cleared = purge
      ? await agent.purgeSession(orgId, sessionId, actor)
      : await agent.clearSession(orgId, sessionId, actor);

    if (!cleared) {
      return errorResponse("Session not found", 404);
    }

    return new Response(null, { status: 204 });
  });

  app.post("/v1/sessions/:sessionId/compact", async (c) => {
    requireNotViewerFromContext(c);
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const body = await readOptionalJson<CompactSessionRequest>(c.req.raw, {});
    const result = await agent.compactSession(
      orgId,
      sessionId,
      { force: body.force ?? false },
      sessionActorFromAuth(auth)
    );

    if (!result) {
      return errorResponse("Session not found", 404);
    }

    return json<CompactionResponse>(result);
  });

  app.get("/v1/sessions/:sessionId/messages", async (c) => {
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const result = await agent.getSessionMessages(
      orgId,
      sessionId,
      sessionActorFromAuth(auth)
    );

    if (!result) {
      return errorResponse("Session not found", 404);
    }

    const todos = (await agent.getSessionTodos(orgId, sessionId)) ?? [];
    const questionnaire =
      (await agent.getSessionQuestionnaire(orgId, sessionId)) ?? null;
    return json<SessionMessagesResponse>({
      canUpdateModel: result.canUpdateModel,
      channel: result.channel,
      contextUsage: result.contextUsage,
      messageMeta: result.messageMeta,
      messages: result.messages,
      model: result.model,
      questionnaire,
      todos,
    });
  });

  app.get("/v1/sessions/:sessionId/attachments/:attachmentId", async (c) => {
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const attachmentId = decodeURIComponent(c.req.param("attachmentId"));
    const attachment = await agent.getSessionAttachment(
      orgId,
      sessionId,
      attachmentId,
      sessionActorFromAuth(auth)
    );

    if (!attachment) {
      return errorResponse("Attachment not found", 404);
    }

    const fallbackFilename = `${attachment.kind}-${attachmentId}`;
    const filename = sanitizeArtifactShareFilename(
      attachment.filename ?? fallbackFilename
    );
    const contentType = safeAttachmentMediaType(attachment.mediaType);
    const inline =
      c.req.query("inline") === "1" &&
      attachment.kind === "image" &&
      contentType.startsWith("image/");

    return new Response(attachment.bytes as unknown as BodyInit, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
        "Content-Length": String(attachment.bytes.byteLength),
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Content-Type": contentType,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.get("/v1/sessions/:sessionId/status", async (c) => {
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const result = await agent.getSessionMessages(
      orgId,
      sessionId,
      sessionActorFromAuth(auth)
    );

    if (!result) {
      return errorResponse("Session not found", 404);
    }

    const status = sessionTurnRegistry.getStatus(sessionId);
    return json<SessionStatusResponse>({
      active: status.active,
      ...(status.startedAt ? { startedAt: status.startedAt } : {}),
    });
  });

  app.get("/v1/sessions/:sessionId/stream", async (c) => {
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const actor = sessionActorFromAuth(auth);
    if (!(await agent.canAccessSession(orgId, sessionId, actor, "invoke"))) {
      return errorResponse("Session not found", 404);
    }
    const result = await agent.getSessionMessages(orgId, sessionId, actor);

    if (!result) {
      return errorResponse("Session not found", 404);
    }

    const response = streamTurnSubscribe(sessionId);

    if (!response) {
      return new Response(null, { status: 204 });
    }

    return response;
  });

  app.post("/v1/sessions/:sessionId/branch", async (c) => {
    requireNotViewerFromContext(c);
    try {
      const auth = getRequestAuth(c);
      const orgId = requireActiveOrgIdFromContext(c);
      const sessionId = decodeURIComponent(c.req.param("sessionId"));
      const body = await readJson<BranchSessionRequest>(c.req.raw);
      const result = await agent.branchSession(
        orgId,
        sessionId,
        body.messageIndex,
        sessionActorFromAuth(auth)
      );

      if (!result) {
        return errorResponse("Session not found", 404);
      }

      return json<BranchSessionResponse>(result, 201);
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/sessions/:sessionId/messages", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const auth = getRequestAuth(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    let body: SendMessageRequest;
    try {
      const rawBody = await readJsonWithLimit<unknown>(
        c.req.raw,
        MAX_SESSION_MESSAGE_BODY_BYTES,
        { maxTotalMs: 10 * 60 * 1000 }
      );
      const parsedBody = sendMessageRequestSchema.safeParse(rawBody);

      if (!parsedBody.success) {
        return errorResponse("Invalid message request.", 400);
      }

      body = parsedBody.data;
      validateCombinedAttachmentCount(
        body.images?.length ?? 0,
        body.documents?.length ?? 0
      );
      if (body.documents?.length) {
        validateDocumentAttachments(body.documents);
      }
      if (body.images?.length) {
        await validateDecodedImageAttachments(body.images);
      }
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      throw error;
    }
    const actor = sessionActorFromAuth(auth);
    const turnStarted = await agent.beginSessionTurn(orgId, sessionId, actor);
    if (turnStarted === null) {
      return errorResponse("Session not found", 404);
    }
    if (!turnStarted) {
      return errorResponse(
        "A response is already in progress for this session.",
        409
      );
    }

    let session: Awaited<ReturnType<typeof agent.resolveSession>>;
    let turnOptions: Awaited<
      ReturnType<typeof agent.prepareAuthenticatedSessionTurnOptions>
    >;
    try {
      turnOptions = await agent.prepareAuthenticatedSessionTurnOptions(
        orgId,
        sessionId,
        actor
      );
      if (body.expectedQuestionnaire) {
        await agent.consumeSessionQuestionnaire(
          orgId,
          sessionId,
          body.expectedQuestionnaire
        );
      }
      session = await agent.resolveSession(orgId, sessionId, actor);
      if (!session) {
        sessionTurnRegistry.cancelTurn(sessionId);
        return errorResponse("Session not found", 404);
      }
    } catch (error) {
      sessionTurnRegistry.cancelTurn(sessionId);
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      throw error;
    }
    const clientOrigin = resolveRequestClientOrigin(
      c.req.raw,
      body.clientOrigin
    );
    const input = {
      documents: body.documents,
      images: body.images,
      message: body.message ?? "",
      policy: body.policy,
      relatedQuestions: body.relatedQuestions === true,
      ...(clientOrigin ? { clientOrigin } : {}),
    };
    const wantsStream =
      body.stream === true ||
      c.req.query("stream") === "true" ||
      c.req.header("Accept")?.includes("text/event-stream");

    if (wantsStream) {
      return streamMessage(
        sessionId,
        session,
        input,
        (terminal) => {
          agent.scheduleSessionTitleGeneration(sessionId);
          if (terminal.type === "done") {
            agent.schedulePostTurnSkillReview(sessionId);
          }
        },
        c.req.raw.signal,
        undefined,
        undefined,
        turnOptions
      );
    }

    const turnAbort = new AbortController();
    sessionTurnRegistry.attachAbort(sessionId, turnAbort);
    const turnSignal = AbortSignal.any([turnAbort.signal, c.req.raw.signal]);

    try {
      const reply = await session.send(input, {
        ...turnOptions,
        signal: turnSignal,
      });
      const contextUsage = session.getContextUsage() ?? undefined;
      sessionTurnRegistry.endTurn(sessionId, {
        reply,
        type: "done",
        ...(contextUsage ? { contextUsage } : {}),
      });
      agent.scheduleSessionTitleGeneration(sessionId);
      agent.schedulePostTurnSkillReview(sessionId);
      return json<SendMessageResponse>({
        reply,
        ...(contextUsage ? { contextUsage } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessionTurnRegistry.endTurn(sessionId, { error: message, type: "error" });
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      return errorResponse(message, 500);
    }
  });
}
