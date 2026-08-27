import { afterEach, describe, expect, test } from "bun:test";
import { AtlasApiError, type SubscriptionLoginStartRequest } from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";
import {
  SubscriptionRuntimeError,
  setChatgptRuntimeForTests,
} from "../../providers/subscription";
import type { ChatgptSubscriptionRuntime } from "../../providers/subscription/chatgpt/runtime";
import type { AuthService } from "../../services/auth-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { buildHttpOpenApiSpec } from "../openapi";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  type AppFetch,
  loginPlatformAdminSession,
  loginUserSession,
  seedOrgAdmin,
  type TestBrowserSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-subscription-routes-");

const ORG_ID = "org_test";
const PASSWORD = "password123";

async function loginPlatformAdminInOrg(
  app: AppFetch,
  authService: AuthService,
  databaseAdapter: DatabaseAdapter,
  orgId: string
): Promise<TestBrowserSession> {
  const email = "platform@example.com";
  const session = await loginPlatformAdminSession(
    app,
    authService,
    databaseAdapter,
    email,
    PASSWORD
  );
  const user = await databaseAdapter.getUserByEmail(email);
  if (!user) {
    throw new Error("Platform admin was not created.");
  }
  await databaseAdapter.upsertOrgMember({
    createdAt: new Date().toISOString(),
    orgId,
    role: "viewer",
    userId: user.id,
  });
  return session;
}

