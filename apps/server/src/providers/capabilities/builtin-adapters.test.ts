import { describe, expect, test } from "bun:test";
import { PROVIDER_CAPABILITY_IDS } from "@atlas/core";
import {
  BUILTIN_PROVIDER_ADAPTERS,
  createBuiltinProviderAdapterRegistry,
} from "./builtin-adapters";

describe("built-in provider adapter registry", () => {
  test("registers every built-in provider exactly once", () => {
    const registry = createBuiltinProviderAdapterRegistry();
    expect(registry.list()).toHaveLength(16);
    expect(
      new Set(registry.list().map((item) => item.manifest.provider.id)).size
    ).toBe(16);
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

  test("declares model discovery on the owning provider adapters", () => {
    const registry = createBuiltinProviderAdapterRegistry();
    const discoveryProviders = registry
      .list()
      .filter((adapter) => adapter.discoverModels)
      .map((adapter) => adapter.manifest.provider.id)
      .sort();

    expect(discoveryProviders).toEqual([
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
});
