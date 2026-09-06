import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  type CustomModelEntry,
  type ModelsResponse,
  PROVIDER_CAPABILITY_IDS,
  type ProviderInstance,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { createMinimalHonoApp } from "../http/test-app-helpers";
import { loginUserSession, seedOrgAdmin } from "../http/test-session-helpers";
import { builtinProviderAdapterRegistry } from "../providers/capabilities/builtin-adapters";
import {
  createNativeModelDiscovery,
  createOpenAICompatibleModelDiscovery,
} from "../providers/capabilities/model-discovery";
import { ProviderAdapterRegistry } from "../providers/capabilities/registry";
import {
  fetchAnthropicModels,
  fetchGeminiModels,
} from "../providers/native-models";
import {
  OPENCODE_GO_MODELS_URL,
  resetOpenCodeGoCatalogCacheForTests,
} from "../providers/opencode-go/catalog";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-model-metadata-http-");

const originalFetch = globalThis.fetch;
const CREATED_AT = "2026-09-06T00:00:00.000Z";
const PUBLIC_DNS = async () => [{ address: "8.8.8.8", family: 4 as const }];

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOpenCodeGoCatalogCacheForTests();
});

function provider(
  id: string,
  type: ProviderInstance["type"],
  baseUrl: string
): ProviderInstance {
  return {
    apiKey: "test-key",
    baseUrl,
    createdAt: CREATED_AT,
    id,
    label: id,
    type,
  };
}

async function createMetadataApp(
  providers: ProviderInstance[],
  registry: ProviderAdapterRegistry
) {
  resetOpenCodeGoCatalogCacheForTests();
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== OPENCODE_GO_MODELS_URL) {
      throw new Error(`Unexpected network request: ${url}`);
    }
    return Response.json({ data: [{ id: "kimi-k2.7-code" }] });
  }) as unknown as typeof fetch;
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const agent = new AgentService(
    null,
    null,
    databaseAdapter,
    undefined,
    registry
  );
  const { app, authService } = createMinimalHonoApp({ agent, databaseAdapter });
  const admin = await seedOrgAdmin(databaseAdapter, { authService });
  await databaseAdapter.upsertOrgAiConfig({
    config: { defaultProviderId: providers[0]!.id, providers },
    orgId: admin.orgId,
    updatedAt: CREATED_AT,
  });
  const session = await loginUserSession(
    app,
    admin.email,
    admin.password,
    admin.orgId
  );

  async function discoverAndSave(
    providerId: string
  ): Promise<CustomModelEntry[]> {
    const discoveredResponse = await app.fetch(
      new Request("http://localhost:4310/v1/models/discover", {
        body: JSON.stringify({ providerId }),
        headers: session.headers({ "X-CSRF-Token": session.csrfToken }),
        method: "POST",
      })
    );
    expect(discoveredResponse.status).toBe(200);
    const discovered = (await discoveredResponse.json()) as ModelsResponse;
    expect(discovered.customModels).toBeDefined();
    const saved = await app.fetch(
      new Request(`http://localhost:4310/v1/providers/${providerId}`, {
        body: JSON.stringify({
          customModels: discovered.customModels,
          skipValidation: true,
        }),
        headers: session.headers({ "X-CSRF-Token": session.csrfToken }),
        method: "PATCH",
      })
    );
    expect(saved.status).toBe(200);
    const persisted = (
      await databaseAdapter.getOrgAiConfig(admin.orgId)
    )?.config.providers.find((entry) => entry.id === providerId)?.customModels;
    expect(persisted).toEqual(discovered.customModels);
    return discovered.customModels!;
  }

  async function listModels(): Promise<ModelsResponse> {
    const response = await app.fetch(
      new Request("http://localhost:4310/v1/models", {
        headers: session.headers(),
      })
    );
    expect(response.status).toBe(200);
    return (await response.json()) as ModelsResponse;
  }

  return { discoverAndSave, listModels };
}