describe("subscription routes", () => {
  afterEach(() => {
    setChatgptRuntimeForTests(null);
  });

  test("rejects unknown subscription kinds", async () => {
    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );
    const response = await app.fetch(
      new Request("http://localhost:4310/v1/subscription/openai", {
        headers: admin.headers({ "X-CSRF-Token": admin.csrfToken }),
      })
    );
    expect(response.status).toBe(400);
  });

  test("redacts host account details for admins in every organization", async () => {
    setChatgptRuntimeForTests({
      getAuthState: async () => ({
        authenticated: true,
        email: "user@example.com",
        loginCommand: "codex login",
        plan: "pro",
        provider: "chatgpt",
        status: "authenticated",
      }),
    } as unknown as ChatgptSubscriptionRuntime);

    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    const admins = [
      {
        email: "admin@example.com",
        orgId: ORG_ID,
        userId: "user_admin",
      },
      {
        email: "other-admin@example.com",
        orgId: "org_other",
        userId: "user_other_admin",
      },
    ];
    for (const admin of admins) {
      await seedOrgAdmin(databaseAdapter, {
        authService,
        email: admin.email,
        orgId: admin.orgId,
        userId: admin.userId,
      });
      const session = await loginUserSession(
        app,
        admin.email,
        PASSWORD,
        admin.orgId
      );
      const response = await app.fetch(
        new Request("http://localhost:4310/v1/subscription/chatgpt", {
          headers: session.headers(),
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        authenticated: true,
        canManage: false,
        message: "Connected by a Superadmin for this Atlas host.",
        provider: "chatgpt",
        status: "authenticated",
      });
    }
  });

  test("returns full account state to a platform admin", async () => {
    setChatgptRuntimeForTests({
      getAuthState: async () => ({
        authenticated: true,
        email: "user@example.com",
        loginCommand: "codex login",
        plan: "pro",
        provider: "chatgpt",
        status: "authenticated",
      }),
    } as unknown as ChatgptSubscriptionRuntime);
    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const platform = await loginPlatformAdminInOrg(
      app,
      authService,
      databaseAdapter,
      ORG_ID
    );

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/subscription/chatgpt", {
        headers: platform.headers({}, ORG_ID),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      canManage: true,
      email: "user@example.com",
      loginCommand: "codex login",
      plan: "pro",
      provider: "chatgpt",
      status: "authenticated",
    });
  });

  test("allows workspace admins to list subscription models", async () => {
    setChatgptRuntimeForTests({
      listModels: async () => [
        {
          id: "gpt-5-codex",
          name: "GPT-5 Codex",
          provider: "chatgpt",
        },
      ],
    } as unknown as ChatgptSubscriptionRuntime);
    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/subscription/chatgpt/models", {
        headers: admin.headers(),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [
        {
          id: "gpt-5-codex",
          name: "GPT-5 Codex",
          provider: "chatgpt",
        },
      ],
    });
  });

  test("accepts only browser and device login methods", async () => {
    const received: SubscriptionLoginStartRequest[] = [];
    setChatgptRuntimeForTests({
      startLogin: async (request) => {
        received.push(request ?? {});
        return {
          instructions: "Continue login.",
          loginId: `login_${received.length}`,
          method: request?.method ?? "browser",
        };
      },
    } as unknown as ChatgptSubscriptionRuntime);
    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const platform = await loginPlatformAdminInOrg(
      app,
      authService,
      databaseAdapter,
      ORG_ID
    );

    for (const method of ["browser", "device"] as const) {
      const response = await app.fetch(
        new Request("http://localhost:4310/v1/subscription/chatgpt/login", {
          body: JSON.stringify({ method }),
          headers: platform.headers(
            {
              "Content-Type": "application/json",
              "X-CSRF-Token": platform.csrfToken,
            },
            ORG_ID
          ),
          method: "POST",
        })
      );
      expect(response.status).toBe(200);
    }

    for (const body of [{ method: "cli" }, { method: 42 }, { extra: true }]) {
      const response = await app.fetch(
        new Request("http://localhost:4310/v1/subscription/chatgpt/login", {
          body: JSON.stringify(body),
          headers: platform.headers(
            {
              "Content-Type": "application/json",
              "X-CSRF-Token": platform.csrfToken,
            },
            ORG_ID
          ),
          method: "POST",
        })
      );
      expect(response.status).toBe(400);
    }

    expect(received).toEqual([{ method: "browser" }, { method: "device" }]);
  });

  test("allows a platform admin to inspect and manage the login lifecycle", async () => {
    const calls: string[] = [];
    setChatgptRuntimeForTests({
      cancelLogin: async (loginId) => {
        calls.push(`cancel:${loginId}`);
      },
      getLoginStatus: async (loginId) => {
        calls.push(`status:${loginId}`);
        return { loginId, status: "pending" };
      },
      logout: async () => {
        calls.push("logout");
        return {
          authenticated: false,
          provider: "chatgpt",
          status: "not_authenticated",
        };
      },
      waitForLogin: async (loginId) => {
        calls.push(`wait:${loginId}`);
        return { loginId, status: "completed" };
      },
    } as unknown as ChatgptSubscriptionRuntime);
    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const platform = await loginPlatformAdminInOrg(
      app,
      authService,
      databaseAdapter,
      ORG_ID
    );
    const csrfHeaders = platform.headers(
      { "X-CSRF-Token": platform.csrfToken },
      ORG_ID
    );

    const statusResponse = await app.fetch(
      new Request(
        "http://localhost:4310/v1/subscription/chatgpt/login/login_1",
        { headers: platform.headers({}, ORG_ID) }
      )
    );
    const waitResponse = await app.fetch(
      new Request(
        "http://localhost:4310/v1/subscription/chatgpt/login/login_1/wait",
        { headers: csrfHeaders, method: "POST" }
      )
    );
    const cancelResponse = await app.fetch(
      new Request(
        "http://localhost:4310/v1/subscription/chatgpt/login/login_1/cancel",
        { headers: csrfHeaders, method: "POST" }
      )
    );
    const logoutResponse = await app.fetch(
      new Request("http://localhost:4310/v1/subscription/chatgpt/logout", {
        headers: csrfHeaders,
        method: "POST",
      })
    );

    expect(statusResponse.status).toBe(200);
    expect(waitResponse.status).toBe(200);
    expect(cancelResponse.status).toBe(200);
    expect(logoutResponse.status).toBe(200);
    expect(await logoutResponse.json()).toEqual({
      authenticated: false,
      canManage: true,
      provider: "chatgpt",
      status: "not_authenticated",
    });
    expect(calls).toEqual([
      "status:login_1",
      "wait:login_1",
      "cancel:login_1",
      "logout",
    ]);
  });

  test("does not expose unexpected runtime errors", async () => {
    setChatgptRuntimeForTests({
      getAuthState: async () => {
        throw new Error("secret process details");
      },
    } as unknown as ChatgptSubscriptionRuntime);
    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/subscription/chatgpt", {
        headers: admin.headers(),
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error:
        "ChatGPT subscription request failed. Ask a Superadmin to check the host runtime.",
    });
  });

  test("redacts typed auth runtime failures for workspace admins", async () => {
    setChatgptRuntimeForTests({
      getAuthState: async () => {
        throw new SubscriptionRuntimeError(
          "chatgpt",
          "provider_unavailable",
          "spawn /private/atlas/runtime failed with host details"
        );
      },
    } as unknown as ChatgptSubscriptionRuntime);
    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );
    const platform = await loginPlatformAdminInOrg(
      app,
      authService,
      databaseAdapter,
      ORG_ID
    );

    const adminResponse = await app.fetch(
      new Request("http://localhost:4310/v1/subscription/chatgpt", {
        headers: admin.headers(),
      })
    );
    const platformResponse = await app.fetch(
      new Request("http://localhost:4310/v1/subscription/chatgpt", {
        headers: platform.headers({}, ORG_ID),
      })
    );

    expect(adminResponse.status).toBe(503);
    expect(await adminResponse.json()).toEqual({
      error:
        "ChatGPT runtime is not available on this Atlas host. Ask a Superadmin to check it.",
    });
    expect(platformResponse.status).toBe(503);
    expect(await platformResponse.json()).toEqual({
      error: "spawn /private/atlas/runtime failed with host details",
    });
  });

  test("redacts subscription validation failures on provider create paths", async () => {
    const { app, authService, databaseAdapter } = createMinimalHonoApp({
      agent: {
        configureProvider: () => {
          throw new Error("native command exposed account metadata");
        },
        createProvider: () => {
          throw new AtlasApiError(
            'Model "internal-model-id" failed host validation.',
            400
          );
        },
        listProfiles: async () => ({ profiles: [{ id: "default" }] }),
        testProvider: () => {
          throw new SubscriptionRuntimeError(
            "claude",
            "runtime_error",
            "native command failed at /private/atlas with account metadata"
          );
        },
      },
    });
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );
    const requests = [
      {
        body: { type: "claude" },
        error:
          "Claude subscription request failed. Ask a Superadmin to check the host runtime.",
        path: "/v1/providers/test",
        status: 400,
      },
      {
        body: { type: "claude" },
        error:
          "Claude subscription request could not be validated. Ask a Superadmin to check the host subscription.",
        path: "/v1/providers",
        status: 400,
      },
      {
        body: { provider: "claude" },
        error:
          "Claude subscription request failed. Ask a Superadmin to check the host runtime.",
        path: "/v1/settings/provider",
        status: 500,
      },
    ] as const;

    for (const request of requests) {
      const response = await app.fetch(
        new Request(`http://localhost:4310${request.path}`, {
          body: JSON.stringify(request.body),
          headers: admin.headers({
            "Content-Type": "application/json",
            "X-CSRF-Token": admin.csrfToken,
          }),
          method: request.path === "/v1/settings/provider" ? "PUT" : "POST",
        })
      );

      expect(response.status).toBe(request.status);
      expect(await response.json()).toEqual({
        error: request.error,
      });
    }
  });

  test("keeps subscription validation details available to platform admins", async () => {
    const { app, authService, databaseAdapter } = createMinimalHonoApp({
      agent: {
        listProfiles: async () => ({ profiles: [{ id: "default" }] }),
        testProvider: () => {
          throw new SubscriptionRuntimeError(
            "claude",
            "runtime_error",
            "native command failed at /private/atlas"
          );
        },
      },
    });
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const platform = await loginPlatformAdminInOrg(
      app,
      authService,
      databaseAdapter,
      ORG_ID
    );

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/providers/test", {
        body: JSON.stringify({ type: "claude" }),
        headers: platform.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": platform.csrfToken,
          },
          ORG_ID
        ),
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "native command failed at /private/atlas",
    });
  });

  test("does not report provider auth expiry as an Atlas authentication failure", async () => {
    setChatgptRuntimeForTests({
      listModels: async () => {
        throw new SubscriptionRuntimeError(
          "chatgpt",
          "authentication_expired",
          "Connect ChatGPT again."
        );
      },
    } as unknown as ChatgptSubscriptionRuntime);
    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    await seedOrgAdmin(databaseAdapter, { authService, orgId: ORG_ID });
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/subscription/chatgpt/models", {
        headers: admin.headers(),
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "ChatGPT is not connected on this Atlas host. Ask a Superadmin to reconnect it.",
    });
  });

  test("publishes every subscription operation and response schema", async () => {
    const { app } = createMinimalHonoApp();
    const response = await app.fetch(
      new Request("http://localhost:4310/openapi.json")
    );
    const responseDocument = (await response.json()) as {
      components?: { schemas?: Record<string, unknown> };
      paths?: Record<
        string,
        Record<
          string,
          { operationId?: string; responses?: Record<string, unknown> }
        >
      >;
    };
    const documents = [
      responseDocument,
      buildHttpOpenApiSpec() as unknown as typeof responseDocument,
    ];
    const operations = [
      ["/v1/subscription/{kind}", "get", "getSubscriptionAuthState"],
      ["/v1/subscription/{kind}/login", "post", "startSubscriptionLogin"],
      [
        "/v1/subscription/{kind}/login/{loginId}",
        "get",
        "getSubscriptionLoginStatus",
      ],
      [
        "/v1/subscription/{kind}/login/{loginId}/wait",
        "post",
        "waitForSubscriptionLogin",
      ],
      [
        "/v1/subscription/{kind}/login/{loginId}/cancel",
        "post",
        "cancelSubscriptionLogin",
      ],
      ["/v1/subscription/{kind}/logout", "post", "logoutSubscription"],
      ["/v1/subscription/{kind}/models", "get", "listSubscriptionModels"],
    ] as const;

    expect(response.status).toBe(200);
    for (const document of documents) {
      for (const [path, method, operationId] of operations) {
        const operation = document.paths?.[path]?.[method];
        expect(operation?.operationId).toBe(operationId);
        expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
          "200",
          "400",
          "401",
          "403",
          "409",
          "500",
          "503",
        ]);
      }
      expect(Object.keys(document.components?.schemas ?? {})).toEqual(
        expect.arrayContaining([
          "CancelSubscriptionLoginResponse",
          "SubscriptionAuthState",
          "SubscriptionLoginStartRequest",
          "SubscriptionLoginStartResponse",
          "SubscriptionLoginStatusResponse",
          "SubscriptionModelListResponse",
        ])
      );
    }
  });
});
