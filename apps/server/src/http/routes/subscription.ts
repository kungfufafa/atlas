import {
  AtlasApiError,
  type SubscriptionAuthState,
  type SubscriptionLoginStartRequest,
  type SubscriptionLoginStartResponse,
  type SubscriptionLoginStatusResponse,
  type SubscriptionModelListResponse,
  type SubscriptionProviderKind,
} from "@atlas/core";
import { createRoute, z } from "@hono/zod-openapi";
import {
  getSubscriptionRuntime,
  parseSubscriptionProviderKind,
  SubscriptionRuntimeError,
  subscriptionRuntimeErrorStatus,
  toPublicSubscriptionApiError,
} from "../../providers/subscription";
import type { ServerOptions } from "../context";
import {
  requireOrgAdminOrPlatformAdminFromContext,
  requirePlatformAdminFromContext,
} from "../org-guards";
import { json } from "../shared";
import type { HonoApp } from "../types";

export function registerSubscriptionRoutes(
  app: HonoApp,
  _options: ServerOptions
): void {
  registerSubscriptionOpenApiRoutes(app);

  app.get("/v1/subscription/:kind", async (context) => {
    const auth = requireOrgAdminOrPlatformAdminFromContext(context);
    const { kind, runtime } = runtimeFromParam(context.req.param("kind"));
    const state = await runRuntimeOperation(
      kind,
      () => runtime.getAuthState(),
      auth.isPlatformAdmin
    );
    return json<SubscriptionAuthState>(
      auth.isPlatformAdmin
        ? { ...state, canManage: true }
        : redactSubscriptionAuthState(state)
    );
  });

  app.post("/v1/subscription/:kind/login", async (context) => {
    requirePlatformAdminFromContext(context);
    const { kind, runtime } = runtimeFromParam(context.req.param("kind"));
    const body = await readLoginStartRequest(context.req.raw);
    return json<SubscriptionLoginStartResponse>(
      await runRuntimeOperation(kind, () => runtime.startLogin(body))
    );
  });

  app.get("/v1/subscription/:kind/login/:loginId", async (context) => {
    requirePlatformAdminFromContext(context);
    const { kind, runtime } = runtimeFromParam(context.req.param("kind"));
    return json<SubscriptionLoginStatusResponse>(
      await runRuntimeOperation(kind, () =>
        runtime.getLoginStatus(context.req.param("loginId"))
      )
    );
  });

  app.post("/v1/subscription/:kind/login/:loginId/wait", async (context) => {
    requirePlatformAdminFromContext(context);
    const { kind, runtime } = runtimeFromParam(context.req.param("kind"));
    return json<SubscriptionLoginStatusResponse>(
      await runRuntimeOperation(kind, () =>
        runtime.waitForLogin(
          context.req.param("loginId"),
          context.req.raw.signal
        )
      )
    );
  });

  app.post("/v1/subscription/:kind/login/:loginId/cancel", async (context) => {
    requirePlatformAdminFromContext(context);
    const { kind, runtime } = runtimeFromParam(context.req.param("kind"));
    await runRuntimeOperation(kind, () =>
      runtime.cancelLogin(context.req.param("loginId"))
    );
    return json({ ok: true as const });
  });

  app.post("/v1/subscription/:kind/logout", async (context) => {
    requirePlatformAdminFromContext(context);
    const { kind, runtime } = runtimeFromParam(context.req.param("kind"));
    const state = await runRuntimeOperation(kind, () => runtime.logout());
    return json<SubscriptionAuthState>({ ...state, canManage: true });
  });

  app.get("/v1/subscription/:kind/models", async (context) => {
    const auth = requireOrgAdminOrPlatformAdminFromContext(context);
    const { kind, runtime } = runtimeFromParam(context.req.param("kind"));
    return json<SubscriptionModelListResponse>({
      models: await runRuntimeOperation(
        kind,
        () => runtime.listModels(),
        auth.isPlatformAdmin
      ),
    });
  });
}

