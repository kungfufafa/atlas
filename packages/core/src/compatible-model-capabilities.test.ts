import { describe, expect, test } from "bun:test";
import {
  inferCompatibleModelThinking,
  inferCompatibleReasoningEffortValues,
  parseRemoteOpenAIModelEntry,
  resolveCompatibleModelCapabilities,
} from "./compatible-model-capabilities";
import { PROVIDER_CAPABILITY_IDS } from "./provider-capabilities";

describe("model metadata does not come from names", () => {
  test.each([
    "qwen/qwen3.8-max-free",
    "claude-sonnet-4-6",
    "deepseek-r1",
    "custom-thinking",
  ])("keeps support and effort unknown for %s", (id) => {
    expect(inferCompatibleModelThinking(id)).toBeUndefined();
    expect(
      inferCompatibleReasoningEffortValues(id, {
        baseUrl: "https://api.tokenrouter.com/v1",
        providerLabel: "TokenRouter",
      })
    ).toEqual([]);
    expect(resolveCompatibleModelCapabilities(id)).toEqual({});
  });
});

describe("parseRemoteOpenAIModelEntry", () => {
  test("reads OpenRouter-style supported_parameters", () => {
    expect(
      parseRemoteOpenAIModelEntry({
        id: "qwen/qwen3.8-max-free",
        name: "Qwen 3.8 Max Free",
        supported_parameters: ["temperature", "reasoning", "reasoning_effort"],
        supported_params_details: {
          reasoning_effort: { accepted_values: ["low", "medium", "xhigh"] },
        },
      })
    ).toEqual({
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
    });
  });

  test("reads a nested reasoning object and vision modalities", () => {
    expect(
      parseRemoteOpenAIModelEntry({
        architecture: { input_modalities: ["text", "image"] },
        id: "google/gemini-3-flash",
        reasoning: { supported_efforts: ["low", "medium", "high"] },
      })
    ).toEqual({
      capabilities: {
        [PROVIDER_CAPABILITY_IDS.chatInputImage]: {
          source: "provider-discovery",
          status: "supported",
          verified: true,
        },
        [PROVIDER_CAPABILITY_IDS.chatReasoning]: {
          source: "provider-discovery",
          status: "supported",
          verified: true,
        },
        [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: {
          source: "provider-discovery",
          status: "supported",
          verified: true,
        },
      },
      id: "google/gemini-3-flash",
      reasoningEffortValues: ["low", "medium", "high"],
      supportsThinking: true,
      supportsVision: true,
    });
  });

  test("reads a TokenRouter /v1/models row that only advertises id", () => {
    expect(
      parseRemoteOpenAIModelEntry({
        created: 1_786_810_001,
        id: "qwen/qwen3.8-max-free",
        object: "model",
        owned_by: "custom",
        supported_endpoint_types: ["openai"],
        tags: "Text",
      })
    ).toEqual({
      id: "qwen/qwen3.8-max-free",
    });
  });

  test("honors an explicit no-reasoning flag", () => {
    expect(
      parseRemoteOpenAIModelEntry({
        id: "qwen/qwen3.8-max-free",
        supports_reasoning: false,
      })
    ).toEqual({
      capabilities: {
        [PROVIDER_CAPABILITY_IDS.chatReasoning]: {
          source: "provider-discovery",
          status: "unsupported",
          verified: true,
        },
      },
      id: "qwen/qwen3.8-max-free",
      supportsThinking: false,
    });
  });

  test("normalizes advertised audio and image modalities", () => {
    const parsed = parseRemoteOpenAIModelEntry({
      architecture: {
        input_modalities: ["audio", "text"],
        output_modalities: ["image", "text"],
      },
      id: "multimodal-model",
      supported_parameters: ["tools", "response_format"],
    });

    expect(parsed?.capabilities).toMatchObject({
      [PROVIDER_CAPABILITY_IDS.chatInputAudio]: {
        source: "provider-discovery",
        status: "supported",
      },
      [PROVIDER_CAPABILITY_IDS.chatStructuredOutput]: {
        source: "provider-discovery",
        status: "supported",
      },
      [PROVIDER_CAPABILITY_IDS.chatToolUse]: {
        source: "provider-discovery",
        status: "supported",
      },
      [PROVIDER_CAPABILITY_IDS.imageGeneration]: {
        source: "provider-discovery",
        status: "supported",
      },
    });
    expect(
      parsed?.capabilities?.[PROVIDER_CAPABILITY_IDS.audioTranscription]
    ).toBeUndefined();
  });

  test("retains explicit context limits, effort values, and default", () => {
    expect(
      parseRemoteOpenAIModelEntry({
        context_length: 131_072,
        id: "custom",
        reasoning: { default_effort: "max", supported_efforts: ["low", "max"] },
        top_provider: { max_completion_tokens: 8192 },
      })
    ).toMatchObject({
      contextWindow: 131_072,
      defaultReasoningEffort: "max",
      maxOutputTokens: 8192,
      reasoningEffortValues: ["low", "max"],
    });
  });

  test("reads Cerebras public model limits and parameter flags", () => {
    const result = parseRemoteOpenAIModelEntry({
      capabilities: { reasoning: true, streaming: true, vision: false },
      id: "custom",
      limits: { max_completion_tokens: 40_960, max_context_length: 131_072 },
      supported_parameters: { reasoning_effort: false, tools: true },
    });
    expect(result).toMatchObject({
      capabilities: {
        "chat.streaming": { status: "supported" },
        "chat.tool-use": { status: "supported" },
      },
      contextWindow: 131_072,
      maxOutputTokens: 40_960,
      supportsThinking: true,
      supportsVision: false,
    });
    expect(result?.reasoningEffortValues).toBeUndefined();
  });

  test("reads vLLM's configured model length", () => {
    expect(
      parseRemoteOpenAIModelEntry({ id: "custom", max_model_len: 32_768 })
        ?.contextWindow
    ).toBe(32_768);
  });

  test("omits an inconsistent advertised reasoning default", () => {
    const model = parseRemoteOpenAIModelEntry({
      defaultReasoningEffort: "high",
      id: "custom",
      reasoningEffortValues: [],
    });
    expect(model?.reasoningEffortValues).toEqual([]);
    expect(model?.defaultReasoningEffort).toBeUndefined();
  });

  test("preserves false and empty metadata over parameter advertisements", () => {
    const result = parseRemoteOpenAIModelEntry({
      capabilities: { structured_outputs: false, tools: false },
      id: "thinking-vision-model",
      input_modalities: ["text", "image"],
      reasoningEffortValues: [],
      supported_parameters: ["reasoning", "tools", "response_format"],
      supportsThinking: false,
      supportsVision: false,
    });
    expect(result).toMatchObject({
      reasoningEffortValues: [],
      supportsThinking: false,
      supportsVision: false,
    });
    for (const capability of [
      PROVIDER_CAPABILITY_IDS.chatReasoning,
      PROVIDER_CAPABILITY_IDS.chatInputImage,
      PROVIDER_CAPABILITY_IDS.chatToolUse,
      PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
    ]) {
      expect(result?.capabilities?.[capability]?.status).toBe("unsupported");
    }
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "32768"])(
    "ignores invalid token limits %s",
    (limit) => {
      const result = parseRemoteOpenAIModelEntry({
        context_window: limit,
        id: "custom",
        max_output_tokens: limit,
      });
      expect(result?.contextWindow).toBeUndefined();
      expect(result?.maxOutputTokens).toBeUndefined();
    }
  );
});

describe("resolveCompatibleModelCapabilities", () => {
  test("keeps explicit false and preserves unknown advertised data", () => {
    expect(
      resolveCompatibleModelCapabilities("qwen/qwen3.8-max-free", {
        supportsThinking: false,
      })
    ).toEqual({ supportsThinking: false });

    expect(resolveCompatibleModelCapabilities("qwen/qwen3.8-max-free")).toEqual(
      {}
    );
    expect(
      resolveCompatibleModelCapabilities("custom", {
        reasoningEffortValues: [],
        supportsThinking: true,
      })
    ).toEqual({ reasoningEffortValues: [], supportsThinking: true });
  });
});
