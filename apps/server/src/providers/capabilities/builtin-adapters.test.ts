import { afterEach, describe, expect, test } from "bun:test";
import { PROVIDER_CAPABILITY_IDS } from "@atlas/core";
import { BUILTIN_PROVIDER_DEFINITIONS } from "@atlas/core/provider-catalog";
import {
  SubscriptionRuntimeError,
  setChatgptRuntimeForTests,
} from "../subscription";
import type { ChatgptSubscriptionRuntime } from "../subscription/chatgpt/runtime";
import {
  BUILTIN_PROVIDER_ADAPTERS,
  createBuiltinProviderAdapterRegistry,
} from "./builtin-adapters";

afterEach(() => {
  setChatgptRuntimeForTests(null);
});

describe("built-in provider adapter registry", () => {
  test("registers every built-in provider exactly once", () => {
    const registry = createBuiltinProviderAdapterRegistry();
    expect(registry.list()).toHaveLength(BUILTIN_PROVIDER_DEFINITIONS.length);
    expect(
      new Set(registry.list().map((item) => item.manifest.provider.id)).size
    ).toBe(BUILTIN_PROVIDER_DEFINITIONS.length);
  });

  test("distinguishes wired media capabilities from native-only gaps", () => {
    const registry = createBuiltinProviderAdapterRegistry();
    const gemini = registry.require("gemini");
    const fireworks = registry.require("fireworks");
    const imageGeneration =
      gemini.manifest.capabilities[PROVIDER_CAPABILITY_IDS.imageGeneration];

    expect(imageGeneration?.native.status).toBe("supported");
    expect(imageGeneration?.implementation.status).toBe("available");
    expect(
      fireworks.manifest.capabilities[PROVIDER_CAPABILITY_IDS.imageGeneration]
        ?.implementation.status
    ).toBe("available");
    expect(
      fireworks.manifest.capabilities[
        PROVIDER_CAPABILITY_IDS.audioTranscription
      ]?.implementation.status
    ).toBe("available");
    expect(
      registry.require("minimax").manifest.capabilities[
        PROVIDER_CAPABILITY_IDS.audioTranscription
      ]?.native.status
    ).toBe("unsupported");
    expect(
      registry.require("minimax").manifest.capabilities[
        PROVIDER_CAPABILITY_IDS.audioTranscription
      ]?.implementation.status
    ).toBe("unavailable");
    expect(
      registry.require("ollama").manifest.capabilities[
        PROVIDER_CAPABILITY_IDS.audioTranscription
      ]?.native.status
    ).toBe("unknown");
    expect(
      registry.require("ollama").manifest.capabilities[
        PROVIDER_CAPABILITY_IDS.audioTranscription
      ]?.implementation.status
    ).toBe("available");
    expect(
      gemini.manifest.models?.find(
        (model) => model.id === "gemini-2.5-flash-image"
      )?.capabilities[PROVIDER_CAPABILITY_IDS.imageGeneration]?.constraints
        ?.supportedValues?.size
    ).toEqual(["1024x1024", "auto"]);
  });

  test("keeps registration as data rather than provider selection logic", () => {
    expect(
      BUILTIN_PROVIDER_ADAPTERS.every((adapter) => adapter.manifest.provider.id)
    ).toBe(true);
  });

  test("declares native web search and request compatibility in adapter data", () => {
    const registry = createBuiltinProviderAdapterRegistry();
    const nativeSearch = PROVIDER_CAPABILITY_IDS.chatNativeWebSearch;

    expect(
      registry.require("openai").manifest.capabilities[nativeSearch]
        ?.modelDefault.status
    ).toBe("supported");
    expect(registry.require("anthropic").chatCapabilities).toContain(
      nativeSearch
    );
    expect(
      registry.require("gemini").manifest.capabilities[nativeSearch]
        ?.modelDefault.constraints?.supportedValues?.["request.local-tools"]
    ).toEqual([false]);
    expect(
      registry.require("openrouter").manifest.capabilities[nativeSearch]
        ?.modelDefault.status
    ).toBe("unknown");
  });

  test("declares structured-output defaults for adapters that enforce JSON", () => {
    const registry = createBuiltinProviderAdapterRegistry();

    for (const providerId of ["cerebras", "gemini", "openai"]) {
      expect(
        registry.require(providerId).manifest.capabilities[
          PROVIDER_CAPABILITY_IDS.chatStructuredOutput
        ]?.modelDefault.status
      ).toBe("supported");
    }
  });

  test("keeps ChatGPT model capabilities runtime-gated while wiring media handlers", () => {
    const chatgpt = createBuiltinProviderAdapterRegistry().require("chatgpt");
    const reasoning =
      chatgpt.manifest.capabilities[PROVIDER_CAPABILITY_IDS.chatReasoning];
    const imageInput =
      chatgpt.manifest.capabilities[PROVIDER_CAPABILITY_IDS.chatInputImage];
    const imageGeneration =
      chatgpt.manifest.capabilities[PROVIDER_CAPABILITY_IDS.imageGeneration];

    expect(reasoning?.modelDefault.status).toBe("unknown");
    expect(reasoning?.native.status).toBe("supported");
    expect(imageInput?.modelDefault.status).toBe("unknown");
    expect(imageInput?.implementation.status).toBe("available");
    expect(imageGeneration?.modelDefault.status).toBe("unknown");
    expect(imageGeneration?.implementation.status).toBe("available");
  });

  test("declares model discovery on the owning provider adapters", () => {
    const registry = createBuiltinProviderAdapterRegistry();
    const discoveryProviders = registry
      .list()
      .filter((adapter) => adapter.discoverModels)
      .map((adapter) => adapter.manifest.provider.id)
      .sort();

    expect(discoveryProviders).toEqual([
      "chatgpt",
      "claude",
      "fireworks",
      "minimax",
      "minimax_cn",
      "ollama",
      "openai",
      "openai_compatible",
      "opencode_go",
      "xai",
      "zhipu",
      "zhipu_cn",
    ]);
  });

  test("uses live subscription models and preserves the stored default", async () => {
    setChatgptRuntimeForTests({
      listModels: async () => [
        {
          default: true,
          id: "runtime-default",
          name: "Runtime default",
          provider: "chatgpt",
        },
        {
          id: "runtime-selected",
          name: "Runtime selected",
          provider: "chatgpt",
        },
      ],
    } as unknown as ChatgptSubscriptionRuntime);
    const registry = createBuiltinProviderAdapterRegistry();

    const models = await registry.listModelsForInstance(
      {
        apiKey: "",
        createdAt: "2026-08-27T00:00:00.000Z",
        customModels: [{ default: true, id: "runtime-selected" }],
        id: "chatgpt-1",
        label: "ChatGPT Plus",
        type: "chatgpt",
      },
      () => []
    );

    expect(models).toEqual([
      expect.objectContaining({
        default: false,
        id: "runtime-default",
        providerId: "chatgpt-1",
        providerLabel: "ChatGPT Plus",
      }),
      expect.objectContaining({
        default: true,
        id: "runtime-selected",
        providerId: "chatgpt-1",
        providerLabel: "ChatGPT Plus",
      }),
    ]);
  });

  test("executes ChatGPT image generation through the subscription runtime", async () => {
    const calls: unknown[] = [];
    setChatgptRuntimeForTests({
      generateImage: async (input, model) => {
        calls.push({ input, model });
        return {
          data: Uint8Array.from([137, 80, 78, 71]),
          height: 768,
          id: "image-1",
          mediaType: "image/png" as const,
          model: "gpt-image-2",
          revisedPrompt: "Refined atlas",
          status: "completed",
          width: 1024,
        };
      },
    } as unknown as ChatgptSubscriptionRuntime);
    const registry = createBuiltinProviderAdapterRegistry();

    const output = await registry.execute(
      PROVIDER_CAPABILITY_IDS.imageGeneration,
      {
        apiKey: "",
        instance: {
          apiKey: "",
          createdAt: "2026-08-27T00:00:00.000Z",
          id: "chatgpt-1",
          label: "ChatGPT",
          type: "chatgpt",
        },
        model: "runtime-model",
      },
      { prompt: "Draw an atlas", size: "auto" }
    );

    expect(calls).toEqual([
      {
        input: { prompt: "Draw an atlas", size: "auto" },
        model: "runtime-model",
      },
    ]);
    expect(output).toMatchObject({
      mediaType: "image/png",
      model: "gpt-image-2",
      revisedPrompt: "Refined atlas",
      size: "1024x768",
    });
  });

  test("rejects exact-size requests unsupported by native ChatGPT image generation", async () => {
    let called = false;
    setChatgptRuntimeForTests({
      generateImage: async () => {
        called = true;
        throw new Error("must not execute");
      },
    } as unknown as ChatgptSubscriptionRuntime);
    const registry = createBuiltinProviderAdapterRegistry();

    await expect(
      registry.execute(
        PROVIDER_CAPABILITY_IDS.imageGeneration,
        {
          apiKey: "",
          instance: {
            apiKey: "",
            createdAt: "2026-08-27T00:00:00.000Z",
            id: "chatgpt-1",
            label: "ChatGPT",
            type: "chatgpt",
          },
          model: "runtime-model",
        },
        { prompt: "Draw an atlas", size: "1024x1024" }
      )
    ).rejects.toThrow('supports native size "auto" only');
    expect(called).toBe(false);
  });

  test("does not advertise stale subscription models when auth is unavailable", async () => {
    const registry = createBuiltinProviderAdapterRegistry();
    const instance = {
      apiKey: "",
      createdAt: "2026-08-27T00:00:00.000Z",
      customModels: [{ default: true, id: "stale-model" }],
      id: "chatgpt-1",
      label: "ChatGPT Plus",
      type: "chatgpt" as const,
    };

    for (const failure of [
      new SubscriptionRuntimeError(
        "chatgpt",
        "authentication_expired",
        "private credential detail"
      ),
      null,
    ]) {
      setChatgptRuntimeForTests({
        listModels: async () => {
          if (failure) {
            throw failure;
          }
          return [];
        },
      } as unknown as ChatgptSubscriptionRuntime);

      await expect(
        registry.listModelsForInstance(instance, () => [
          {
            id: "stale-model",
            name: "Stale model",
            provider: "chatgpt",
          },
        ])
      ).rejects.toMatchObject({ status: failure ? 409 : 503 });
    }
  });

  test("fails closed instead of returning stored models on runtime errors", async () => {
    const failure = new SubscriptionRuntimeError(
      "chatgpt",
      "runtime_error",
      "Codex model metadata is unavailable."
    );
    setChatgptRuntimeForTests({
      listModels: async () => {
        throw failure;
      },
    } as unknown as ChatgptSubscriptionRuntime);
    const registry = createBuiltinProviderAdapterRegistry();

    await expect(
      registry.listModelsForInstance(
        {
          apiKey: "",
          createdAt: "2026-08-27T00:00:00.000Z",
          customModels: [{ default: true, id: "stale-model" }],
          id: "chatgpt-1",
          label: "ChatGPT Plus",
          type: "chatgpt",
        },
        () => [
          {
            id: "stale-model",
            name: "Stale model",
            provider: "chatgpt",
          },
        ]
      )
    ).rejects.toBe(failure);
  });
});
