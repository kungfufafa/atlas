import { describe, expect, test } from "bun:test";
import { PROVIDER_CAPABILITY_IDS } from "@atlas/core/provider-capabilities";
import type { BuiltinProviderDefinition } from "@atlas/core/provider-catalog";
import {
  apiKeyPlaceholder,
  buildConfigureProviderRequest,
  buildCreateProviderRequest,
  effectiveProfileModelSelection,
  encodeModelSelection,
  firstAvailableProviderOption,
  hasOpenCodeZenProvider,
  isApiKeyRequiredForProvider,
  isOpenCodeZenBaseUrl,
  isProviderTypeAlreadyConfigured,
  modelsFromShortlistRows,
  profileModelSelectionValue,
  resolveModelReasoningEffortValues,
  resolveModelThinkingSupport,
  resolveModelVisionSupport,
  shouldRenderGenericCustomModelEditor,
  validateApiKeyForProvider,
  validateCustomModelsInput,
} from "./models";

test("modelsFromShortlistRows preserves generic capability evidence", () => {
  const capabilities = {
    "vendor.custom-operation": {
      source: "provider-discovery" as const,
      status: "supported" as const,
    },
  };

  expect(
    modelsFromShortlistRows("fireworks", [
      { capabilities, id: "vendor/model" },
    ])[0]?.capabilities
  ).toBe(capabilities);
});

function group(
  providerId: string,
  provider:
    | "openai_compatible"
    | "openai"
    | "opencode_go"
    | "openrouter"
    | "deepseek"
    | "cerebras"
    | "cloudflare"
    | "fireworks"
    | "xai",
  flags?: {
    reasoningCapability?: "supported" | "unsupported" | "unknown";
    reasoningEffortValues?: string[];
    supportsThinking?: boolean;
    supportsVision?: boolean;
    visionCapability?: "supported" | "unsupported" | "unknown";
    providerLabel?: string;
    contextWindow?: number;
  },
  modelId = "model-1"
) {
  return [
    {
      models: [
        {
          id: modelId,
          name: modelId,
          provider,
          ...(flags?.visionCapability === undefined &&
          flags?.reasoningCapability === undefined
            ? {}
            : {
                capabilities: {
                  ...(flags?.visionCapability === undefined
                    ? {}
                    : {
                        [PROVIDER_CAPABILITY_IDS.chatInputImage]: {
                          source: "static-manifest" as const,
                          status: flags.visionCapability,
                          verified: flags.visionCapability !== "unknown",
                        },
                      }),
                  ...(flags?.reasoningCapability === undefined
                    ? {}
                    : {
                        [PROVIDER_CAPABILITY_IDS.chatReasoning]: {
                          source: "static-manifest" as const,
                          status: flags.reasoningCapability,
                          verified: flags.reasoningCapability !== "unknown",
                        },
                      }),
                },
              }),
          ...(flags?.supportsThinking === undefined
            ? {}
            : { supportsThinking: flags.supportsThinking }),
          ...(flags?.supportsVision === undefined
            ? {}
            : { supportsVision: flags.supportsVision }),
          ...(flags?.contextWindow === undefined
            ? {}
            : { contextWindow: flags.contextWindow }),
          providerId,
          providerLabel: flags?.providerLabel,
          reasoningEffortValues: flags?.reasoningEffortValues,
        },
      ],
      providerId,
      providerLabel: flags?.providerLabel ?? providerId,
    },
  ];
}

describe("declarative provider API-key setup", () => {
  test("reads placeholders from provider metadata", () => {
    expect(apiKeyPlaceholder("anthropic")).toBe("sk-ant-…");
    expect(apiKeyPlaceholder("openai_compatible")).toBe(
      "Optional for local endpoints"
    );
  });

  test("evaluates required, optional, and conditional policies generically", () => {
    expect(isApiKeyRequiredForProvider("openai")).toBe(true);
    expect(isApiKeyRequiredForProvider("openai_compatible")).toBe(false);
    expect(isApiKeyRequiredForProvider("ollama", { hostMode: "local" })).toBe(
      false
    );
    expect(isApiKeyRequiredForProvider("ollama", { hostMode: "cloud" })).toBe(
      true
    );
    expect(validateApiKeyForProvider("", "ollama", { hostMode: "local" })).toBe(
      null
    );
    expect(validateApiKeyForProvider("", "ollama", { hostMode: "cloud" })).toBe(
      "API key is required."
    );
  });

  test("shows the generic custom-model editor for a synthetic catalog entry", () => {
    const synthetic = {
      apiKey: { placeholder: "Token", requirement: "required" },
      apiKeyEnvVar: "SYNTHETIC_API_KEY",
      displayName: "Synthetic",
      fallbackModelId: "synthetic-model",
      id: "synthetic",
      setup: { customModels: true },
    } satisfies BuiltinProviderDefinition;

    expect(shouldRenderGenericCustomModelEditor(synthetic)).toBe(true);
  });
});

