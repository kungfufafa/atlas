import { describe, expect, mock, test } from "bun:test";
import {
  PROVIDER_CAPABILITY_CONTRACT_VERSION,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import {
  builtinProviderAdapterRegistry,
  getModelsForProviderInstance,
  ProviderAdapterRegistry,
} from "../providers";
import {
  createChatCapabilityAwareProvider,
  resolveChatCapabilityPolicy,
} from "./chat-capability-policy";

const createdAt = "2026-08-27T00:00:00.000Z";

function resolvePolicy(instance: ProviderInstance, modelId: string) {
  const config: UserConfig = {
    defaultProviderId: instance.id,
    providers: [instance],
  };
  const model = getModelsForProviderInstance(instance).find(
    (candidate) => candidate.id === modelId
  );
  return resolveChatCapabilityPolicy({
    config,
    instance,
    model,
    modelId,
    readApiKey: (provider) => provider.apiKey,
    registry: builtinProviderAdapterRegistry,
  });
}

describe("server chat capability policy", () => {
  test("guards background provider clients created from registry context", async () => {
    const generateText = mock(async () => ({ content: "must not run" }));
    const registry = new ProviderAdapterRegistry();
    const unsupported = {
      source: "static-manifest",
      status: "unsupported",
      verified: true,
    } as const;
    const manifest: ProviderCapabilityManifestV1 = {
      adapterApiVersion: 1,
      capabilities: {
        [PROVIDER_CAPABILITY_IDS.chatCompletion]: {
          contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
          implementation: { status: "available" },
          modelDefault: unsupported,
          native: unsupported,
        },
      },
      manifestRevision: "test",
      provider: {
        displayName: "Synthetic background provider",
        id: "openai_compatible",
      },
      schemaVersion: 1,
    };
    registry.register({
      chatCapabilities: [PROVIDER_CAPABILITY_IDS.chatCompletion],
      createChatClient: () => ({
        async generateChat() {
          throw new Error("unused");
        },
        generateText,
        name: "openai_compatible",
        async streamChat() {
          throw new Error("unused");
        },
      }),
      credentialsRequired: () => false,
      manifest,
    });
    const instance: ProviderInstance = {
      apiKey: "",
      baseUrl: "https://synthetic.invalid/v1",
      createdAt,
      customModels: [{ default: true, id: "synthetic-model" }],
      id: "synthetic-instance",
      label: "Synthetic",
      type: "openai_compatible",
    };
    const config: UserConfig = {
      defaultProviderId: instance.id,
      providers: [instance],
    };
    const provider = createChatCapabilityAwareProvider({
      config,
      env: {},
      instance,
      modelId: "synthetic-model",
      registry,
    });

    if (!provider) {
      throw new Error("Expected a synthetic provider client.");
    }
    await expect(
      provider.generateText({ prompt: "merge", system: "background" })
    ).rejects.toMatchObject({
      capabilityId: PROVIDER_CAPABILITY_IDS.chatCompletion,
      code: "CHAT_CAPABILITY_UNSUPPORTED",
    });
    expect(generateText).toHaveBeenCalledTimes(0);
  });

  test("combines adapter defaults with static model reasoning evidence", () => {
    const policy = resolvePolicy(
      {
        apiKey: "test-key",
        createdAt,
        id: "openai-test",
        label: "OpenAI",
        type: "openai",
      },
      "gpt-5.4"
    );

    expect(
      policy.capabilities[PROVIDER_CAPABILITY_IDS.chatCompletion]
    ).toMatchObject({ selectable: true, status: "supported" });
    expect(
      policy.capabilities[PROVIDER_CAPABILITY_IDS.chatToolUse]
    ).toMatchObject({ selectable: true, status: "supported" });
    expect(
      policy.capabilities[PROVIDER_CAPABILITY_IDS.chatReasoning]
    ).toMatchObject({ selectable: true, status: "supported" });
  });

  test("preserves unknown evidence and honors an admin override", () => {
    const fireworksPolicy = resolvePolicy(
      {
        apiKey: "test-key",
        createdAt,
        id: "fireworks-test",
        label: "Fireworks",
        type: "fireworks",
      },
      "accounts/fireworks/models/kimi-k2p6"
    );
    expect(
      fireworksPolicy.capabilities[PROVIDER_CAPABILITY_IDS.chatToolUse]
    ).toMatchObject({
      reasons: ["model-unknown"],
      selectable: false,
      status: "unknown",
    });

    const openAIWithOverride: ProviderInstance = {
      apiKey: "test-key",
      capabilityOverrides: {
        [PROVIDER_CAPABILITY_IDS.chatToolUse]: {
          source: "admin-override",
          status: "unsupported",
          verified: true,
        },
      },
      createdAt,
      id: "openai-override",
      label: "OpenAI override",
      type: "openai",
    };
    const overridePolicy = resolvePolicy(openAIWithOverride, "gpt-5.4");
    expect(
      overridePolicy.capabilities[PROVIDER_CAPABILITY_IDS.chatToolUse]
    ).toMatchObject({
      reasons: ["model-unsupported"],
      selectable: false,
      status: "unsupported",
    });

    openAIWithOverride.capabilityOverrides![
      PROVIDER_CAPABILITY_IDS.chatToolUse
    ] = {
      source: "admin-override",
      status: "unknown",
      verified: false,
    };
    expect(
      resolvePolicy(openAIWithOverride, "gpt-5.4").capabilities[
        PROVIDER_CAPABILITY_IDS.chatToolUse
      ]
    ).toMatchObject({
      reasons: ["model-unknown"],
      selectable: false,
      status: "unknown",
    });
  });

  test("carries adapter request constraints into chat orchestration", () => {
    const policy = resolvePolicy(
      {
        apiKey: "test-key",
        createdAt,
        id: "gemini-test",
        label: "Gemini",
        type: "gemini",
      },
      "gemini-3-flash-preview"
    );

    expect(
      policy.capabilities[PROVIDER_CAPABILITY_IDS.chatNativeWebSearch]
    ).toMatchObject({
      constraints: {
        supportedValues: {
          "request.local-tools": [false],
          "request.multimodal": [false],
        },
      },
      selectable: true,
      status: "supported",
    });
  });

  test("preserves native-search constraints under an admin status override", () => {
    const policy = resolvePolicy(
      {
        apiKey: "test-key",
        capabilityOverrides: {
          [PROVIDER_CAPABILITY_IDS.chatNativeWebSearch]: {
            source: "admin-override",
            status: "supported",
            verified: true,
          },
        },
        createdAt,
        id: "gemini-override",
        label: "Gemini override",
        type: "gemini",
      },
      "gemini-3-flash-preview"
    );

    expect(
      policy.capabilities[PROVIDER_CAPABILITY_IDS.chatNativeWebSearch]
    ).toMatchObject({
      constraints: {
        supportedValues: {
          "request.local-tools": [false],
          "request.multimodal": [false],
        },
      },
      selectable: true,
      status: "supported",
    });
  });

  test("fails closed for OpenAI native search on compatible endpoints", () => {
    const customEndpointPolicy = resolvePolicy(
      {
        apiKey: "test-key",
        baseUrl: "https://compatible.example/v1",
        createdAt,
        id: "openai-compatible-endpoint",
        label: "OpenAI-compatible endpoint",
        type: "openai",
      },
      "gpt-5.4"
    );
    expect(
      customEndpointPolicy.capabilities[
        PROVIDER_CAPABILITY_IDS.chatNativeWebSearch
      ]
    ).toMatchObject({
      reasons: ["model-unsupported"],
      selectable: false,
      status: "unsupported",
    });

    const officialEndpointPolicy = resolvePolicy(
      {
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1/",
        createdAt,
        id: "openai-official-endpoint",
        label: "OpenAI official endpoint",
        type: "openai",
      },
      "gpt-5.4"
    );
    expect(
      officialEndpointPolicy.capabilities[
        PROVIDER_CAPABILITY_IDS.chatNativeWebSearch
      ]
    ).toMatchObject({ selectable: true, status: "supported" });
  });
});