function registerSubscriptionOpenApiRoutes(app: HonoApp): void {
  const kindParam = z.object({
    kind: z.enum(["chatgpt", "claude"]).openapi({
      param: { in: "path", name: "kind" },
    }),
  });
  const loginParam = kindParam.extend({
    loginId: z.string().openapi({
      param: { in: "path", name: "loginId" },
    }),
  });
  const errorSchema = z
    .object({ error: z.string() })
    .openapi("SubscriptionApiErrorResponse");
  const authStateSchema = z
    .object({
      authenticated: z.boolean(),
      canManage: z.boolean().optional(),
      email: z.string().optional(),
      installHint: z.string().optional(),
      loginCommand: z.string().optional(),
      message: z.string().optional(),
      plan: z.string().optional(),
      provider: z.enum(["chatgpt", "claude"]),
      runtimeVersion: z.string().nullable().optional(),
      status: z.enum([
        "not_installed",
        "not_authenticated",
        "login_pending",
        "authenticated",
        "expired",
        "error",
      ]),
    })
    .openapi("SubscriptionAuthState");
  const loginStartRequestSchema = z
    .object({ method: z.enum(["browser", "device"]).optional() })
    .strict()
    .openapi("SubscriptionLoginStartRequest");
  const loginStartResponseSchema = z
    .object({
      authUrl: z.string().optional(),
      instructions: z.string(),
      loginCommand: z.string().optional(),
      loginId: z.string(),
      method: z.enum(["browser", "device", "cli"]),
      userCode: z.string().optional(),
      verificationUrl: z.string().optional(),
    })
    .openapi("SubscriptionLoginStartResponse");
  const loginStatusResponseSchema = z
    .object({
      account: authStateSchema.optional(),
      error: z.string().optional(),
      loginId: z.string(),
      status: z.enum(["pending", "completed", "failed", "cancelled"]),
    })
    .openapi("SubscriptionLoginStatusResponse");
  const modelListResponseSchema = z
    .object({
      models: z.array(
        z
          .object({
            default: z.boolean().optional(),
            id: z.string(),
            name: z.string(),
            provider: z.string(),
          })
          .passthrough()
      ),
    })
    .openapi("SubscriptionModelListResponse");
  const cancelResponseSchema = z
    .object({ ok: z.literal(true) })
    .openapi("CancelSubscriptionLoginResponse");
  const errorResponses = {
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid subscription request",
    },
    401: {
      content: { "application/json": { schema: errorSchema } },
      description: "Authentication required",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Insufficient permissions",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "Subscription authentication is unavailable or expired",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Subscription runtime failure",
    },
    503: {
      content: { "application/json": { schema: errorSchema } },
      description: "Subscription runtime unavailable",
    },
  } as const;

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getSubscriptionAuthState",
      path: "/v1/subscription/{kind}",
      request: { params: kindParam },
      responses: {
        200: {
          content: { "application/json": { schema: authStateSchema } },
          description: "Subscription authentication state",
        },
        ...errorResponses,
      },
      summary: "Get subscription authentication state",
      tags: ["Subscriptions"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "startSubscriptionLogin",
      path: "/v1/subscription/{kind}/login",
      request: {
        body: {
          content: {
            "application/json": { schema: loginStartRequestSchema },
          },
          required: false,
        },
        params: kindParam,
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: loginStartResponseSchema },
          },
          description: "Subscription login started",
        },
        ...errorResponses,
      },
      summary: "Start subscription login",
      tags: ["Subscriptions"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getSubscriptionLoginStatus",
      path: "/v1/subscription/{kind}/login/{loginId}",
      request: { params: loginParam },
      responses: {
        200: {
          content: {
            "application/json": { schema: loginStatusResponseSchema },
          },
          description: "Subscription login status",
        },
        ...errorResponses,
      },
      summary: "Get subscription login status",
      tags: ["Subscriptions"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "waitForSubscriptionLogin",
      path: "/v1/subscription/{kind}/login/{loginId}/wait",
      request: { params: loginParam },
      responses: {
        200: {
          content: {
            "application/json": { schema: loginStatusResponseSchema },
          },
          description: "Completed or terminal subscription login status",
        },
        ...errorResponses,
      },
      summary: "Wait for subscription login",
      tags: ["Subscriptions"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "cancelSubscriptionLogin",
      path: "/v1/subscription/{kind}/login/{loginId}/cancel",
      request: { params: loginParam },
      responses: {
        200: {
          content: { "application/json": { schema: cancelResponseSchema } },
          description: "Subscription login cancelled",
        },
        ...errorResponses,
      },
      summary: "Cancel subscription login",
      tags: ["Subscriptions"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "logoutSubscription",
      path: "/v1/subscription/{kind}/logout",
      request: { params: kindParam },
      responses: {
        200: {
          content: { "application/json": { schema: authStateSchema } },
          description: "Subscription logged out",
        },
        ...errorResponses,
      },
      summary: "Log out a host subscription",
      tags: ["Subscriptions"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "listSubscriptionModels",
      path: "/v1/subscription/{kind}/models",
      request: { params: kindParam },
      responses: {
        200: {
          content: {
            "application/json": { schema: modelListResponseSchema },
          },
          description: "Models available from the host subscription",
        },
        ...errorResponses,
      },
      summary: "List subscription models",
      tags: ["Subscriptions"],
    })
  );
}

async function readLoginStartRequest(
  request: Request
): Promise<SubscriptionLoginStartRequest> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AtlasApiError("Invalid JSON in request body.", 400);
  }

  if (!(body && typeof body === "object") || Array.isArray(body)) {
    throw new AtlasApiError("Subscription login body must be an object.", 400);
  }

  const bodyRecord = body as Record<string, unknown>;
  if (Object.keys(bodyRecord).some((key) => key !== "method")) {
    throw new AtlasApiError("Invalid subscription login request.", 400);
  }

  const method = bodyRecord.method;
  if (method === undefined) {
    return {};
  }
  if (method !== "browser" && method !== "device") {
    throw new AtlasApiError(
      'Subscription login method must be "browser" or "device".',
      400
    );
  }
  return { method };
}