describe("validateCustomModelsInput", () => {
  test("rejects ids that collide after trimming", () => {
    expect(validateCustomModelsInput([{ id: "same" }, { id: " same " }])).toBe(
      'Model IDs must be unique ("same" is duplicated).'
    );
  });
});

describe("resolveModelThinkingSupport", () => {
  test("uses reasoning capability claims without provider-specific rules", () => {
    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("compat-1", "model-1"),
        group("compat-1", "openai_compatible", {
          reasoningCapability: "supported",
        })
      )
    ).toBe(true);

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("openai-1", "model-1"),
        group("openai-1", "openai", {
          reasoningCapability: "unsupported",
        })
      )
    ).toBe(false);

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("fw-1", "model-1"),
        group("fw-1", "fireworks", { reasoningCapability: "unknown" })
      )
    ).toBeUndefined();
  });

  test("uses declarative legacy model metadata only when no claim exists", () => {
    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("openai-1", "model-1"),
        group("openai-1", "openai")
      )
    ).toBeUndefined();

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("compat-1", "model-1"),
        group("compat-1", "openai_compatible", { supportsThinking: true })
      )
    ).toBe(true);

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("ds-1", "model-1"),
        group("ds-1", "deepseek", { reasoningEffortValues: ["high"] })
      )
    ).toBe(true);
  });
});

describe("resolveModelReasoningEffortValues", () => {
  test("returns explicit reasoningEffortValues when defined on the model", () => {
    expect(
      resolveModelReasoningEffortValues(
        encodeModelSelection("tr-1", "qwen-1"),
        group(
          "tr-1",
          "openai_compatible",
          {
            reasoningEffortValues: ["low", "medium", "xhigh"],
          },
          "qwen-1"
        )
      )
    ).toEqual(["low", "medium", "xhigh"]);
  });

  test("returns undefined when model does not specify custom reasoningEffortValues", () => {
    expect(
      resolveModelReasoningEffortValues(
        encodeModelSelection("openai-1", "gpt-5.4"),
        group("openai-1", "openai", {}, "gpt-5.4")
      )
    ).toBeUndefined();
  });
});

describe("resolveModelVisionSupport", () => {
  test("uses capability claims without provider-specific branches", () => {
    expect(
      resolveModelVisionSupport(
        encodeModelSelection("compat-1", "model-1"),
        group("compat-1", "openai_compatible", {
          visionCapability: "supported",
        })
      )
    ).toBe(true);

    expect(
      resolveModelVisionSupport(
        encodeModelSelection("openai-1", "model-1"),
        group("openai-1", "openai", { visionCapability: "unsupported" })
      )
    ).toBe(false);

    expect(
      resolveModelVisionSupport(
        encodeModelSelection("xai-1", "model-1"),
        group("xai-1", "xai", { visionCapability: "unknown" })
      )
    ).toBeUndefined();
  });

  test("uses declarative legacy metadata only when no claim is present", () => {
    expect(
      resolveModelVisionSupport(
        encodeModelSelection("openai-1", "model-1"),
        group("openai-1", "openai")
      )
    ).toBeUndefined();

    expect(
      resolveModelVisionSupport(
        encodeModelSelection("compat-1", "model-1"),
        group("compat-1", "openai_compatible", { supportsVision: true })
      )
    ).toBe(true);
  });
});

describe("provider request builders", () => {
  test("persists the selected wire API for compatible endpoints", () => {
    expect(
      buildCreateProviderRequest({
        apiKey: "",
        baseUrl: "https://endpoint.test/v1/",
        customModels: [{ default: true, id: "gpt-5.4" }],
        displayName: "Endpoint",
        provider: "openai_compatible",
        wireApi: "responses",
      })
    ).toEqual({
      apiKey: "",
      baseUrl: "https://endpoint.test/v1/",
      customModels: [{ default: true, id: "gpt-5.4" }],
      label: "Endpoint",
      type: "openai_compatible",
      wireApi: "responses",
    });
  });

  test("keeps dynamic-provider endpoint and discovered model metadata", () => {
    expect(
      buildConfigureProviderRequest({
        apiKey: "xai-key",
        baseUrl: "https://api.x.ai/v1",
        customModels: [{ id: "grok-4-vision", supportsVision: true }],
        provider: "xai",
      })
    ).toEqual({
      apiKey: "xai-key",
      baseUrl: "https://api.x.ai/v1",
      customModels: [{ id: "grok-4-vision", supportsVision: true }],
      provider: "xai",
    });
  });

  test("uses setup metadata for provider-specific request fields", () => {
    expect(
      buildConfigureProviderRequest({
        apiKey: "oc-test",
        baseUrl: "https://ignored.example/v1",
        customModels: [{ id: "opencode-go/kimi-k2.7-code" }],
        provider: "opencode_go",
      })
    ).toEqual({
      apiKey: "oc-test",
      customModels: [{ id: "opencode-go/kimi-k2.7-code" }],
      provider: "opencode_go",
    });
  });
});

