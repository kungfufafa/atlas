import { describe, expect, test } from "bun:test";
import type { ProviderName } from "@atlas/core";
import { fetchAnthropicModels, fetchGeminiModels } from "../native-models";
import {
  createCerebrasModelDiscovery,
  createNativeModelDiscovery,
  createOpenAICompatibleModelDiscovery,
} from "./model-discovery";
import type { ProviderModelDiscoveryContext } from "./registry";

const PUBLIC_DNS = async () => [{ address: "8.8.8.8", family: 4 as const }];

function discoveryContext(
  type: ProviderName,
  baseUrl?: string
): ProviderModelDiscoveryContext {
  return {
    apiKey: "test-provider-key",
    baseUrl,
    configured: true,
    instance: {
      createdAt: "2026-09-06T00:00:00.000Z",
      id: "provider-1",
      label: "Configured provider",
      type,
    },
  };
}

describe("provider discovery metadata scope", () => {
  test.each([
    { baseUrl: "https://api.openai.com/v1", contextWindow: 1_050_000 },
    { baseUrl: "https://proxy.example/v1", contextWindow: undefined },
  ])(
    "scopes documented OpenAI metadata to $baseUrl",
    async ({ baseUrl, contextWindow }) => {
      const discover = createOpenAICompatibleModelDiscovery({
        fetch: async () => Response.json({ data: [{ id: "gpt-5.4" }] }),
        resolveDns: PUBLIC_DNS,
      });
      const result = await discover(discoveryContext("openai", baseUrl));

      expect(result.baseUrl).toBe(baseUrl);
      expect(result.models[0]?.contextWindow).toBe(contextWindow);
      expect(result.customModels).toEqual([{ id: "gpt-5.4", name: "gpt-5.4" }]);
      expect(result.models[0]?.providerId).toBe("provider-1");
    }
  );

  test("preserves advertised proxy metadata for persistence", async () => {
    const discover = createOpenAICompatibleModelDiscovery({
      fetch: async () =>
        Response.json({
          data: [
            {
              context_length: 32_768,
              id: "gpt-5.4",
              reasoningEffortValues: [],
              supports_reasoning: false,
            },
          ],
        }),
      resolveDns: PUBLIC_DNS,
    });
    const result = await discover(
      discoveryContext("openai", "https://proxy.example/v1")
    );

    expect(result.customModels?.[0]).toMatchObject({
      contextWindow: 32_768,
      reasoningEffortValues: [],
      supportsThinking: false,
    });
    expect(result.models[0]).toMatchObject({
      contextWindow: 32_768,
      reasoningEffortValues: [],
      supportsThinking: false,
    });
    expect(result.models[0]?.maxOutputTokens).toBeUndefined();
  });

  test.each([
    {
      baseUrl: "https://api.anthropic.com",
      endpoint: "https://api.anthropic.com/v1/models",
      fetchModels: fetchAnthropicModels,
      payload: {
        data: [
          {
            capabilities: { thinking: { supported: false } },
            id: "claude-custom",
            max_input_tokens: 200_000,
            max_tokens: 8192,
          },
        ],
        has_more: false,
      },
      type: "anthropic" as const,
    },
    {
      baseUrl: "https://generativelanguage.googleapis.com",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
      fetchModels: fetchGeminiModels,
      payload: {
        models: [
          {
            inputTokenLimit: 200_000,
            name: "models/gemini-custom",
            outputTokenLimit: 8192,
            supportedGenerationMethods: ["generateContent"],
            thinking: false,
          },
        ],
      },
      type: "gemini" as const,
    },
  ])(
    "returns native $type limits and capabilities in the saved model shape",
    async ({ baseUrl, endpoint, type, fetchModels, payload }) => {
      const requests: Array<{ url: string; headers: Headers }> = [];
      const discover = createNativeModelDiscovery({
        baseUrl,
        fetch: async (input, init) => {
          requests.push({
            headers: new Headers(init?.headers),
            url: String(input),
          });
          return Response.json(payload);
        },
        fetchModels,
        resolveDns: PUBLIC_DNS,
      });
      const result = await discover(discoveryContext(type));

      expect(requests[0]?.url).toBe(endpoint);
      expect(
        requests[0]?.headers.get(
          type === "anthropic" ? "x-api-key" : "x-goog-api-key"
        )
      ).toBe("test-provider-key");
      expect(result.baseUrl).toBe(baseUrl);
      expect(result.customModels?.[0]).toMatchObject({
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsThinking: false,
      });
      expect(result.models[0]).toMatchObject({
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        providerId: "provider-1",
        supportsThinking: false,
      });
    }
  );

  test("uses explicitly selected native endpoints instead of saved ones", async () => {
    let requestedUrl = "";
    const discover = createNativeModelDiscovery({
      baseUrl: "https://api.anthropic.com",
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json({ data: [{ id: "custom" }], has_more: false });
      },
      fetchModels: fetchAnthropicModels,
      resolveDns: PUBLIC_DNS,
    });
    const context = discoveryContext(
      "anthropic",
      "https://selected.example/proxy"
    );
    context.instance.baseUrl = "https://saved.example";
    const result = await discover(context);

    expect(requestedUrl).toBe("https://selected.example/proxy/v1/models");
    expect(result.models[0]?.contextWindow).toBeUndefined();
  });
});

