import {
  AtlasApiError,
  type BranchSessionRequest,
  type BranchSessionResponse,
  type CompactionResponse,
  type CompactSessionRequest,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ListSessionsResponse,
  PrincipalRequiredError,
  type SendMessageRequest,
  type SendMessageResponse,
  type SessionMessagesResponse,
  type SessionStatusResponse,
  type UpdateSessionRequest,
} from "@atlas/core";
import { createRoute, z } from "@hono/zod-openapi";
import { resolveRequestClientOrigin } from "../../services/composio-callback-url";
import { sessionTurnRegistry } from "../../services/session-turn-registry";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requireNotViewerFromContext,
} from "../org-guards";
import {
  errorResponse,
  getRequestAuth,
  json,
  parseChannel,
  readJson,
  streamMessage,
  streamTurnSubscribe,
} from "../shared";
import type { HonoApp } from "../types";

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
        .object({ channelUserId: z.string().min(1) })
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
  const sendMessageRequestSchema = z
    .object({
      clientOrigin: z.string().optional(),
      documents: z.array(z.object({}).passthrough()).optional(),
      images: z.array(z.object({}).passthrough()).optional(),
      message: z.string(),
      policy: z
        .enum(["auto", "fast", "standard", "research", "agent"])
        .optional(),
      relatedQuestions: z.boolean().optional(),
      stream: z.boolean().optional(),
    })
    .openapi("SendMessageRequest");
  const sendMessageResponseSchema = z
    .object({ reply: z.string() })
    .openapi("SendMessageResponse");
  const sessionIdParamSchema = z.object({
    sessionId: z.string().openapi({ param: { in: "path", name: "sessionId" } }),
  });
  const sessionListQuerySchema = z.object({
    channel: agentChannelSchema.optional(),
    profileId: z.string().optional(),
  });
  const streamQuerySchema = z.object({
    stream: z.enum(["true", "false"]).optional(),
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
    try {
      const sessionId = await agent.createSession(
        orgId,
        channel,
        body.profileId,
        auth.user.id,
        {
          excludeSuperAgent: auth.mode === "local-token" && channel !== "cli",
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
        error instanceof Error && error.name === "PrincipalRequiredError"
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
      pairingAssertion?: string;
      userId?: string;
    }>(c.req.raw);
    try {
      const principal = await agent.identityService.bindExternalPrincipal({
        actor: {
          mode: auth.mode,
          userId: auth.user.id,
        },
        channel: body.channel,
        channelUserId: body.channelUserId,
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
    const sessionId = c.req.param("sessionId");
    const approvalId = c.req.param("approvalId");
    const body = await readJson<{ decision: "approved" | "denied" }>(c.req.raw);
    try {
      const result = await agent.executionPlane.decide({
        approvalId,
        decision: body.decision,
        principal: {
          isPlatformAdmin: auth.isPlatformAdmin === true,
          orgId,
          orgRole: auth.orgRole ?? "member",
          userId: auth.user.id,
        },
      });
      void sessionId;
      return json({
        grantId: result.grantId,
        resumed: body.decision === "approved",
        status: result.record.status,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.get("/v1/sessions", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = c.req.query("profileId")?.trim();
    const channel = parseChannel(c.req.query("channel") ?? "web");

    if (!profileId) {
      return errorResponse("profileId is required.", 400);
    }

    return json<ListSessionsResponse>(
      await agent.listSessions(orgId, profileId, channel)
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
        {
          isPlatformAdmin: auth.isPlatformAdmin,
          orgRole: auth.orgRole,
          userId: auth.user.id,
        }
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
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const purge = c.req.query("purge") === "true";
    const cleared = purge
      ? await agent.purgeSession(orgId, sessionId)
      : await agent.clearSession(orgId, sessionId);

    if (!cleared) {
      return errorResponse("Session not found", 404);
    }

    return new Response(null, { status: 204 });
  });

  app.post("/v1/sessions/:sessionId/compact", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const body = await readJson<CompactSessionRequest>(c.req.raw).catch(
      () => ({}) as CompactSessionRequest
    );
    const result = await agent.compactSession(orgId, sessionId, {
      force: body.force ?? false,
    });

    if (!result) {
      return errorResponse("Session not found", 404);
    }

    return json<CompactionResponse>(result);
  });

  app.get("/v1/sessions/:sessionId/messages", async (c) => {
    const auth = getRequestAuth(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const result = await agent.getSessionMessages(orgId, sessionId, {
      isPlatformAdmin: auth.isPlatformAdmin,
      orgRole: auth.orgRole,
      userId: auth.user.id,
    });

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

  app.get("/v1/sessions/:sessionId/status", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const result = await agent.getSessionMessages(orgId, sessionId);

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
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));
    const result = await agent.getSessionMessages(orgId, sessionId);

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
        {
          isPlatformAdmin: auth.isPlatformAdmin,
          orgRole: auth.orgRole,
          userId: auth.user.id,
        }
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
    const turnStarted = await agent.beginSessionTurn(orgId, sessionId);
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
    let body: SendMessageRequest;
    try {
      session = await agent.resolveSession(orgId, sessionId, {
        isPlatformAdmin: auth.isPlatformAdmin,
        orgRole: auth.orgRole,
        userId: auth.user.id,
      });
      if (!session) {
        sessionTurnRegistry.cancelTurn(sessionId);
        return errorResponse("Session not found", 404);
      }
      body = await readJson<SendMessageRequest>(c.req.raw);
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
        c.req.raw.signal
      );
    }

    const turnAbort = new AbortController();
    sessionTurnRegistry.attachAbort(sessionId, turnAbort);
    const turnSignal = AbortSignal.any([turnAbort.signal, c.req.raw.signal]);

    try {
      const reply = await session.send(input, { signal: turnSignal });
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
