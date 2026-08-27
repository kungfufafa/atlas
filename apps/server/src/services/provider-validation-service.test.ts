import { afterEach, describe, expect, mock, test } from "bun:test";
import { AtlasApiError } from "@atlas/core/api-error";
import { setChatgptRuntimeForTests } from "../providers/subscription";
import type { ChatgptSubscriptionRuntime } from "../providers/subscription/chatgpt/runtime";
import { validateProviderConnection } from "./provider-validation-service";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setChatgptRuntimeForTests(null);
});

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

describe("validateProviderConnection", () => {
  test("rejects API keys on subscription validation without inspecting auth", async () => {
    let inspectedAuth = false;
    setChatgptRuntimeForTests({
      getAuthState: async () => {
        inspectedAuth = true;
        return {
          authenticated: true,
          provider: "chatgpt",
          status: "authenticated",
        };
      },
    } as unknown as ChatgptSubscriptionRuntime);

    try {
      await validateProviderConnection({
        apiKey: "sk-must-not-be-used",
        type: "chatgpt",
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      expect((error as AtlasApiError).status).toBe(400);
    }
    expect(inspectedAuth).toBe(false);
  });

  test("validates a selected subscription model against runtime models", async () => {
    let listModelsCalls = 0;
    setChatgptRuntimeForTests({
      getAuthState: async () => ({
        authenticated: true,
        provider: "chatgpt",
        status: "authenticated",
      }),
      listModels: async () => {
        listModelsCalls += 1;
        return [
          {
            id: "gpt-5-codex",
            name: "GPT-5 Codex",
            provider: "chatgpt",
          },
        ];
      },
    } as unknown as ChatgptSubscriptionRuntime);

    const models = await validateProviderConnection({
      apiKey: "   ",
      model: " gpt-5-codex ",
      type: "chatgpt",
    });

    expect(listModelsCalls).toBe(1);
    expect(models).toEqual([
      {
        default: true,
        id: "gpt-5-codex",
        name: "GPT-5 Codex",
      },
    ]);
  });

  test("normalizes runtime model metadata to one server-owned default", async () => {
    setChatgptRuntimeForTests({
      getAuthState: async () => ({
        authenticated: true,
        provider: "chatgpt",
        status: "authenticated",
      }),
      listModels: async () => [
        {
          default: true,
          id: "gpt-new",
          name: "GPT New",
          provider: "chatgpt",
          reasoningEffortValues: ["low", "high"],
        },
        {
          default: true,
          id: "gpt-other",
          name: "GPT Other",
          provider: "chatgpt",
        },
      ],
    } as unknown as ChatgptSubscriptionRuntime);

    await expect(
      validateProviderConnection({ model: "gpt-other", type: "chatgpt" })
    ).resolves.toEqual([
      {
        id: "gpt-new",
        name: "GPT New",
        reasoningEffortValues: ["low", "high"],
      },
      { default: true, id: "gpt-other", name: "GPT Other" },
    ]);
  });

  test("rejects an unavailable subscription model", async () => {
    setChatgptRuntimeForTests({
      getAuthState: async () => ({
        authenticated: true,
        provider: "chatgpt",
        status: "authenticated",
      }),
      listModels: async () => [
        {
          id: "gpt-5-codex",
          name: "GPT-5 Codex",
          provider: "chatgpt",
        },
      ],
    } as unknown as ChatgptSubscriptionRuntime);

    try {
      await validateProviderConnection({
        model: "retired-model",
        type: "chatgpt",
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      expect((error as AtlasApiError).status).toBe(400);
      expect((error as AtlasApiError).message).toContain("not available");
    }
  });

  test("maps unavailable and disconnected subscription runtimes", async () => {
    const states = [
      {
        authenticated: false,
        expectedStatus: 503,
        provider: "chatgpt" as const,
        status: "not_installed" as const,
      },
      {
        authenticated: false,
        expectedStatus: 409,
        provider: "chatgpt" as const,
        status: "not_authenticated" as const,
      },
    ];

    for (const { expectedStatus, ...state } of states) {
      setChatgptRuntimeForTests({
        getAuthState: async () => state,
      } as unknown as ChatgptSubscriptionRuntime);

      try {
        await validateProviderConnection({ type: "chatgpt" });
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(AtlasApiError);
        expect((error as AtlasApiError).status).toBe(expectedStatus);
      }
    }
  });

  test("throws error when API key is missing for key-required providers", async () => {
    await expect(
      validateProviderConnection({
        apiKey: "   ",
        type: "gemini",
      })
    ).rejects.toThrow("API key is required.");
  });

  test("throws error when API key is missing for Ollama Cloud mode", async () => {
    await expect(
      validateProviderConnection({
        apiKey: "",
        hostMode: "cloud",
        type: "ollama",
      })
    ).rejects.toThrow("API key is required for Ollama Cloud mode.");
  });

  test("discovers openai-compatible models then probes chat", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [
              {
                id: "qwen/qwen3.8-max-free",
                object: "model",
                owned_by: "custom",
                supported_endpoint_types: ["openai"],
                tags: "Text",
              },
            ],
            object: "list",
            success: true,
          });
        }

        if (url.pathname === "/v1/chat/completions") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            model?: string;
          };
          expect(body.model).toBe("qwen/qwen3.8-max-free");
          return Response.json({
            choices: [
              {
                message: { content: "ok", role: "assistant" },
              },
            ],
            id: "chatcmpl-probe",
            object: "chat.completion",
          });
        }

        return new Response("not found", { status: 404 });
      }
    ) as unknown as typeof fetch;

    await validateProviderConnection({
      apiKey: "sk-test",
      baseUrl: "http://localhost:1234/v1",
      type: "openai_compatible",
    });
  });

  test("retries a later discovered model when the first has no quota", async () => {
    const probed: string[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [
              { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" },
              { id: "qwen/qwen3.8-max-free" },
            ],
            object: "list",
          });
        }

        if (url.pathname === "/v1/chat/completions") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            model?: string;
          };
          probed.push(body.model ?? "");
          if (body.model?.includes("nemotron")) {
            return Response.json(
              {
                error: {
                  message: "User's credit limit is insufficient",
                  type: "api_error",
                },
              },
              { status: 403 }
            );
          }

          return Response.json({
            choices: [{ message: { content: "ok", role: "assistant" } }],
            id: "chatcmpl-probe",
            object: "chat.completion",
          });
        }

        return new Response("not found", { status: 404 });
      }
    ) as unknown as typeof fetch;

    await validateProviderConnection({
      apiKey: "sk-test",
      baseUrl: "http://localhost:1234/v1",
      type: "openai_compatible",
    });

    expect(probed).toContain("qwen/qwen3.8-max-free");
  });

  test("validates provider API key failure gracefully", async () => {
    globalThis.fetch = mock(
      async () => new Response("invalid credential", { status: 401 })
    ) as unknown as typeof fetch;

    await expect(
      validateProviderConnection({
        apiKey: "invalid-key-12345",
        type: "openai",
      })
    ).rejects.toThrow(/API key or connection validation failed/);
  });
});
