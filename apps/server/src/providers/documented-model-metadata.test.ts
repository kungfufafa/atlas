import { describe, expect, test } from "bun:test";
import { PROVIDER_CAPABILITY_IDS, type ProviderInstance } from "@atlas/core";
import { getModelsForProviderInstance } from "./compatible-models";

function instance(
  type: ProviderInstance["type"],
  modelId: string,
  baseUrl?: string
): ProviderInstance {
  return {
    apiKey: "test-key",
    baseUrl,
    createdAt: "2026-09-06T00:00:00.000Z",
    customModels: [{ id: modelId }],
    id: "documented",
    label: "Documented provider",
    type,
  };
}

describe("exact documented API model capabilities", () => {
  test.each(["gpt-4o-mini", "gpt-5.3-codex", "gpt-5.4", "gpt-5.5"])(
    "uses verified %s model capabilities only at the official OpenAI endpoint",
    (modelId) => {
      const official = getModelsForProviderInstance(
        instance("openai", modelId)
      )[0];
      const proxy = getModelsForProviderInstance(
        instance("openai", modelId, "https://proxy.example/v1")
      )[0];
      for (const capabilityId of [
        PROVIDER_CAPABILITY_IDS.chatToolUse,
        PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
        PROVIDER_CAPABILITY_IDS.chatInputImage,
        PROVIDER_CAPABILITY_IDS.chatStreaming,
      ]) {
        expect(official?.capabilities?.[capabilityId]).toEqual({
          source: "static-manifest",
          status: "supported",
          verified: true,
        });
        expect(proxy?.capabilities?.[capabilityId]).toBeUndefined();
      }
      const search =
        official?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatNativeWebSearch];
      if (modelId === "gpt-5.4" || modelId === "gpt-5.5") {
        expect(search?.status).toBe("supported");
      } else {
        expect(search).toBeUndefined();
      }
    }
  );

  test.each([
    { id: "claude-sonnet-4-6", type: "anthropic" as const },
    { id: "claude-opus-4-6", type: "anthropic" as const },
    { id: "gemini-3-flash-preview", type: "gemini" as const },
    { id: "gemini-3.1-flash-lite", type: "gemini" as const },
    { id: "gemini-3.5-flash", type: "gemini" as const },
  ])("uses only verified native $type/$id feature claims", ({ type, id }) => {
    const known = getModelsForProviderInstance(instance(type, id))[0];
    const proxy = getModelsForProviderInstance(
      instance(type, id, "https://proxy.example")
    )[0];
    const unknown = getModelsForProviderInstance(
      instance(type, `${id}-custom`)
    )[0];
    expect(
      known?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatToolUse]?.status
    ).toBe("supported");
    expect(
      known?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatStructuredOutput]
        ?.status
    ).toBe("supported");
    expect(known?.contextWindow).toBeUndefined();
    expect(known?.defaultReasoningEffort).toBeUndefined();
    expect(known?.supportsThinking).toBeUndefined();
    expect(proxy?.capabilities).toBeUndefined();
    expect(unknown?.capabilities).toBeUndefined();
    if (type === "gemini") {
      expect(known?.supportsVision).toBe(true);
      expect(
        known?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatNativeWebSearch]
          ?.status
      ).toBe("supported");
      expect(
        known?.capabilities?.[PROVIDER_CAPABILITY_IDS.imageGeneration]?.status
      ).toBe("unsupported");
      expect(
        known?.capabilities?.[PROVIDER_CAPABILITY_IDS.audioTranscription]
      ).toBeUndefined();
    }
  });

  test.each(["openai", "gemini"] as const)(
    "%s lets explicit discovery claims and saved false flags override documents",
    (type) => {
      const configured = instance(
        type,
        type === "openai" ? "gpt-5.4" : "gemini-3.5-flash"
      );
      configured.customModels![0] = {
        ...configured.customModels![0]!,
        capabilities: {
          [PROVIDER_CAPABILITY_IDS.chatToolUse]: {
            source: "provider-discovery",
            status: "unsupported",
            verified: true,
          },
        },
        supportsVision: false,
      };
      const model = getModelsForProviderInstance(configured)[0];
      expect(
        model?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatToolUse]
      ).toEqual({
        source: "provider-discovery",
        status: "unsupported",
        verified: true,
      });
      expect(
        model?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatStructuredOutput]
          ?.status
      ).toBe("supported");
      expect(
        model?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatInputImage]?.status
      ).toBe("unsupported");
      expect(
        model?.capabilities?.[PROVIDER_CAPABILITY_IDS.imageUnderstanding]
          ?.status
      ).toBe("unsupported");
    }
  );
});
