import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runWithUserConfigDir, type SubscriptionAuthState } from "@atlas/core";
import { setClaudeRuntimeForTests } from "../runtimes";
import {
  listSubscriptionSessionDeletionCandidates,
  withSubscriptionSessionLease,
  writeSubscriptionSession,
} from "../session-store";
import { createClaudeProvider } from "./provider";
import {
  assertClaudeLogoutCommandSucceeded,
  type ClaudeAgentSdk,
  type ClaudeQueryHandle,
  ClaudeSubscriptionRuntime,
  parseClaudeAuthStatusOutput,
} from "./runtime";

const AUTHENTICATED_STATE: SubscriptionAuthState = {
  authenticated: true,
  provider: "claude",
  status: "authenticated",
};

class AuthenticatedClaudeRuntime extends ClaudeSubscriptionRuntime {
  override async getAuthState(): Promise<SubscriptionAuthState> {
    return AUTHENTICATED_STATE;
  }
}

class DelayedAuthClaudeRuntime extends ClaudeSubscriptionRuntime {
  private releaseAuthState: () => void = () => undefined;
  private readonly authStateReady = new Promise<void>((resolve) => {
    this.releaseAuthState = resolve;
  });

  override async getAuthState(): Promise<SubscriptionAuthState> {
    await this.authStateReady;
    return AUTHENTICATED_STATE;
  }

  releaseAuth(): void {
    this.releaseAuthState();
  }
}

class UnauthenticatedClaudeRuntime extends ClaudeSubscriptionRuntime {
  override async getAuthState(): Promise<SubscriptionAuthState> {
    return {
      authenticated: false,
      provider: "claude",
      status: "not_authenticated",
    };
  }
}

class ControlledLogoutClaudeRuntime extends ClaudeSubscriptionRuntime {
  private readonly events: string[];

  constructor(sdk: ClaudeAgentSdk, events: string[]) {
    super({ sdk });
    this.events = events;
  }

  override async getAuthState(): Promise<SubscriptionAuthState> {
    return AUTHENTICATED_STATE;
  }

  protected override async logoutNativeAccount(): Promise<void> {
    this.events.push("logout");
  }
}

function queryHandle(messages: unknown[]): ClaudeQueryHandle {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
  };
}