describe("Cerebras discovery", () => {
  test("enriches only account-visible exact IDs and keeps account metadata authoritative", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const discover = createCerebrasModelDiscovery({
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({
          authorization: new Headers(init?.headers).get("Authorization"),
          url,
        });
        return url.includes("/public/")
          ? Response.json({
              data: [
                {
                  capabilities: { reasoning: true, tools: true },
                  id: "visible",
                  limits: {
                    max_completion_tokens: 8192,
                    max_context_length: 131_072,
                  },
                },
                { id: "private", limits: { max_context_length: 999_999 } },
              ],
            })
          : Response.json({
              data: [
                {
                  context_length: 32_768,
                  id: "visible",
                  supportsThinking: false,
                },
                { id: "unknown" },
              ],
            });
      },
      resolveDns: PUBLIC_DNS,
    });
    const result = await discover(discoveryContext("cerebras"));

    expect(requests).toEqual([
      {
        authorization: "Bearer test-provider-key",
        url: "https://api.cerebras.ai/v1/models",
      },
      { authorization: null, url: "https://api.cerebras.ai/public/v1/models" },
    ]);
    expect(result.customModels?.map((model) => model.id)).toEqual([
      "unknown",
      "visible",
    ]);
    expect(
      result.customModels?.find((model) => model.id === "visible")
    ).toMatchObject({
      contextWindow: 32_768,
      maxOutputTokens: 8192,
      supportsThinking: false,
    });
    expect(
      result.customModels?.find((model) => model.id === "unknown")
        ?.contextWindow
    ).toBeUndefined();
  });

  test("does not substitute a public catalog when account credentials are missing", async () => {
    let requests = 0;
    const discover = createCerebrasModelDiscovery({
      fetch: async () => {
        requests += 1;
        return Response.json({ data: [] });
      },
      resolveDns: PUBLIC_DNS,
    });
    const context = discoveryContext("cerebras");
    context.apiKey = "";
    await expect(discover(context)).rejects.toThrow();
    expect(requests).toBe(0);
  });

  test("does not enrich proxy models from the official public catalog", async () => {
    const requests: string[] = [];
    const discover = createCerebrasModelDiscovery({
      fetch: async (input) => {
        requests.push(String(input));
        return Response.json({ data: [{ id: "gpt-oss-120b" }] });
      },
      resolveDns: PUBLIC_DNS,
    });
    const result = await discover(
      discoveryContext("cerebras", "https://proxy.example/v1")
    );

    expect(requests).toEqual(["https://proxy.example/v1/models"]);
    expect(result.models[0]?.contextWindow).toBeUndefined();
    expect(result.models[0]?.supportsThinking).toBeUndefined();
  });
});