function redactSubscriptionAuthState(
  state: SubscriptionAuthState
): SubscriptionAuthState {
  const redactedState = {
    ...state,
    canManage: false,
    message: state.authenticated
      ? "Connected by a Superadmin for this Atlas host."
      : "A Superadmin must connect this subscription for the Atlas host.",
  };
  delete redactedState.email;
  delete redactedState.installHint;
  delete redactedState.loginCommand;
  delete redactedState.plan;
  return redactedState;
}

async function runRuntimeOperation<T>(
  provider: SubscriptionProviderKind,
  operation: () => Promise<T>,
  includeRuntimeDetails = true
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toHttpError(error, provider, includeRuntimeDetails);
  }
}

function runtimeFromParam(kind: string) {
  const parsed = parseSubscriptionProviderKind(kind);
  if (!parsed) {
    throw new AtlasApiError("Unknown subscription provider.", 400);
  }
  return { kind: parsed, runtime: getSubscriptionRuntime(parsed) };
}

function toHttpError(
  error: unknown,
  provider: SubscriptionProviderKind,
  includeRuntimeDetails: boolean
): AtlasApiError {
  if (!includeRuntimeDetails) {
    return toPublicSubscriptionApiError(provider, error);
  }
  if (error instanceof SubscriptionRuntimeError) {
    return new AtlasApiError(
      error.message,
      subscriptionRuntimeErrorStatus(error.code)
    );
  }
  if (error instanceof AtlasApiError) {
    return error;
  }
  return new AtlasApiError("Subscription request failed.", 500);
}
