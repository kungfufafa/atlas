import { describe, expect, test } from "bun:test";
import {
  inferCompatibleModelThinking,
  inferCompatibleReasoningEffortValues,
  parseRemoteOpenAIModelEntry,
  resolveCompatibleModelCapabilities,
} from "./compatible-model-capabilities";
import { PROVIDER_CAPABILITY_IDS } from "./provider-capabilities";

describe("inferCompatibleModelThinking", () => {
  test("detects advertised reasoning slugs and known families", () => {
    expect(inferCompatibleModelThinking("qwen/qwen3.8-max-free")).toBe(true);
    expect(
      inferCompatibleModelThinking(
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
      )
    ).toBe(true);
    expect(inferCompatibleModelThinking("anthropic/claude-sonnet-4-6")).toBe(
      true
    );
    expect(inferCompatibleModelThinking("meta-llama/llama-3.3-70b")).toBe(
      false
    );
    expect(inferCompatibleModelThinking("local-custom-7b")).toBe(false);
  });
});

describe("inferCompatibleReasoningEffortValues", () => {
  test("uses tokenrouter and qwen-style levels", () => {
    expect(
      inferCompatibleReasoningEffortValues("qwen/qwen3.8-max-free", {
        baseUrl: "https://api.tokenrouter.com/v1",
      })
    ).toEqual(["low", "medium", "xhigh"]);
  });

  test("uses claude and deepseek-specific levels", () => {
    expect(inferCompatibleReasoningEffortValues("claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(inferCompatibleReasoningEffortValues("deepseek-r1")).toEqual([
      "low",
      "high",
      "max",
    ]);
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
      [PROVIDER_CAPABILITY_IDS.audioTranscription]: {
        source: "provider-discovery",
        status: "supported",
      },
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
  });
});

describe("resolveCompatibleModelCapabilities", () => {
  test("keeps explicit false and fills missing advertised data", () => {
    expect(
      resolveCompatibleModelCapabilities("qwen/qwen3.8-max-free", {
        supportsThinking: false,
      })
    ).toEqual({ supportsThinking: false });

    expect(resolveCompatibleModelCapabilities("qwen/qwen3.8-max-free")).toEqual(
      {
        reasoningEffortValues: ["low", "medium", "xhigh"],
        supportsThinking: true,
      }
    );
  });
});
