import { describe, expect, test } from "bun:test";
import { AtlasApiError, type ProviderInstance } from "@atlas/core";
import {
  applyAdminCapabilityOverridePatch,
  applyProviderInstanceUpdate,
  buildProviderInstanceFromCreateRequest,
  countModelsForInstance,
  isProviderInstanceUsable,
  mergeModelsForConfig,
  modelExistsOnInstance,
  resolveProfileProviderSelection,
  toProviderInstanceSummary,
} from "./provider-instance-helpers";

function createProviderInstance(
  overrides: Partial<ProviderInstance> &
    Pick<ProviderInstance, "id" | "type" | "label">
): ProviderInstance {
  return {
    apiKey: "test-key",
    createdAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveProfileProviderSelection", () => {
  test("rejects a missing qualified provider even when another provider offers the same model", () => {
    const available = createProviderInstance({
      id: "other-openai",
      label: "Other OpenAI",
      type: "openai",
    });
    for (const providers of [[available], []]) {
      expect(() =>
        resolveProfileProviderSelection({
          defaultProviderId: available.id,
          profileModel: "deleted-openai::gpt-5.4",
          providers,
        })
      ).toThrow(AtlasApiError);
    }
  });

  test("rejects a qualified selection with no model instead of using its default", () => {
    const provider = createProviderInstance({
      id: "openai-1",
      label: "OpenAI",
      type: "openai",
    });
    expect(() =>
      resolveProfileProviderSelection({
        defaultProviderId: provider.id,
        profileModel: `${provider.id}:: `,
        providers: [provider],
      })
    ).toThrow(AtlasApiError);
  });

  test("rejects removed shortlist models and unmatched legacy choices", () => {
    const provider = createProviderInstance({
      customModels: [{ default: true, id: "gpt-4o-mini" }],
      id: "openai-1",
      label: "OpenAI",
      type: "openai",
    });
    for (const profileModel of [
      "openai-1::gpt-5.4",
      "gpt-5.4",
      "future-model",
    ]) {
      expect(() =>
        resolveProfileProviderSelection({
          defaultProviderId: provider.id,
          profileModel,
          providers: [provider],
        })
      ).toThrow(AtlasApiError);
    }
  });

  test("uses the explicitly selected provider instance for provider-qualified profile models", () => {
    const providers: ProviderInstance[] = [
      createProviderInstance({
        id: "zen-1",
        label: "OpenCode Zen",
        type: "opencode_go",
      }),
      createProviderInstance({
        id: "openai-1",
        label: "OpenAI",
        type: "openai",
      }),
    ];

    const resolved = resolveProfileProviderSelection({
      defaultProviderId: "zen-1",
      profileModel: "openai-1::gpt-5.4",
      providers,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.instance.id).toBe("openai-1");
    expect(resolved?.model).toBe("gpt-5.4");
  });

  test("keeps an explicit native provider when its model is newer than the catalog", () => {
    const resolved = resolveProfileProviderSelection({
      defaultProviderId: "zen-1",
      profileModel: "openai-1::gpt-5.9-not-in-catalog",
      providers: [
        createProviderInstance({
          apiKey: "public",
          baseUrl: "https://opencode.ai/zen/v1",
          customModels: [
            { default: true, id: "big-pickle", name: "Big Pickle" },
          ],
          id: "zen-1",
          label: "OpenCode Zen",
          type: "openai_compatible",
        }),
        createProviderInstance({
          id: "openai-1",
          label: "OpenAI",
          type: "openai",
        }),
      ],
    });

    expect(resolved?.instance.id).toBe("openai-1");
    expect(resolved?.model).toBe("gpt-5.9-not-in-catalog");
  });

  test("keeps an explicitly selected subscription model only while it is advertised", () => {
    const provider = createProviderInstance({
      apiKey: "",
      customModels: [{ default: true, id: "gpt-live" }, { id: "gpt-selected" }],
      id: "chatgpt-1",
      label: "ChatGPT",
      type: "chatgpt",
    });

    expect(
      resolveProfileProviderSelection({
        defaultProviderId: provider.id,
        profileModel: `${provider.id}::gpt-selected`,
        providers: [provider],
      })
    ).toEqual({ instance: provider, model: "gpt-selected" });
  });

  test("rejects an explicit subscription model that left the live snapshot", () => {
    const provider = createProviderInstance({
      apiKey: "",
      customModels: [{ default: true, id: "gpt-live" }],
      id: "chatgpt-1",
      label: "ChatGPT",
      type: "chatgpt",
    });

    expect(() =>
      resolveProfileProviderSelection({
        defaultProviderId: provider.id,
        profileModel: `${provider.id}::gpt-retired`,
        providers: [provider],
      })
    ).toThrow(
      'Model "gpt-retired" is no longer available for the ChatGPT subscription.'
    );
  });

  test("falls back to the provider that actually supports a raw stored model id", () => {
    const providers: ProviderInstance[] = [
      createProviderInstance({
        id: "zen-1",
        label: "OpenCode Zen",
        type: "opencode_go",
      }),
      createProviderInstance({
        id: "openai-1",
        label: "OpenAI",
        type: "openai",
      }),
    ];

    const resolved = resolveProfileProviderSelection({
      defaultProviderId: "zen-1",
      profileModel: "gpt-5.4",
      providers,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.instance.id).toBe("openai-1");
    expect(resolved?.model).toBe("gpt-5.4");
  });

  test("routes an unqualified legacy catalog model to its static owner before the active provider", () => {
    const providers: ProviderInstance[] = [
      createProviderInstance({
        apiKey: "public",
        baseUrl: "https://opencode.ai/zen/v1",
        customModels: [
          { default: true, id: "big-pickle", name: "Big Pickle" },
          { id: "gpt-5.4", name: "GPT 5.4" },
        ],
        id: "zen-1",
        label: "OpenCode Zen",
        type: "openai_compatible",
      }),
      createProviderInstance({
        id: "openai-1",
        label: "OpenAI",
        type: "openai",
      }),
    ];

    const resolved = resolveProfileProviderSelection({
      defaultProviderId: "zen-1",
      profileModel: "gpt-5.4",
      providers,
    });

    expect(resolved?.instance.id).toBe("openai-1");
    expect(resolved?.model).toBe("gpt-5.4");
  });

  test("routes shared legacy subscription model ids to their priced API owners", () => {
    const cases = [
      {
        apiProvider: createProviderInstance({
          id: "anthropic-1",
          label: "Anthropic",
          type: "anthropic",
        }),
        model: "claude-sonnet-4-6",
        subscriptionProvider: createProviderInstance({
          apiKey: "",
          id: "claude-1",
          label: "Claude",
          type: "claude",
        }),
      },
      {
        apiProvider: createProviderInstance({
          id: "openai-1",
          label: "OpenAI",
          type: "openai",
        }),
        model: "gpt-5.4",
        subscriptionProvider: createProviderInstance({
          apiKey: "",
          id: "chatgpt-1",
          label: "ChatGPT",
          type: "chatgpt",
        }),
      },
    ] as const;

    for (const { apiProvider, model, subscriptionProvider } of cases) {
      const resolved = resolveProfileProviderSelection({
        defaultProviderId: subscriptionProvider.id,
        profileModel: model,
        providers: [subscriptionProvider, apiProvider],
      });

      expect(resolved?.instance.id).toBe(apiProvider.id);
      expect(resolved?.model).toBe(model);
    }
  });

  test("prefers the active credential among duplicate legacy catalog owners", () => {
    const providers = [
      createProviderInstance({
        id: "openai-first",
        label: "OpenAI first",
        type: "openai",
      }),
      createProviderInstance({
        id: "openai-active",
        label: "OpenAI active",
        type: "openai",
      }),
    ];

    const resolved = resolveProfileProviderSelection({
      defaultProviderId: "openai-active",
      profileModel: "gpt-5.4",
      providers,
    });

    expect(resolved?.instance.id).toBe("openai-active");
    expect(resolved?.model).toBe("gpt-5.4");
  });

  test("keeps an explicit provider authoritative for a shared catalog model", () => {
    const providers: ProviderInstance[] = [
      createProviderInstance({
        apiKey: "public",
        baseUrl: "https://opencode.ai/zen/v1",
        customModels: [{ id: "gpt-5.4", name: "GPT 5.4" }],
        id: "zen-1",
        label: "OpenCode Zen",
        type: "openai_compatible",
      }),
      createProviderInstance({
        id: "openai-1",
        label: "OpenAI",
        type: "openai",
      }),
    ];

    const resolved = resolveProfileProviderSelection({
      defaultProviderId: "openai-1",
      profileModel: "zen-1::gpt-5.4",
      providers,
    });

    expect(resolved?.instance.id).toBe("zen-1");
    expect(resolved?.model).toBe("gpt-5.4");
  });

  test("falls back to the default provider when the profile does not override the model", () => {
    const providers: ProviderInstance[] = [
      createProviderInstance({
        id: "zen-1",
        label: "OpenCode Zen",
        type: "opencode_go",
      }),
      createProviderInstance({
        id: "openai-1",
        label: "OpenAI",
        type: "openai",
      }),
    ];

    const resolved = resolveProfileProviderSelection({
      defaultProviderId: "zen-1",
      profileModel: null,
      providers,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.instance.id).toBe("zen-1");
    expect(resolved?.model).toBe("opencode-go/kimi-k2.7-code");
  });

  test("does not treat catalog models as available on unrelated compatible providers", () => {
    const zen = createProviderInstance({
      apiKey: "public",
      baseUrl: "https://opencode.ai/zen/v1",
      customModels: [{ default: true, id: "big-pickle", name: "Big Pickle" }],
      id: "zen-1",
      label: "OpenCode Zen",
      type: "openai_compatible",
    });

    expect(modelExistsOnInstance(zen, "gpt-5.4")).toBe(false);
    expect(modelExistsOnInstance(zen, "big-pickle")).toBe(true);

    const resolved = resolveProfileProviderSelection({
      defaultProviderId: "zen-1",
      profileModel: "gpt-5.4",
      providers: [
        zen,
        createProviderInstance({
          id: "openai-1",
          label: "OpenAI",
          type: "openai",
        }),
      ],
    });

    expect(resolved?.instance.id).toBe("openai-1");
    expect(resolved?.model).toBe("gpt-5.4");
  });
});

describe("environment-backed provider visibility", () => {
  test("keeps models and configured status available without exposing the key", () => {
    const instance = createProviderInstance({
      apiKey: "",
      customModels: [{ default: true, id: "grok-default" }, { id: "grok-alt" }],
      id: "xai-env",
      label: "xAI",
      type: "xai",
    });
    const env = { XAI_API_KEY: "environment-secret" };

    expect(isProviderInstanceUsable(instance, env)).toBe(true);
    expect(countModelsForInstance(instance, env)).toBe(2);
    expect(mergeModelsForConfig([instance], env)).toHaveLength(2);
    expect(toProviderInstanceSummary(instance, 2, env).hasApiKey).toBe(true);
    expect(
      JSON.stringify(toProviderInstanceSummary(instance, 2, env))
    ).not.toContain("environment-secret");
  });

  test("derives credential-optional usability from the provider adapter", () => {
    const localOllama = createProviderInstance({
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      hostMode: "local",
      id: "ollama-local",
      label: "Ollama",
      type: "ollama",
    });
    const compatible = createProviderInstance({
      apiKey: "",
      baseUrl: "http://localhost:8080/v1",
      id: "compatible-local",
      label: "Local endpoint",
      type: "openai_compatible",
    });

    for (const instance of [localOllama, compatible]) {
      expect(isProviderInstanceUsable(instance, {})).toBe(true);
      expect(toProviderInstanceSummary(instance, 1, {}).hasApiKey).toBe(true);
    }
  });

  test("marks conditional cloud credentials missing without an API key", () => {
    const instance = createProviderInstance({
      apiKey: "",
      baseUrl: "https://ollama.com/v1",
      hostMode: "cloud",
      id: "ollama-cloud",
      label: "Ollama Cloud",
      type: "ollama",
    });

    expect(isProviderInstanceUsable(instance, {})).toBe(false);
    expect(toProviderInstanceSummary(instance, 0, {}).hasApiKey).toBe(false);
  });
});

describe("applyProviderInstanceUpdate", () => {
  test("invalidates connection-scoped model metadata when endpoint or credentials change", () => {
    const instance = createProviderInstance({
      apiKey: `sk-${"a".repeat(40)}`,
      baseUrl: "https://api.openai.com/v1",
      customModels: [
        {
          capabilities: {
            "chat.reasoning": {
              source: "provider-discovery",
              status: "supported",
              verified: true,
            },
          },
          contextWindow: 1_050_000,
          default: true,
          defaultReasoningEffort: "medium",
          id: "gpt-5.4",
          inputPerMillionUsd: 2.5,
          maxOutputTokens: 128_000,
          name: "Selected model",
          outputPerMillionUsd: 15,
          reasoningEffortValues: ["low", "medium", "high"],
          supportsThinking: true,
          supportsVision: true,
        },
      ],
      id: "openai-1",
      label: "OpenAI",
      type: "openai",
    });
    for (const update of [
      { apiKey: `sk-${"b".repeat(40)}` },
      {
        apiKey: `sk-${"a".repeat(40)}`,
        baseUrl: "https://proxy.example/v1",
      },
    ]) {
      const updated = applyProviderInstanceUpdate(instance, update);
      expect(updated.customModels).toEqual([
        { default: true, id: "gpt-5.4", name: "Selected model" },
      ]);
      expect(instance.customModels?.[0]?.contextWindow).toBe(1_050_000);
    }
  });

  test("invalidates metadata on host and wire changes while retaining intentional admin claims", () => {
    const adminClaim = {
      source: "admin-override" as const,
      status: "unsupported" as const,
      verified: true,
    };
    const discoveredClaim = {
      source: "provider-discovery" as const,
      status: "supported" as const,
      verified: true,
    };
    for (const { instance, update } of [
      {
        instance: createProviderInstance({
          hostMode: "local",
          id: "ollama-1",
          label: "Ollama",
          type: "ollama",
        }),
        update: { hostMode: "cloud" as const },
      },
      {
        instance: createProviderInstance({
          id: "compatible-1",
          label: "Compatible",
          type: "openai_compatible",
        }),
        update: { wireApi: "responses" as const },
      },
    ]) {
      const updated = applyProviderInstanceUpdate(
        {
          ...instance,
          capabilityOverrides: {
            "chat.reasoning": adminClaim,
            "chat.streaming": discoveredClaim,
          },
          customModels: [
            {
              capabilities: {
                "chat.reasoning": adminClaim,
                "chat.streaming": discoveredClaim,
              },
              contextWindow: 100_000,
              id: "model-1",
            },
          ],
        },
        update
      );
      expect(updated.customModels).toEqual([
        { capabilities: { "chat.reasoning": adminClaim }, id: "model-1" },
      ]);
      expect(updated.capabilityOverrides).toEqual({
        "chat.reasoning": adminClaim,
      });
    }
  });

  test("preserves unchanged connection metadata and accepts replacement discovery metadata", () => {
    const customModels = [{ contextWindow: 100_000, id: "model-1" }];
    const instance = createProviderInstance({
      baseUrl: "https://endpoint.example/v1",
      customModels,
      id: "compatible-1",
      label: "Compatible",
      type: "openai_compatible",
    });
    const unchanged = applyProviderInstanceUpdate(instance, {
      apiKey: "test-key",
      baseUrl: "https://endpoint.example/v1/",
      label: "Renamed",
    });
    expect(unchanged.customModels).toEqual(customModels);

    const rediscovered = [{ contextWindow: 200_000, id: "model-1" }];
    const changed = applyProviderInstanceUpdate(instance, {
      apiKey: "new-key",
      customModels: rediscovered,
    });
    expect(changed.customModels).toEqual(rediscovered);
  });

  test("rejects API keys and clears legacy secrets for subscription providers", () => {
    const instance = createProviderInstance({
      apiKey: "legacy-secret",
      id: "chatgpt-1",
      label: "ChatGPT",
      type: "chatgpt",
    });

    try {
      applyProviderInstanceUpdate(instance, { apiKey: "new-secret" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      expect((error as AtlasApiError).status).toBe(400);
      expect((error as AtlasApiError).message).toContain(
        "does not accept an API key"
      );
    }
    expect(
      applyProviderInstanceUpdate(instance, { label: "ChatGPT Plus" })
    ).toMatchObject({ apiKey: "", label: "ChatGPT Plus" });
  });

  test("rejects client-managed subscription model snapshots", () => {
    const instance = createProviderInstance({
      apiKey: "",
      id: "chatgpt-1",
      label: "ChatGPT",
      type: "chatgpt",
    });

    expect(() =>
      applyProviderInstanceUpdate(instance, {
        customModels: [{ id: "untrusted-model" }],
      })
    ).toThrow("managed by the authenticated runtime");
  });

  test("rejects unsupported subscription connection fields on create", () => {
    for (const fields of [
      { baseUrl: "https://user:secret@example.com" },
      { customModels: [{ id: "untrusted-model" }] },
      { hostMode: "cloud" as const },
      { wireApi: "responses" as const },
    ]) {
      expect(() =>
        buildProviderInstanceFromCreateRequest(
          { ...fields, skipValidation: true, type: "chatgpt" },
          []
        )
      ).toThrow("managed by the authenticated runtime");
    }
  });

  test("persists admin capability evidence with fail-closed unknown semantics", () => {
    const instance = createProviderInstance({
      capabilityOverrides: {
        "chat.streaming": {
          source: "static-manifest",
          status: "supported",
          verified: true,
        },
      },
      id: "openai-capabilities",
      label: "OpenAI",
      type: "openai",
    });

    const updated = applyProviderInstanceUpdate(instance, {
      capabilityOverrides: {
        "chat.reasoning": "supported",
        "chat.streaming": null,
        "chat.tool-use": "unknown",
      },
    });

    expect(updated.capabilityOverrides).toEqual({
      "chat.reasoning": {
        source: "admin-override",
        status: "supported",
        verified: true,
        verifiedAt: expect.any(String),
      },
      "chat.tool-use": {
        source: "admin-override",
        status: "unknown",
        verified: false,
      },
    });
    expect(toProviderInstanceSummary(updated, 1).capabilityOverrides).toEqual(
      updated.capabilityOverrides
    );
  });

  test("validates runtime capability override statuses", () => {
    expect(() =>
      applyAdminCapabilityOverridePatch(undefined, {
        "chat.tool-use": "guessed" as never,
      })
    ).toThrow("invalid status");
  });

  test("uses the adapter-owned error for a missing conditional credential", () => {
    const instance = createProviderInstance({
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      hostMode: "local",
      id: "ollama-local",
      label: "Ollama",
      type: "ollama",
    });

    expect(() =>
      applyProviderInstanceUpdate(instance, { hostMode: "cloud" }, {})
    ).toThrow("API key is required for Ollama Cloud.");
  });

  test("does not forward a stored credential to a changed base URL", () => {
    const instance = createProviderInstance({
      baseUrl: "https://trusted.example/v1",
      id: "compatible-1",
      label: "Trusted",
      type: "openai_compatible",
    });

    expect(() =>
      applyProviderInstanceUpdate(instance, {
        baseUrl: "https://different.example/v1",
      })
    ).toThrow("Re-enter the API key");
    expect(
      applyProviderInstanceUpdate(instance, {
        apiKey: "new-key",
        baseUrl: "https://different.example/v1/",
      })
    ).toMatchObject({
      apiKey: "new-key",
      baseUrl: "https://different.example/v1",
    });
    expect(
      applyProviderInstanceUpdate(instance, {
        baseUrl: "https://trusted.example/v1/",
      })
    ).toMatchObject({ apiKey: "test-key" });
  });

  test("stores Responses mode only for an OpenAI-compatible instance", () => {
    const compatible = createProviderInstance({
      baseUrl: "https://endpoint.test/v1",
      id: "compatible-1",
      label: "Endpoint",
      type: "openai_compatible",
      wireApi: "responses",
    });

    expect(
      applyProviderInstanceUpdate(compatible, {
        wireApi: "nonsense" as never,
      }).wireApi
    ).toBeUndefined();
    expect(
      applyProviderInstanceUpdate(compatible, { wireApi: "responses" }).wireApi
    ).toBe("responses");
    expect(
      applyProviderInstanceUpdate(
        createProviderInstance({
          id: "xai-1",
          label: "xAI Grok",
          type: "xai",
        }),
        { wireApi: "responses" }
      ).wireApi
    ).toBeUndefined();
  });

  test("preserves supportsThinking on compatible custom models", () => {
    const instance = createProviderInstance({
      apiKey: "",
      baseUrl: "https://api.example.com/v1",
      customModels: [
        {
          default: true,
          id: "qwen3.6-35b",
          name: "Qwen 3.6 35B",
          supportsThinking: true,
        },
      ],
      id: "compatible-1",
      label: "NetraRuntime",
      type: "openai_compatible",
    });

    const updated = applyProviderInstanceUpdate(instance, {
      customModels: [
        {
          default: true,
          id: "qwen3.6-35b",
          name: "Qwen 3.6 35B",
          supportsThinking: true,
        },
      ],
    });

    expect(updated.customModels?.[0]?.supportsThinking).toBe(true);
  });

  test("stores custom model shortlist for OpenAI", () => {
    const instance = createProviderInstance({
      id: "openai-1",
      label: "OpenAI",
      type: "openai",
    });

    const updated = applyProviderInstanceUpdate(instance, {
      customModels: [
        { default: true, id: "gpt-5.4", name: "GPT 5.4" },
        { id: "gpt-4o-mini", name: "GPT-4o mini" },
      ],
    });

    expect(updated.customModels).toHaveLength(2);
    expect(modelExistsOnInstance(updated, "gpt-5.4")).toBe(true);
    expect(modelExistsOnInstance(updated, "gpt-5.3-codex")).toBe(false);
  });

  test("validates cerebras models against shortlist and static catalog", () => {
    const withShortlist = createProviderInstance({
      customModels: [
        { default: true, id: "gpt-oss-120b", name: "GPT OSS 120B" },
      ],
      id: "cb-1",
      label: "Cerebras",
      type: "cerebras",
    });

    expect(modelExistsOnInstance(withShortlist, "gpt-oss-120b")).toBe(true);
    expect(modelExistsOnInstance(withShortlist, "gemma-4-31b")).toBe(false);

    const withoutShortlist = createProviderInstance({
      id: "cb-2",
      label: "Cerebras",
      type: "cerebras",
    });

    expect(modelExistsOnInstance(withoutShortlist, "gemma-4-31b")).toBe(true);
    expect(modelExistsOnInstance(withoutShortlist, "unknown-model")).toBe(
      false
    );
  });

  test("validates fireworks models against shortlist and static catalog", () => {
    const withShortlist = createProviderInstance({
      customModels: [
        {
          default: true,
          id: "accounts/fireworks/models/kimi-k2p6",
          name: "Kimi K2.6",
        },
      ],
      id: "fw-1",
      label: "Fireworks",
      type: "fireworks",
    });

    expect(
      modelExistsOnInstance(
        withShortlist,
        "accounts/fireworks/models/kimi-k2p6"
      )
    ).toBe(true);
    expect(
      modelExistsOnInstance(withShortlist, "accounts/fireworks/models/glm-5p2")
    ).toBe(false);

    const withoutShortlist = createProviderInstance({
      id: "fw-2",
      label: "Fireworks",
      type: "fireworks",
    });

    expect(
      modelExistsOnInstance(
        withoutShortlist,
        "accounts/fireworks/models/glm-5p2"
      )
    ).toBe(true);
    expect(
      modelExistsOnInstance(withoutShortlist, "accounts/unknown/models/foo")
    ).toBe(false);
  });

  test("clears an OpenCode Go shortlist so the live catalog is used", () => {
    const instance = createProviderInstance({
      customModels: [{ id: "opencode-go/kimi-k2.7-code" }],
      id: "go-1",
      label: "OpenCode Go",
      type: "opencode_go",
    });

    const next = applyProviderInstanceUpdate(instance, { customModels: [] });
    expect(next.customModels).toBeUndefined();
  });
});

describe("buildProviderInstanceFromCreateRequest", () => {
  test("does not seed proxy model capabilities or prices from another provider's matching model ID", () => {
    const provider = buildProviderInstanceFromCreateRequest(
      {
        apiKey: "test-key",
        baseUrl: "https://proxy.example/v1",
        label: "Proxy",
        model: "gpt-5.4",
        skipValidation: true,
        type: "openai_compatible",
      },
      []
    );
    expect(provider.customModels).toEqual([{ default: true, id: "gpt-5.4" }]);
  });
  test("rejects API keys for subscription providers", () => {
    for (const type of ["chatgpt", "claude"] as const) {
      try {
        buildProviderInstanceFromCreateRequest(
          { apiKey: "should-not-be-stored", type },
          []
        );
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(AtlasApiError);
        expect((error as AtlasApiError).status).toBe(400);
        expect((error as AtlasApiError).message).toContain(
          "does not accept an API key"
        );
      }
    }
  });

  test("keeps custom models for a provider that opts in through catalog metadata", () => {
    const instance = buildProviderInstanceFromCreateRequest(
      {
        apiKey: `sk-${"a".repeat(48)}`,
        customModels: [{ default: true, id: "gpt-future" }],
        type: "openai",
      },
      []
    );

    expect(instance.customModels).toEqual([
      { default: true, id: "gpt-future" },
    ]);
  });

  test("rejects duplicate singleton providers", () => {
    const existing = createProviderInstance({
      id: "openai-existing",
      label: "OpenAI",
      type: "openai",
    });

    try {
      buildProviderInstanceFromCreateRequest(
        { apiKey: "sk-second", type: "openai" },
        [existing]
      );
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      expect((error as AtlasApiError).status).toBe(409);
    }
  });

  test("allows duplicate instances for providers that opt in", () => {
    const existing = createProviderInstance({
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      customModels: [{ default: true, id: "local-first" }],
      id: "compatible-existing",
      label: "Compatible first",
      type: "openai_compatible",
    });

    const created = buildProviderInstanceFromCreateRequest(
      {
        apiKey: "",
        baseUrl: "http://localhost:1234/v1",
        customModels: [{ default: true, id: "local-second" }],
        label: "Compatible second",
        type: "openai_compatible",
      },
      [existing]
    );

    expect(created).toMatchObject({
      baseUrl: "http://localhost:1234/v1",
      label: "Compatible second",
      type: "openai_compatible",
    });
  });

  test("applies declarative custom-model id validation", () => {
    expect(() =>
      buildProviderInstanceFromCreateRequest(
        {
          apiKey: `sk-or-${"a".repeat(30)}`,
          customModels: [{ default: true, id: "missing-vendor" }],
          type: "openrouter",
        },
        []
      )
    ).toThrow(
      'Invalid OpenRouter model id "missing-vendor". Use vendor/model format.'
    );
  });

  test("accepts a credential-optional provider through adapter policy", () => {
    const instance = buildProviderInstanceFromCreateRequest(
      {
        apiKey: "",
        baseUrl: "http://localhost:8080/v1",
        customModels: [{ default: true, id: "local-model" }],
        label: "Local endpoint",
        type: "openai_compatible",
      },
      []
    );

    expect(instance).toMatchObject({
      apiKey: "",
      type: "openai_compatible",
    });
  });

  test("uses the adapter-owned message for conditional credentials", () => {
    for (const hostMode of ["cloud", undefined] as const) {
      expect(() =>
        buildProviderInstanceFromCreateRequest(
          {
            apiKey: "",
            baseUrl: "https://ollama.com/v1",
            customModels: [{ default: true, id: "gpt-oss:120b" }],
            ...(hostMode ? { hostMode } : {}),
            type: "ollama",
          },
          []
        )
      ).toThrow("API key is required for Ollama Cloud.");
    }
  });

  test("uses native discovery defaults without losing custom capabilities", () => {
    const instance = buildProviderInstanceFromCreateRequest(
      {
        apiKey: "xai-key",
        customModels: [
          {
            default: true,
            id: "grok-4-vision",
            supportsVision: true,
          },
        ],
        type: "xai",
      },
      []
    );

    expect(instance.baseUrl).toBe("https://api.x.ai/v1");
    expect(instance.customModels).toEqual([
      {
        default: true,
        id: "grok-4-vision",
        supportsVision: true,
      },
    ]);
  });

  // readJson casts the body without validating it, so both fields can arrive
  // undefined however the contract types them.
  test("names the missing field and answers 400, not a TypeError at 500", () => {
    const cases = [
      [{}, "Provider type is required."],
      [{ type: "openai" }, "API key is required."],
    ] as const;

    for (const [request, message] of cases) {
      try {
        buildProviderInstanceFromCreateRequest(request, []);
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(AtlasApiError);
        expect((error as AtlasApiError).message).toBe(message);
        expect((error as AtlasApiError).status).toBe(400);
      }
    }
  });

  test("rejects an obviously malformed OpenAI key before persisting it", () => {
    expect(() =>
      buildProviderInstanceFromCreateRequest(
        { apiKey: "sk-junk-qa-123", type: "openai" },
        []
      )
    ).toThrow(/valid OpenAI API key/i);
  });
});