describe("isProviderTypeAlreadyConfigured", () => {
  test("treats builtin providers as taken once configured", () => {
    const configured = new Set(["openai", "anthropic"]);

    expect(isProviderTypeAlreadyConfigured("openai", configured)).toBe(true);
    expect(isProviderTypeAlreadyConfigured("gemini", configured)).toBe(false);
  });

  test("always allows another openai_compatible instance", () => {
    const configured = new Set(["openai_compatible", "openai"]);

    expect(
      isProviderTypeAlreadyConfigured("openai_compatible", configured)
    ).toBe(false);
  });

  test("always allows another ollama instance", () => {
    const configured = new Set(["ollama", "openai"]);

    expect(isProviderTypeAlreadyConfigured("ollama", configured)).toBe(false);
  });
});

describe("effectiveProfileModelSelection", () => {
  test("uses the first configured model when the profile has none", () => {
    const groups = group("compat-1", "openai_compatible");

    expect(effectiveProfileModelSelection(null, groups)).toBe(
      "compat-1::model-1"
    );
  });
});

describe("profileModelSelectionValue", () => {
  test("keeps an explicit provider when its selected model is not in the catalog yet", () => {
    const groups = [
      {
        models: [
          {
            id: "gpt-5.9-not-in-catalog",
            name: "Proxied GPT",
            provider: "openai_compatible" as const,
          },
        ],
        providerId: "zen-1",
        providerLabel: "OpenCode Zen",
      },
      {
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            provider: "openai" as const,
          },
        ],
        providerId: "openai-1",
        providerLabel: "OpenAI",
      },
    ];

    expect(
      profileModelSelectionValue("openai-1::gpt-5.9-not-in-catalog", groups)
    ).toBe("openai-1::gpt-5.9-not-in-catalog");
  });
});

describe("firstAvailableProviderOption", () => {
  test("keeps preferred provider when it is still free", () => {
    expect(firstAvailableProviderOption(new Set(["anthropic"]), "openai")).toBe(
      "openai"
    );
  });

  test("falls through to the next free builtin, then custom", () => {
    expect(firstAvailableProviderOption(new Set(["openai"]), "openai")).toBe(
      "anthropic"
    );
    expect(
      firstAvailableProviderOption(
        new Set([
          "openai",
          "anthropic",
          "openrouter",
          "gemini",
          "deepseek",
          "cerebras",
          "cloudflare",
          "fireworks",
          "opencode_go",
        ]),
        "openai"
      )
    ).toBe("ollama");
  });
});

describe("isOpenCodeZenBaseUrl", () => {
  test("matches Zen v1 and rejects OpenCode Go", () => {
    expect(isOpenCodeZenBaseUrl("https://opencode.ai/zen/v1")).toBe(true);
    expect(isOpenCodeZenBaseUrl("https://opencode.ai/zen/v1/")).toBe(true);
    expect(isOpenCodeZenBaseUrl("https://opencode.ai/zen/go/v1")).toBe(false);
    expect(isOpenCodeZenBaseUrl("https://api.openai.com/v1")).toBe(false);
  });
});

describe("hasOpenCodeZenProvider", () => {
  test("detects Zen by base URL or label on openai_compatible", () => {
    expect(
      hasOpenCodeZenProvider([
        {
          baseUrl: "https://opencode.ai/zen/v1",
          label: "OpenCode Zen",
          type: "openai_compatible",
        },
      ])
    ).toBe(true);

    expect(
      hasOpenCodeZenProvider([
        {
          baseUrl: "https://localhost:11434/v1",
          label: "Ollama",
          type: "openai_compatible",
        },
      ])
    ).toBe(false);

    expect(
      hasOpenCodeZenProvider([
        { baseUrl: null, label: "OpenCode Zen", type: "openai_compatible" },
      ])
    ).toBe(true);

    expect(
      hasOpenCodeZenProvider([
        { baseUrl: "https://opencode.ai/zen/go/v1", type: "opencode_go" },
      ])
    ).toBe(false);
  });
});
