import { describe, expect, test } from "bun:test";
import {
  buildCliConfigureProviderRequest,
  buildCliSetupRequest,
  ensureCliSubscriptionAuthenticated,
} from "./setup";

describe("buildCliSetupRequest", () => {
  test("builds the setup payload with a default workspace", () => {
    expect(
      buildCliSetupRequest({
        confirmPassword: "password123",
        email: "Admin@Example.com",
        name: "Jane Admin",
        password: "password123",
        workspaceName: "",
      })
    ).toEqual({
      request: {
        admin: {
          email: "Admin@Example.com",
          name: "Jane Admin",
          password: "password123",
        },
        organization: {
          name: "Personal",
          slug: "personal",
        },
      },
    });
  });

  test("rejects mismatched passwords before calling the API", () => {
    expect(
      buildCliSetupRequest({
        confirmPassword: "password124",
        email: "admin@example.com",
        name: "Jane Admin",
        password: "password123",
        workspaceName: "Acme",
      })
    ).toEqual({ error: "Passwords do not match." });
  });
});

describe("buildCliConfigureProviderRequest", () => {
  test("leaves subscription model and connection fields runtime-owned", () => {
    for (const type of ["chatgpt", "claude"] as const) {
      const request = buildCliConfigureProviderRequest(
        {
          apiKey: "",
          baseUrl: "https://must-not-be-forwarded.example",
          createdAt: "2026-08-27T00:00:00.000Z",
          customModels: [{ default: true, id: "must-not-be-forwarded" }],
          id: `${type}-1`,
          label: type,
          type,
          wireApi: "responses",
        },
        () => "gpt-5.4"
      );

      expect(request).toEqual({ provider: type });
    }
  });
});

describe("ensureCliSubscriptionAuthenticated", () => {
  test("drives ChatGPT device login to completion before configuration", async () => {
    const outputs: string[] = [];
    const startRequests: unknown[] = [];
    let statusCalls = 0;
    await ensureCliSubscriptionAuthenticated(
      {
        async cancelSubscriptionLogin() {
          return { ok: true as const };
        },
        async getSubscriptionAuth() {
          return {
            authenticated: false,
            provider: "chatgpt" as const,
            status: "not_authenticated" as const,
          };
        },
        async getSubscriptionLoginStatus(_kind, loginId) {
          statusCalls += 1;
          if (statusCalls === 1) {
            return { loginId, status: "pending" as const };
          }
          return {
            account: {
              authenticated: true,
              provider: "chatgpt" as const,
              status: "authenticated" as const,
            },
            loginId,
            status: "completed" as const,
          };
        },
        async startSubscriptionLogin(_kind, request) {
          startRequests.push(request);
          return {
            instructions: "Open the verification URL.",
            loginId: "login-1",
            method: "device" as const,
            userCode: "ABCD-EFGH",
            verificationUrl: "https://example.test/device",
          };
        },
      },
      "chatgpt",
      {
        pollIntervalMs: 0,
        sleep: async () => undefined,
        writeLine: (line) => outputs.push(line),
      }
    );

    expect(startRequests).toEqual([{ method: "device" }]);
    expect(outputs).toContain("Device code: ABCD-EFGH");
    expect(outputs.at(-1)).toBe("ChatGPT connected.");
  });

  test("prints the host command and cancels a failed Claude login", async () => {
    const outputs: string[] = [];
    const cancelled: string[] = [];
    await expect(
      ensureCliSubscriptionAuthenticated(
        {
          async cancelSubscriptionLogin(_kind, loginId) {
            cancelled.push(loginId);
            return { ok: true as const };
          },
          async getSubscriptionAuth() {
            return {
              authenticated: false,
              provider: "claude" as const,
              status: "not_authenticated" as const,
            };
          },
          async getSubscriptionLoginStatus(_kind, loginId) {
            return {
              error: "Claude login did not complete.",
              loginId,
              status: "failed" as const,
            };
          },
          async startSubscriptionLogin() {
            return {
              instructions: "Authenticate Claude.",
              loginCommand: "/atlas/bin/claude auth login",
              loginId: "login-2",
              method: "cli" as const,
            };
          },
        },
        "claude",
        { writeLine: (line) => outputs.push(line) }
      )
    ).rejects.toThrow("Claude login did not complete.");

    expect(outputs).toContain(
      "Run on the Atlas host: /atlas/bin/claude auth login"
    );
    expect(cancelled).toEqual(["login-2"]);
  });

  test("cancels an interrupted login before allowing an immediate retry", async () => {
    const controller = new AbortController();
    const cancelled: string[] = [];
    let loginCount = 0;
    const client = {
      async cancelSubscriptionLogin(
        _kind: "chatgpt" | "claude",
        loginId: string
      ) {
        cancelled.push(loginId);
        return { ok: true as const };
      },
      async getSubscriptionAuth() {
        return {
          authenticated: false,
          provider: "chatgpt" as const,
          status: "not_authenticated" as const,
        };
      },
      async getSubscriptionLoginStatus(
        _kind: "chatgpt" | "claude",
        loginId: string
      ) {
        return loginId === "login-1"
          ? { loginId, status: "pending" as const }
          : {
              account: {
                authenticated: true,
                provider: "chatgpt" as const,
                status: "authenticated" as const,
              },
              loginId,
              status: "completed" as const,
            };
      },
      async startSubscriptionLogin() {
        loginCount += 1;
        return {
          instructions: "Sign in.",
          loginId: `login-${loginCount}`,
          method: "device" as const,
        };
      },
    };

    await expect(
      ensureCliSubscriptionAuthenticated(client, "chatgpt", {
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
        },
        writeLine: () => undefined,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    await ensureCliSubscriptionAuthenticated(client, "chatgpt", {
      writeLine: () => undefined,
    });

    expect(cancelled).toEqual(["login-1"]);
    expect(loginCount).toBe(2);
  });
});