async function withTemporaryConfig<T>(run: () => Promise<T>): Promise<T> {
  const directory = await mkdtemp("/tmp/atlas-claude-runtime-");
  try {
    return await runWithUserConfigDir(directory, run);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("Claude subscription runtime", () => {
  test("disables native capabilities and buffers Atlas tool syntax", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const sdk: ClaudeAgentSdk = {
      query: ({ options }) => {
        capturedOptions = options;
        return queryHandle([
          {
            message: {
              content: [{ text: "Working.", type: "text" }],
              model: "claude-sonnet-4-6",
            },
            session_id: "claude-session",
            type: "assistant",
          },
          {
            errors: [],
            is_error: false,
            result: [
              "Working.",
              "```atlas-tool-call",
              '{"name":"knowledge_base_search","arguments":{"query":"atlas"}}',
              "```",
            ].join("\n"),
            session_id: "claude-session",
            subtype: "success",
            type: "result",
            usage: { input_tokens: 4, output_tokens: 5 },
          },
        ]);
      },
    };
    const runtime = new AuthenticatedClaudeRuntime({ sdk });
    const chunks: string[] = [];

    const result = await withTemporaryConfig(async () =>
      runtime.streamChat(
        {
          messages: [{ content: "Search", role: "user" }],
          providerOptions: {
            thinking: { effort: "xhigh", enabled: true },
          },
          system: "You are Atlas.",
          tools: [
            {
              description: "Search records",
              name: "knowledge_base_search",
              parameters: { type: "object" },
            },
          ],
        },
        { onChunk: (chunk) => chunks.push(chunk) },
        "claude-sonnet-4-6"
      )
    );

    expect(capturedOptions).toMatchObject({
      allowedTools: [],
      effort: "xhigh",
      mcpServers: {},
      permissionMode: "dontAsk",
      settingSources: [],
      skills: [],
      thinking: { display: "summarized", type: "adaptive" },
      tools: [],
    });
    expect(result.content).toBe("Working.");
    expect(result.toolCalls).toEqual([
      {
        arguments: { query: "atlas" },
        id: expect.any(String),
        name: "knowledge_base_search",
      },
    ]);
    expect(chunks).toEqual(["Working."]);
    expect(chunks.join("")).not.toContain("atlas-tool-call");
  });

  test("surfaces SDK success envelopes marked as errors", async () => {
    const sdk: ClaudeAgentSdk = {
      query: () =>
        queryHandle([
          {
            errors: ["plan limit reached", "try again later"],
            is_error: true,
            result: "request failed",
            session_id: "claude-session",
            subtype: "success",
            type: "result",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        ]),
    };
    const runtime = new AuthenticatedClaudeRuntime({ sdk });

    await withTemporaryConfig(async () => {
      await expect(
        runtime.generateChat({
          messages: [{ content: "Hello", role: "user" }],
          system: "You are Atlas.",
        })
      ).rejects.toThrow(
        "Claude subscription limit reached. Atlas will not fall back to an API key."
      );
    });
  });

  test("does not start a query when the request is already cancelled", async () => {
    let queryCount = 0;
    const sdk: ClaudeAgentSdk = {
      query: () => {
        queryCount += 1;
        return queryHandle([]);
      },
    };
    const runtime = new AuthenticatedClaudeRuntime({ sdk });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runtime.generateChat({
        messages: [{ content: "Hello", role: "user" }],
        signal: controller.signal,
        system: "You are Atlas.",
      })
    ).rejects.toThrow("Claude turn cancelled.");
    expect(queryCount).toBe(0);
  });

  test("does not start a query when cancellation arrives during auth", async () => {
    let queryCount = 0;
    const sdk: ClaudeAgentSdk = {
      query: () => {
        queryCount += 1;
        return queryHandle([]);
      },
    };
    const runtime = new DelayedAuthClaudeRuntime({ sdk });
    const controller = new AbortController();
    await withTemporaryConfig(async () => {
      const result = runtime.generateChat({
        messages: [{ content: "Hello", role: "user" }],
        signal: controller.signal,
        system: "You are Atlas.",
      });

      controller.abort();
      runtime.releaseAuth();

      await expect(result).rejects.toThrow("Claude turn cancelled.");
    });
    expect(queryCount).toBe(0);
  });

  test("drains an active one-shot before logout and blocks new work", async () => {
    const events: string[] = [];
    let markTurnStarted: () => void = () => undefined;
    let releaseTurn: () => void = () => undefined;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    const turnRelease = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const sdk: ClaudeAgentSdk = {
      query: () => ({
        async *[Symbol.asyncIterator]() {
          events.push("turn:start");
          markTurnStarted();
          await turnRelease;
          events.push("turn:end");
          yield {
            is_error: false,
            result: "Completed response",
            session_id: "one-shot-session",
            subtype: "success",
            type: "result",
          };
        },
      }),
    };
    const runtime = new ControlledLogoutClaudeRuntime(sdk, events);
    setClaudeRuntimeForTests(runtime);
    const provider = createClaudeProvider({ model: "claude-sonnet-4-6" });

    try {
      await withTemporaryConfig(async () => {
        const activeTurn = provider.generateText({
          prompt: "First",
          system: "You are Atlas.",
        });
        await turnStarted;
        let logoutSettled = false;
        const logout = runtime.logout().then((result) => {
          logoutSettled = true;
          return result;
        });

        try {
          await Bun.sleep(0);
          expect(logoutSettled).toBe(false);
          await expect(
            provider.generateText({
              prompt: "Blocked provider call",
              system: "You are Atlas.",
            })
          ).rejects.toThrow("provider is currently being cleared");
          await expect(
            runtime.generateChat({
              messages: [{ content: "Blocked runtime call", role: "user" }],
              system: "You are Atlas.",
            })
          ).rejects.toThrow("provider is currently being cleared");

          releaseTurn();
          await activeTurn;
          await logout;

          expect(logoutSettled).toBe(true);
          expect(events).toEqual(["turn:start", "turn:end", "logout"]);
        } finally {
          releaseTurn();
          await Promise.allSettled([activeTurn, logout]);
        }
      });
    } finally {
      setClaudeRuntimeForTests(null);
    }
  });

  test("does not evict an active login when the status cache is full", async () => {
    const runtime = new UnauthenticatedClaudeRuntime({
      sdk: { query: () => queryHandle([]) },
    });
    const started = await runtime.startLogin();
    const pendingLogins = (
      runtime as unknown as { pendingLogins: Map<string, unknown> }
    ).pendingLogins;
    for (let index = 0; index < 127; index += 1) {
      const loginId = `completed-${index}`;
      pendingLogins.set(loginId, {
        expiresAt: Date.now() + 60_000,
        loginId,
        status: { loginId, status: "completed" },
      });
    }

    await expect(runtime.startLogin()).rejects.toThrow(
      "A Claude login is already in progress."
    );
    expect(pendingLogins.has(started.loginId)).toBe(true);
  });

  test("times out and interrupts a query that ignores cancellation", async () => {
    let interrupted = false;
    const sdk: ClaudeAgentSdk = {
      query: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<unknown>>(() => undefined),
          };
        },
        interrupt: async () => {
          interrupted = true;
        },
      }),
    };
    const runtime = new AuthenticatedClaudeRuntime({
      sdk,
      turnTimeoutMs: 5,
    });

    await withTemporaryConfig(async () => {
      await expect(
        runtime.generateChat({
          messages: [{ content: "Hello", role: "user" }],
          system: "You are Atlas.",
        })
      ).rejects.toThrow("Claude turn timed out.");
    });
    expect(interrupted).toBe(true);
  });

  test("fails closed when Claude auth output is empty or explicitly false", () => {
    expect(
      parseClaudeAuthStatusOutput({ exitCode: 0, stderr: "", stdout: "" })
    ).toEqual({ authenticated: false, message: undefined });
    expect(
      parseClaudeAuthStatusOutput({
        exitCode: 0,
        stderr: "",
        stdout: "authenticated: false",
      })
    ).toEqual({
      authenticated: false,
      message: "authenticated: false",
    });
    expect(
      parseClaudeAuthStatusOutput({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          authMethod: "oauth",
          email: "user@example.com",
          loggedIn: true,
        }),
      })
    ).toMatchObject({
      authenticated: true,
      email: "user@example.com",
    });
  });

  test("fails closed when the native logout command does not succeed", () => {
    expect(() =>
      assertClaudeLogoutCommandSucceeded({ exitCode: null })
    ).toThrow("Claude logout failed");
    expect(() => assertClaudeLogoutCommandSucceeded({ exitCode: 1 })).toThrow(
      "Claude logout failed"
    );
    expect(() =>
      assertClaudeLogoutCommandSucceeded({ exitCode: 0 })
    ).not.toThrow();
  });

  test("deletes a stale native session before starting fresh", async () => {
    const deletedSessions: string[] = [];
    const sdk: ClaudeAgentSdk = {
      deleteSession: async (sessionId) => {
        deletedSessions.push(sessionId);
      },
      query: () =>
        queryHandle([
          {
            is_error: false,
            result: "Fresh response",
            session_id: "session-fresh",
            subtype: "success",
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ]),
    };
    const runtime = new AuthenticatedClaudeRuntime({ sdk });

    await withTemporaryConfig(async () => {
      await writeSubscriptionSession("claude", "conversation-stale", {
        historyFingerprint: "stale-history",
        lastMessageCount: 2,
        runtimeSessionId: "session-stale",
      });
      await withSubscriptionSessionLease(
        "claude",
        "conversation-stale",
        () =>
          runtime.generateChat({
            conversationId: "conversation-stale",
            messages: [{ content: "Fresh prompt", role: "user" }],
            system: "You are Atlas.",
          }),
        (candidate) =>
          sdk.deleteSession?.(candidate.runtimeSessionId) ?? Promise.resolve()
      );
    });

    expect(deletedSessions).toEqual(["session-stale"]);
  });

  test("deletes a discovered native session when its query fails", async () => {
    const deletedSessions: string[] = [];
    const sdk: ClaudeAgentSdk = {
      deleteSession: async (sessionId) => {
        deletedSessions.push(sessionId);
      },
      query: () =>
        queryHandle([
          {
            message: { content: [], model: "claude-sonnet-4-6" },
            session_id: "session-failed",
            type: "assistant",
          },
          {
            errors: ["runtime failed"],
            is_error: true,
            result: "runtime failed",
            session_id: "session-failed",
            subtype: "error",
            type: "result",
          },
        ]),
    };
    const runtime = new AuthenticatedClaudeRuntime({ sdk });

    await withTemporaryConfig(async () => {
      await expect(
        runtime.generateChat({
          conversationId: "conversation-failed",
          messages: [{ content: "Hello", role: "user" }],
          system: "You are Atlas.",
        })
      ).rejects.toThrow("runtime failed");
    });

    expect(deletedSessions).toEqual(["session-failed"]);
  });

  test("fails closed when the SDK cannot delete native sessions", async () => {
    const runtime = new AuthenticatedClaudeRuntime({
      sdk: { query: () => queryHandle([]) },
    });

    await expect(
      runtime.deleteConversationSession("session-undeletable")
    ).rejects.toThrow("session deletion is unavailable");
  });

  test("fails and retains cleanup when persistence and native deletion fail", async () => {
    const directory = await mkdtemp("/tmp/atlas-claude-persist-");
    const sessionStorePath = join(directory, "subscription-sessions.json");
    const sdk: ClaudeAgentSdk = {
      deleteSession: async () => {
        await writeFile(
          sessionStorePath,
          JSON.stringify({ sessions: {} }),
          "utf8"
        );
        throw new Error("native session cleanup failed");
      },
      query: () => ({
        async *[Symbol.asyncIterator]() {
          await writeFile(sessionStorePath, '{"sessions":', "utf8");
          yield {
            is_error: false,
            result: "Completed response",
            session_id: "session-persist-failure",
            subtype: "success",
            type: "result",
          };
        },
      }),
    };
    const runtime = new AuthenticatedClaudeRuntime({ sdk });

    try {
      await runWithUserConfigDir(directory, async () => {
        await expect(
          runtime.generateChat({
            conversationId: "conversation-persist-failure",
            messages: [{ content: "Hello", role: "user" }],
            system: "You are Atlas.",
          })
        ).rejects.toMatchObject({
          code: "runtime_error",
          message: expect.stringContaining("could not persist or delete"),
        });

        expect(
          await listSubscriptionSessionDeletionCandidates(
            "conversation-persist-failure"
          )
        ).toEqual([
          expect.objectContaining({
            kind: "claude",
            runtimeSessionId: "session-persist-failure",
          }),
        ]);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
