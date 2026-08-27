import { describe, expect, spyOn, test } from "bun:test";
import { PROVIDER_CAPABILITY_IDS } from "@atlas/core";
import {
  compatibleModelSupportsThinking,
  fetchRemoteOpenAIModels,
  getModelsForProviderInstance,
  mergeOpenRouterCatalog,
} from "./compatible-models";

const resolvePublicDns = async () => [
  { address: "8.8.8.8", family: 4 as const },
];

describe("mergeOpenRouterCatalog", () => {
  test("merges custom display names over static entries", () => {
    const staticModels = [
      {
        contextWindow: 200_000,
        id: "anthropic/claude-sonnet-4-6",
        maxOutputTokens: 8192,
        name: "Claude Sonnet 4.6",
        provider: "openrouter" as const,
      },
      {
        contextWindow: 128_000,
        id: "openai/gpt-5.4",
        maxOutputTokens: 8192,
        name: "GPT-5.4",
        provider: "openrouter" as const,
      },
    ];
    const merged = mergeOpenRouterCatalog(staticModels, [
      { id: "anthropic/claude-sonnet-4-6", name: "My Sonnet" },
      { id: "google/gemini-2.5-pro-preview", name: "Gemini Pro" },
    ]);

    expect(
      merged.find((model) => model.id === "anthropic/claude-sonnet-4-6")?.name
    ).toBe("My Sonnet");
    expect(merged.some((model) => model.id === "openai/gpt-5.4")).toBe(true);
    expect(
      merged.some((model) => model.id === "google/gemini-2.5-pro-preview")
    ).toBe(true);
  });
});