describe("model metadata discovery, persistence, and HTTP responses", () => {
  test("keeps exact advertised metadata and unknown models scoped to the provider instance", async () => {
    const registry = new ProviderAdapterRegistry();
    registry.register({
      ...builtinProviderAdapterRegistry.require("openai"),
      discoverModels: createOpenAICompatibleModelDiscovery({
        fetch: async (input) =>
          Response.json({
            data: String(input).includes("known.example")
              ? [
                  {
                    context_length: 32_768,
                    default_reasoning_effort: "high",
                    id: "gpt-5.4",
                    max_output_tokens: 4096,
                    reasoning_effort_values: ["low", "high"],
                    supports_reasoning: true,
                  },
                  {
                    id: "gpt-4.1",
                    reasoning_effort_values: [],
                    supports_reasoning: false,
                    supports_vision: false,
                  },
                  { id: "gpt-5-mini" },
                ]
              : [{ id: "gpt-5.4" }],
          }),
        resolveDns: PUBLIC_DNS,
      }),
    });
    const { discoverAndSave, listModels } = await createMetadataApp(
      [
        provider("known", "openai", "https://known.example/v1"),
        provider("other", "openai", "https://other.example/v1"),
      ],
      registry
    );
    const entries = await discoverAndSave("known");
    await discoverAndSave("other");
    expect(entries.find((entry) => entry.id === "gpt-5.4")).toMatchObject({
      contextWindow: 32_768,
      defaultReasoningEffort: "high",
      maxOutputTokens: 4096,
      reasoningEffortValues: ["low", "high"],
      supportsThinking: true,
    });
    expect(entries.find((entry) => entry.id === "gpt-4.1")).toMatchObject({
      reasoningEffortValues: [],
      supportsThinking: false,
      supportsVision: false,
    });

    const result = await listModels();
    expect(result.models).toHaveLength(4);
    const known = result.models.find(
      (model) => model.id === "gpt-5.4" && model.providerId === "known"
    );
    expect(known).toMatchObject({
      capabilities: {
        [PROVIDER_CAPABILITY_IDS.chatReasoning]: {
          source: "provider-discovery",
          status: "supported",
          verified: true,
        },
      },
      contextWindow: 32_768,
      defaultReasoningEffort: "high",
      maxOutputTokens: 4096,
      reasoningEffortValues: ["low", "high"],
      supportsThinking: true,
    });
    expect(result.models.find((model) => model.id === "gpt-4.1")).toMatchObject(
      {
        capabilities: {
          [PROVIDER_CAPABILITY_IDS.chatReasoning]: { status: "unsupported" },
          [PROVIDER_CAPABILITY_IDS.chatInputImage]: { status: "unsupported" },
        },
        reasoningEffortValues: [],
        supportsThinking: false,
        supportsVision: false,
      }
    );
    const unknownModels = result.models.filter(
      (model) => model.providerId === "other" || model.id === "gpt-5-mini"
    );
    expect(unknownModels).toHaveLength(2);
    for (const model of unknownModels) {
      expect(model.contextWindow).toBeUndefined();
      expect(model.maxOutputTokens).toBeUndefined();
      expect(model.defaultReasoningEffort).toBeUndefined();
      expect(model.reasoningEffortValues).toBeUndefined();
      expect(model.supportsThinking).toBeUndefined();
      expect(
        model.capabilities?.[PROVIDER_CAPABILITY_IDS.chatReasoning]?.status
      ).toBe("unknown");
      for (const capabilityId of [
        PROVIDER_CAPABILITY_IDS.chatInputImage,
        PROVIDER_CAPABILITY_IDS.chatToolUse,
        PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
      ]) {
        expect(model.capabilities?.[capabilityId]?.status).toBe("unknown");
      }
      // The OpenAI adapter explicitly disables hosted search on proxy endpoints.
      expect(
        model.capabilities?.[PROVIDER_CAPABILITY_IDS.chatNativeWebSearch]
          ?.status
      ).toBe("unsupported");
    }
  });

  test.each([
    {
      baseUrl: "https://api.anthropic.com",
      fetchModels: fetchAnthropicModels,
      knownId: "claude-sonnet-4-6",
      payload: {
        data: [
          {
            capabilities: {
              effort: { supported: false },
              thinking: { supported: true },
            },
            id: "claude-sonnet-4-6",
            max_input_tokens: 200_000,
            max_tokens: 8192,
          },
          { id: "claude-opus-4-6" },
        ],
        has_more: false,
      },
      type: "anthropic" as const,
      unknownId: "claude-opus-4-6",
    },
    {
      baseUrl: "https://generativelanguage.googleapis.com",
      fetchModels: fetchGeminiModels,
      knownId: "gemini-2.5-pro",
      payload: {
        models: [
          {
            inputTokenLimit: 200_000,
            name: "models/gemini-2.5-pro",
            outputTokenLimit: 8192,
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
          },
          {
            name: "models/gemini-2.5-flash",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      },
      type: "gemini" as const,
      unknownId: "gemini-2.5-flash",
    },
  ])(
    "keeps discovered $type reasoning above unknown global manifest claims",
    async ({ baseUrl, fetchModels, knownId, payload, type, unknownId }) => {
      const registry = new ProviderAdapterRegistry();
      registry.register({
        ...builtinProviderAdapterRegistry.require(type),
        discoverModels: createNativeModelDiscovery({
          baseUrl,
          fetch: async () => Response.json(payload),
          fetchModels,
          resolveDns: PUBLIC_DNS,
        }),
      });
      const { discoverAndSave, listModels } = await createMetadataApp(
        [provider("native", type, baseUrl)],
        registry
      );
      await discoverAndSave("native");
      const result = await listModels();
      expect(result.models).toHaveLength(2);
      const known = result.models.find((model) => model.id === knownId);
      expect(known).toMatchObject({
        capabilities: {
          [PROVIDER_CAPABILITY_IDS.chatReasoning]: {
            source: "provider-discovery",
            status: "supported",
            verified: true,
          },
        },
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsThinking: true,
      });
      expect(known?.defaultReasoningEffort).toBeUndefined();
      if (type === "anthropic") {
        expect(known?.reasoningEffortValues).toEqual([]);
      } else {
        expect(known?.reasoningEffortValues).toBeUndefined();
      }
      const unknown = result.models.find((model) => model.id === unknownId);
      expect(unknown?.contextWindow).toBeUndefined();
      expect(unknown?.maxOutputTokens).toBeUndefined();
      expect(unknown?.supportsThinking).toBeUndefined();
      expect(
        unknown?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatReasoning]?.status
      ).toBe("unknown");
    }
  );
});
