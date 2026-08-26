import { describe, expect, test } from "bun:test";
import {
  buildConfigureProviderRequest,
  buildCreateProviderRequest,
  effectiveProfileModelSelection,
  encodeModelSelection,
  firstAvailableProviderOption,
  hasOpenCodeZenProvider,
  IMAGE_GENERATION_MODEL_OPTIONS,
  IMAGE_GENERATION_SELECTION,
  isOpenCodeZenBaseUrl,
  isProviderTypeAlreadyConfigured,
  profileModelSelectionValue,
  resolveModelReasoningEffortValues,
  resolveModelThinkingSupport,
  resolveModelVisionSupport,
  validateCustomModelsInput,
} from "./models";

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
    reasoningEffortValues?: string[];
    supportsThinking?: boolean;
    supportsVision?: boolean;
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

describe("validateCustomModelsInput", () => {
  test("rejects ids that collide after trimming", () => {
    expect(validateCustomModelsInput([{ id: "same" }, { id: " same " }])).toBe(
      'Model IDs must be unique ("same" is duplicated).'
    );
  });
});

describe("resolveModelThinkingSupport", () => {
  test("treats openai-compatible models as opt-in only", () => {
    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("compat-1", "model-1"),
        group("compat-1", "openai_compatible")
      )
    ).toBe(false);

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("compat-1", "model-1"),
        group("compat-1", "openai_compatible", { supportsThinking: true })
      )
    ).toBe(true);
  });

  test("preserves existing non-compatible behavior", () => {
    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("openai-1", "model-1"),
        group("openai-1", "openai")
      )
    ).toBe(true);

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("openai-1", "model-1"),
        group("openai-1", "openai", { supportsThinking: false })
      )
    ).toBe(false);
  });

  test("treats openrouter models as opt-in only", () => {
    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("or-1", "model-1"),
        group("or-1", "openrouter")
      )
    ).toBe(false);

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("or-1", "model-1"),
        group("or-1", "openrouter", { supportsThinking: true })
      )
    ).toBe(true);
  });

  test("treats deepseek models as opt-in only", () => {
    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("ds-1", "model-1"),
        group("ds-1", "deepseek")
      )
    ).toBe(false);

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("ds-1", "model-1"),
        group("ds-1", "deepseek", { supportsThinking: true })
      )
    ).toBe(true);
  });

  test("treats cerebras models as opt-in only", () => {
    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("cb-1", "model-1"),
        group("cb-1", "cerebras")
      )
    ).toBe(false);

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("cb-1", "model-1"),
        group("cb-1", "cerebras", { supportsThinking: true })
      )
    ).toBe(true);
  });

  test("treats fireworks models as opt-in only", () => {
    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("fw-1", "model-1"),
        group("fw-1", "fireworks")
      )
    ).toBe(false);

    expect(
      resolveModelThinkingSupport(
        encodeModelSelection("fw-1", "model-1"),
        group("fw-1", "fireworks", { supportsThinking: true })
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
  test("treats openai-compatible and opencode_go models as opt-in only", () => {
    expect(
      resolveModelVisionSupport(
        encodeModelSelection("compat-1", "model-1"),
        group("compat-1", "openai_compatible")
      )
    ).toBe(false);

    expect(
      resolveModelVisionSupport(
        encodeModelSelection("go-1", "model-1"),
        group("go-1", "opencode_go")
      )
    ).toBe(false);

    expect(
      resolveModelVisionSupport(
        encodeModelSelection("compat-1", "model-1"),
        group("compat-1", "openai_compatible", { supportsVision: true })
      )
    ).toBe(true);
  });

  test("defaults first-party models to vision-capable", () => {
    expect(
      resolveModelVisionSupport(
        encodeModelSelection("openai-1", "model-1"),
        group("openai-1", "openai")
      )
    ).toBe(true);

    expect(
      resolveModelVisionSupport(
        encodeModelSelection("openai-1", "model-1"),
        group("openai-1", "openai", { supportsVision: false })
      )
    ).toBe(false);
  });

  test("treats cerebras models as opt-in only for vision", () => {
    expect(
      resolveModelVisionSupport(
        encodeModelSelection("cb-1", "model-1"),
        group("cb-1", "cerebras")
      )
    ).toBe(false);

    expect(
      resolveModelVisionSupport(
        encodeModelSelection("cb-1", "model-1"),
        group("cb-1", "cerebras", { supportsVision: true })
      )
    ).toBe(true);
  });

  test("treats fireworks models as opt-in only for vision", () => {
    expect(
      resolveModelVisionSupport(
        encodeModelSelection("fw-1", "model-1"),
        group("fw-1", "fireworks")
      )
    ).toBe(false);

    expect(
      resolveModelVisionSupport(
        encodeModelSelection("fw-1", "model-1"),
        group("fw-1", "fireworks", { supportsVision: true })
      )
    ).toBe(true);
  });

  test("keeps direct discovery and Cloudflare models opt-in for vision", () => {
    expect(
      resolveModelVisionSupport(
        encodeModelSelection("xai-1", "grok-4"),
        group("xai-1", "xai", {}, "grok-4")
      )
    ).toBe(false);
    expect(
      resolveModelVisionSupport(
        encodeModelSelection("xai-1", "grok-4-vision"),
        group("xai-1", "xai", { supportsVision: true }, "grok-4-vision")
      )
    ).toBe(true);
    expect(
      resolveModelVisionSupport(
        encodeModelSelection("cf-1", "@cf/meta/llama"),
        group("cf-1", "cloudflare", {}, "@cf/meta/llama")
      )
    ).toBe(false);
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

describe("IMAGE_GENERATION_MODEL_OPTIONS", () => {
  test("exposes image generation models including default openai::gpt-image-2", () => {
    expect(IMAGE_GENERATION_MODEL_OPTIONS.length).toBeGreaterThanOrEqual(1);
    expect(IMAGE_GENERATION_MODEL_OPTIONS[0]?.id).toBe("gpt-image-2");
    expect(IMAGE_GENERATION_SELECTION).toBe("openai::gpt-image-2");
    expect(
      encodeModelSelection("openai", IMAGE_GENERATION_MODEL_OPTIONS[0]!.id)
    ).toBe(IMAGE_GENERATION_SELECTION);
  });
});