describe("getModelsForProviderInstance openai", () => {
  test("uses shortlist when custom models are saved", () => {
    const models = getModelsForProviderInstance({
      apiKey: "sk-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      customModels: [{ default: true, id: "gpt-5.4", name: "GPT 5.4" }],
      id: "openai-1",
      label: "OpenAI",
      type: "openai",
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("gpt-5.4");
    expect(models[0]?.providerId).toBe("openai-1");
  });

  test("returns full catalog when no shortlist is saved", () => {
    const models = getModelsForProviderInstance({
      apiKey: "sk-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      id: "openai-1",
      label: "OpenAI",
      type: "openai",
    });

    expect(models.length).toBeGreaterThan(1);
    expect(models.some((model) => model.id === "gpt-5.4")).toBe(true);
  });
});

describe("getModelsForProviderInstance opencode_go", () => {
  test("uses shortlist when custom models are saved", () => {
    const models = getModelsForProviderInstance({
      apiKey: "oc-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      customModels: [
        { default: true, id: "opencode-go/kimi-k2.7-code", name: "Kimi Code" },
      ],
      id: "oc-1",
      label: "OpenCode Go",
      type: "opencode_go",
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("opencode-go/kimi-k2.7-code");
    expect(models[0]?.providerId).toBe("oc-1");
  });

  test("returns full catalog when no shortlist is saved", () => {
    const models = getModelsForProviderInstance({
      apiKey: "oc-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      id: "oc-1",
      label: "OpenCode Go",
      type: "opencode_go",
    });

    expect(models.length).toBeGreaterThan(1);
    expect(
      models.some((model) => model.id === "opencode-go/kimi-k2.7-code")
    ).toBe(true);
  });
});

describe("getModelsForProviderInstance openrouter", () => {
  test("uses shortlist only when custom models are saved", () => {
    const models = getModelsForProviderInstance({
      apiKey: "sk-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      customModels: [
        { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama Free" },
      ],
      id: "or-1",
      label: "OpenRouter",
      type: "openrouter",
    });

    expect(
      models.some(
        (model) => model.id === "meta-llama/llama-3.3-70b-instruct:free"
      )
    ).toBe(true);
    expect(models.some((model) => model.id === "openai/gpt-5.4")).toBe(false);
    expect(models[0]?.providerId).toBe("or-1");
    expect(models[0]?.supportsThinking).toBe(false);
  });

  test("maps supportsThinking for reasoning-capable OpenRouter models", () => {
    const models = getModelsForProviderInstance({
      apiKey: "sk-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      customModels: [
        { default: true, id: "anthropic/claude-sonnet-4-6", name: "Sonnet" },
      ],
      id: "or-1",
      label: "OpenRouter",
      type: "openrouter",
    });

    expect(models[0]?.supportsThinking).toBe(true);
  });

  test("honors explicit supportsThinking overrides", () => {
    const models = getModelsForProviderInstance({
      apiKey: "sk-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      customModels: [
        { id: "some-vendor/some-model", supportsThinking: true },
        { id: "anthropic/claude-sonnet-4-6", supportsThinking: false },
      ],
      id: "or-1",
      label: "OpenRouter",
      type: "openrouter",
    });

    expect(
      models.find((model) => model.id === "some-vendor/some-model")
        ?.supportsThinking
    ).toBe(true);
    expect(
      models.find((model) => model.id === "anthropic/claude-sonnet-4-6")
        ?.supportsThinking
    ).toBe(false);
  });

  test("includes only the active model when no shortlist is saved", () => {
    const models = getModelsForProviderInstance(
      {
        apiKey: "sk-test",
        createdAt: "2026-06-07T10:00:00.000Z",
        id: "or-1",
        label: "OpenRouter",
        type: "openrouter",
      },
      "google/gemma-4-31b-it:free"
    );

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("google/gemma-4-31b-it:free");
    expect(models[0]?.supportsThinking).toBe(false);
    expect(models.some((model) => model.id === "openai/gpt-5.4")).toBe(false);
  });
});

describe("getModelsForProviderInstance cerebras", () => {
  test("uses shortlist only when custom models are saved", () => {
    const models = getModelsForProviderInstance({
      apiKey: "csk-test",
      createdAt: "2026-07-16T10:00:00.000Z",
      customModels: [
        { id: "gpt-oss-120b", name: "GPT OSS 120B", supportsThinking: true },
      ],
      id: "cb-1",
      label: "Cerebras",
      type: "cerebras",
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("gpt-oss-120b");
    expect(models[0]?.supportsThinking).toBe(true);
    expect(models[0]?.providerId).toBe("cb-1");
    expect(models.some((model) => model.id === "gemma-4-31b")).toBe(false);
  });

  test("falls back to static catalog when no shortlist is saved", () => {
    const models = getModelsForProviderInstance({
      apiKey: "csk-test",
      createdAt: "2026-07-16T10:00:00.000Z",
      id: "cb-1",
      label: "Cerebras",
      type: "cerebras",
    });

    expect(models.some((model) => model.id === "gpt-oss-120b")).toBe(true);
    expect(models.some((model) => model.id === "gemma-4-31b")).toBe(true);
  });
});

describe("getModelsForProviderInstance fireworks", () => {
  test("uses shortlist only when custom models are saved", () => {
    const models = getModelsForProviderInstance({
      apiKey: "fw-test",
      createdAt: "2026-07-24T10:00:00.000Z",
      customModels: [
        {
          id: "accounts/fireworks/models/kimi-k2p6",
          name: "Kimi K2.6",
          supportsThinking: true,
        },
      ],
      id: "fw-1",
      label: "Fireworks",
      type: "fireworks",
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("accounts/fireworks/models/kimi-k2p6");
    expect(models[0]?.supportsThinking).toBe(true);
    expect(
      models.some((model) => model.id === "accounts/fireworks/models/glm-5p2")
    ).toBe(false);
  });

  test("falls back to static catalog when no shortlist is saved", () => {
    const models = getModelsForProviderInstance({
      apiKey: "fw-test",
      createdAt: "2026-07-24T10:00:00.000Z",
      id: "fw-1",
      label: "Fireworks",
      type: "fireworks",
    });

    expect(
      models.some((model) => model.id === "accounts/fireworks/models/kimi-k2p6")
    ).toBe(true);
    expect(
      models.some((model) => model.id === "accounts/fireworks/models/glm-5p2")
    ).toBe(true);
  });
});

describe("getModelsForProviderInstance openai_compatible", () => {
  test("infers reasoning for known families when the flag is unset", () => {
    const models = getModelsForProviderInstance({
      apiKey: "",
      baseUrl: "https://api.tokenrouter.com/v1",
      createdAt: "2026-06-07T10:00:00.000Z",
      customModels: [{ default: true, id: "qwen/qwen3.8-max-free" }],
      id: "compat-1",
      label: "sada",
      type: "openai_compatible",
    });

    expect(models[0]?.supportsThinking).toBe(true);
    expect(models[0]?.reasoningEffortValues).toEqual([
      "low",
      "medium",
      "xhigh",
    ]);
  });

  test("maps supportsThinking from custom models into the catalog", () => {
    const models = getModelsForProviderInstance({
      apiKey: "",
      baseUrl: "https://api.example.com/v1",
      createdAt: "2026-06-07T10:00:00.000Z",
      customModels: [
        {
          default: true,
          id: "qwen3.6-35b",
          name: "Qwen 3.6 35B",
          supportsThinking: true,
        },
      ],
      id: "compat-1",
      label: "NetraRuntime",
      type: "openai_compatible",
    });

    expect(models[0]?.supportsThinking).toBe(true);
    expect(models[0]?.providerId).toBe("compat-1");
  });
});

describe("fetchRemoteOpenAIModels TokenRouter payload", () => {
  test("parses the gateway list that only includes ids", async () => {
    const models = await fetchRemoteOpenAIModels(
      "https://models.example/v1",
      "sk-test",
      {
        fetch: async () =>
          Response.json({
            data: [
              {
                created: 1_786_810_001,
                id: "qwen/qwen3.8-max-free",
                object: "model",
                owned_by: "custom",
                supported_endpoint_types: ["openai"],
                tags: "Text",
              },
              {
                created: 1_777_427_216,
                id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
                object: "model",
                owned_by: "custom",
                supported_endpoint_types: ["openai"],
                tags: "Text",
              },
            ],
            object: "list",
            success: true,
          }),
        resolveDns: resolvePublicDns,
      }
    );

    expect(models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "qwen/qwen3.8-max-free",
    ]);
    expect(
      models.find((model) => model.id === "qwen/qwen3.8-max-free")
    ).toMatchObject({
      supportsThinking: true,
    });
  });
});

describe("compatibleModelSupportsThinking", () => {
  test("honors an explicit opt-out and infers known reasoning families", () => {
    expect(
      compatibleModelSupportsThinking("qwen3.6-35b", [
        { id: "qwen3.6-35b", supportsThinking: true },
        { id: "qwen3.6-7b", supportsThinking: false },
      ])
    ).toBe(true);

    expect(
      compatibleModelSupportsThinking("qwen3.6-7b", [
        { id: "qwen3.6-35b", supportsThinking: true },
        { id: "qwen3.6-7b", supportsThinking: false },
      ])
    ).toBe(false);

    expect(
      compatibleModelSupportsThinking("qwen/qwen3.8-max-free", [
        { id: "qwen/qwen3.8-max-free" },
      ])
    ).toBe(true);
  });
});

describe("fetchRemoteOpenAIModels capabilities", () => {
  test("keeps reasoning fields advertised by the endpoint", async () => {
    const models = await fetchRemoteOpenAIModels(
      "https://models.example/v1",
      "sk-test",
      {
        fetch: async () =>
          Response.json({
            data: [
              {
                id: "qwen/qwen3.8-max-free",
                name: "Qwen 3.8 Max Free",
                supported_parameters: ["reasoning", "reasoning_effort"],
                supported_params_details: {
                  reasoning_effort: {
                    accepted_values: ["low", "medium", "xhigh"],
                  },
                },
              },
              { id: "meta-llama/llama-3.3-70b" },
            ],
          }),
        resolveDns: resolvePublicDns,
      }
    );

    expect(models).toEqual([
      {
        id: "meta-llama/llama-3.3-70b",
        name: "meta-llama/llama-3.3-70b",
      },
      {
        capabilities: {
          [PROVIDER_CAPABILITY_IDS.chatReasoning]: {
            source: "provider-discovery",
            status: "supported",
            verified: true,
          },
        },
        id: "qwen/qwen3.8-max-free",
        name: "Qwen 3.8 Max Free",
        reasoningEffortValues: ["low", "medium", "xhigh"],
        supportsThinking: true,
      },
    ]);
  });
});

describe("fetchRemoteOpenAIModels auth errors", () => {
  for (const status of [401, 403] as const) {
    test(`names the API key remedy for ${status} without upstream body`, async () => {
      const upstreamBody = JSON.stringify({
        error: "API key required for remote API access",
      });
      const warn = spyOn(console, "warn").mockImplementation(() => {});

      const baseUrl = "https://models.example/v1";

      try {
        await fetchRemoteOpenAIModels(baseUrl, "", {
          fetch: async () =>
            new Response(upstreamBody, {
              headers: { "content-type": "application/json" },
              status,
            }),
          resolveDns: resolvePublicDns,
        });
        expect.unreachable("expected discovery to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain("API key");
        expect(message).not.toContain(upstreamBody);
        expect(message).not.toContain("API key required for remote API access");
      }

      const warning = warn.mock.calls.flat().join(" ");
      expect(warning).toContain("Could not fetch models");
      expect(warning).not.toContain(upstreamBody);
      expect(warning).not.toContain("API key required for remote API access");

      warn.mockRestore();
    });
  }
});

describe("fetchRemoteOpenAIModels request budget", () => {
  test("does not fall back when endpoint safety validation fails", async () => {
    let dnsCalls = 0;
    let fetchCalls = 0;

    await expect(
      fetchRemoteOpenAIModels("https://models.example/v1", "test-key", {
        fetch: async () => {
          fetchCalls += 1;
          return Response.json({ data: [] });
        },
        resolveDns: async () => {
          dnsCalls += 1;
          return [{ address: "127.0.0.1", family: 4 }];
        },
      })
    ).rejects.toMatchObject({ code: "blocked-address" });

    expect(dnsCalls).toBe(1);
    expect(fetchCalls).toBe(0);
  });

  test("applies the shared deadline while resolving DNS", async () => {
    let fetchCalls = 0;
    const neverResolves = new Promise<never>(() => undefined);

    const request = fetchRemoteOpenAIModels(
      "https://models.example/v1",
      "test-key",
      {
        fetch: async () => {
          fetchCalls += 1;
          return Response.json({ data: [] });
        },
        resolveDns: () => neverResolves,
        timeoutMs: 0,
      }
    );

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchCalls).toBe(0);
  });

  test("shares one bounded signal across raw and SDK fallback", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const idleTimeouts: Array<number | undefined> = [];
    let calls = 0;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const models = await fetchRemoteOpenAIModels(
      "https://models.example/v1",
      "test-key",
      {
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          calls += 1;
          signals.push(init?.signal);
          idleTimeouts.push(
            (init as RequestInit & { idleTimeout?: number })?.idleTimeout
          );
          if (calls === 1) {
            return new Response("raw unsupported", { status: 404 });
          }
          return Response.json({
            data: [{ id: "sdk-model" }],
            object: "list",
          });
        }) as typeof fetch,
        resolveDns: resolvePublicDns,
      }
    );

    expect(models.map((model) => model.id)).toEqual(["sdk-model"]);
    expect(calls).toBe(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
    expect(idleTimeouts).toEqual([0, 0]);
    warn.mockRestore();
  });

  test("disables SDK retries after the raw request fails", async () => {
    let calls = 0;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const request = fetchRemoteOpenAIModels(
      "https://models.example/v1",
      "test-key",
      {
        fetch: (async () => {
          calls += 1;
          return new Response("unavailable", { status: 500 });
        }) as typeof fetch,
        resolveDns: resolvePublicDns,
      }
    );

    await expect(request).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(2);
    warn.mockRestore();
  });

  test("rethrows caller aborts without falling back", async () => {
    const caller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    caller.abort(reason);
    let calls = 0;

    try {
      await fetchRemoteOpenAIModels("https://models.example/v1", "test-key", {
        fetch: (async () => {
          calls += 1;
          throw reason;
        }) as typeof fetch,
        resolveDns: resolvePublicDns,
        signal: caller.signal,
      });
      expect.unreachable("expected caller abort");
    } catch (error) {
      expect(error).toBe(reason);
    }
    expect(calls).toBe(0);
  });

  test("rethrows the shared deadline without falling back", async () => {
    let calls = 0;
    const request = fetchRemoteOpenAIModels(
      "https://models.example/v1",
      "test-key",
      {
        fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
          calls += 1;
          const signal = init?.signal;
          if (signal?.aborted) {
            return Promise.reject(signal.reason);
          }
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        }) as typeof fetch,
        resolveDns: resolvePublicDns,
        timeoutMs: 0,
      }
    );

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(1);
  });
});
