import { describe, expect, test } from "bun:test";
import {
  AtlasApiError,
  type CapabilitySupportStatus,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  WORKSPACE_SETTINGS_ID,
} from "@atlas/db";
import { ProviderCapabilityError } from "../providers/capabilities/errors";
import {
  geminiImageGenerationExecutor,
  type ImageGenerationOutput,
  normalizeImageGenerationOutput,
  openAIImageGenerationExecutor,
} from "../providers/capabilities/executors/image-generation";
import { ProviderAdapterRegistry } from "../providers/capabilities/registry";
import { estimateUsageCostUsd } from "../providers/pricing";
import { withMswCassette } from "../testing/llm-msw-cassette";
import { AgentService } from "./agent-service";
import {
  fallbackImageGenerationTokens,
  generateImageWithConfiguredProvider,
  normalizeImageGenerationSize,
  resolveImageGenerationSelection,
  resolveImageGenerationTokens,
} from "./image-generation";
import { LlmUsageTracker } from "./llm-usage-tracker";

const capabilityId = PROVIDER_CAPABILITY_IDS.imageGeneration;
const createdAt = "2026-01-01T00:00:00.000Z";
const imageGenerationSelection = "p-openai::gpt-image-2";
const imagesUrl = "https://api.openai.com/v1/images/generations";
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

const provider = (
  type: ProviderInstance["type"],
  apiKey = "test-key"
): ProviderInstance => ({
  apiKey,
  createdAt,
  id: `p-${type}`,
  label: type,
  type,
});

const openaiConfig = (overrides?: Partial<UserConfig>): UserConfig => ({
  defaultProviderId: "p-openai",
  providers: [provider("openai")],
  ...overrides,
});

function manifest(options: {
  implementation?: "available" | "unavailable";
  model: string;
  modelStatus?: CapabilitySupportStatus;
  providerId: string;
}): ProviderCapabilityManifestV1 {
  return {
    adapterApiVersion: 1,
    capabilities: {
      [capabilityId]: {
        contractVersion: 1,
        implementation: {
          status: options.implementation ?? "available",
        },
        modelDefault: {
          source: "static-manifest",
          status: "unknown",
          verified: false,
        },
        native: {
          source: "static-manifest",
          status: "supported",
          verified: true,
        },
      },
    },
    manifestRevision: "test",
    models: [
      {
        capabilities: {
          [capabilityId]: {
            source: "static-manifest",
            status: options.modelStatus ?? "supported",
            verified: true,
          },
        },
        id: options.model,
      },
    ],
    provider: { displayName: options.providerId, id: options.providerId },
    schemaVersion: 1,
  };
}

function successfulOutput(model: string): ImageGenerationOutput {
  return {
    data: pngBytes,
    mediaType: "image/png",
    model,
    size: "1024x1024",
    usage: { inputTokens: 2, outputTokens: 200 },
  };
}

describe("image-generation capability routing", () => {
  test("returns null when image generation is not configured", () => {
    expect(
      resolveImageGenerationSelection(openaiConfig(), {
        env: {},
        registry: new ProviderAdapterRegistry(),
      })
    ).toBeNull();
  });

  test("resolves an instance-qualified legacy selection through claims", () => {
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [capabilityId]: async () => successfulOutput("gpt-image-2"),
      },
      manifest: manifest({
        model: "gpt-image-2",
        providerId: "openai",
      }),
    });

    const resolved = resolveImageGenerationSelection(
      openaiConfig({ imageModel: imageGenerationSelection }),
      { env: {}, registry }
    );
    expect(resolved?.instance.id).toBe("p-openai");
    expect(resolved?.model).toBe("gpt-image-2");
    expect(resolved?.selection).toBe(imageGenerationSelection);
  });

  test("migrates the former provider-type selection to its instance", () => {
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [capabilityId]: async () => successfulOutput("gpt-image-2"),
      },
      manifest: manifest({ model: "gpt-image-2", providerId: "openai" }),
    });

    const resolved = resolveImageGenerationSelection(
      openaiConfig({ imageModel: "openai::gpt-image-2" }),
      { env: {}, registry }
    );

    expect(resolved?.instance.id).toBe("p-openai");
    expect(resolved?.model).toBe("gpt-image-2");
  });

  test("selects a configured fallback before making a provider request", async () => {
    const calls: string[] = [];
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [capabilityId]: async () => {
          calls.push("openai");
          return successfulOutput("gpt-image-2");
        },
      },
      manifest: manifest({ model: "gpt-image-2", providerId: "openai" }),
    });
    registry.register({
      executors: {
        [capabilityId]: async () => {
          calls.push("gemini");
          return successfulOutput("gemini-2.5-flash-image");
        },
      },
      manifest: manifest({
        model: "gemini-2.5-flash-image",
        providerId: "gemini",
      }),
    });
    const config: UserConfig = {
      capabilityConfig: {
        bindings: {
          [capabilityId]: {
            contractVersion: 1,
            enabled: true,
            fallbacks: [
              {
                modelId: "gemini-2.5-flash-image",
                providerId: "p-gemini",
              },
            ],
            mode: "manual",
            primary: {
              modelId: "gpt-image-2",
              providerId: "p-openai",
            },
          },
        },
        schemaVersion: 1,
      },
      defaultProviderId: "p-openai",
      providers: [provider("openai", ""), provider("gemini")],
    };

    const result = await generateImageWithConfiguredProvider(
      config,
      { prompt: "a red circle" },
      { env: {}, registry }
    );

    expect(result.selection.fallbackIndex).toBe(1);
    expect(result.selection.instance.type).toBe("gemini");
    expect(result.output.model).toBe("gemini-2.5-flash-image");
    expect(calls).toEqual(["gemini"]);
  });

  test("does not retry a fallback after the selected provider request fails", async () => {
    const calls: string[] = [];
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [capabilityId]: async () => {
          calls.push("openai");
          throw new AtlasApiError("upstream failed", 502);
        },
      },
      manifest: manifest({ model: "gpt-image-2", providerId: "openai" }),
    });
    registry.register({
      executors: {
        [capabilityId]: async () => {
          calls.push("gemini");
          return successfulOutput("gemini-2.5-flash-image");
        },
      },
      manifest: manifest({
        model: "gemini-2.5-flash-image",
        providerId: "gemini",
      }),
    });
    const config: UserConfig = {
      capabilityConfig: {
        bindings: {
          [capabilityId]: {
            contractVersion: 1,
            enabled: true,
            fallbacks: [
              {
                modelId: "gemini-2.5-flash-image",
                providerId: "p-gemini",
              },
            ],
            mode: "manual",
            primary: {
              modelId: "gpt-image-2",
              providerId: "p-openai",
            },
          },
        },
        schemaVersion: 1,
      },
      defaultProviderId: "p-openai",
      providers: [provider("openai"), provider("gemini")],
    };

    await expect(
      generateImageWithConfiguredProvider(
        config,
        { prompt: "a red circle" },
        { env: {}, registry }
      )
    ).rejects.toThrow("upstream failed");
    expect(calls).toEqual(["openai"]);
  });

  test("reports native support without an installed Atlas executor", () => {
    const registry = new ProviderAdapterRegistry();
    registry.register({
      manifest: manifest({
        implementation: "unavailable",
        model: "fireworks-image",
        providerId: "fireworks",
      }),
    });
    const fireworks = provider("fireworks");
    fireworks.id = "p-fireworks";
    const config: UserConfig = {
      defaultProviderId: fireworks.id,
      imageModel: `${fireworks.id}::fireworks-image`,
      providers: [fireworks],
    };

    try {
      resolveImageGenerationSelection(config, { env: {}, registry });
      throw new Error("expected capability resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCapabilityError);
      expect((error as ProviderCapabilityError).code).toBe(
        "CAPABILITY_UNSUPPORTED"
      );
      expect((error as ProviderCapabilityError).attempts[0]?.reasons).toEqual([
        "handler-missing",
      ]);
    }
  });

  test("rejects malformed legacy selections", () => {
    expect(() =>
      resolveImageGenerationSelection(
        openaiConfig({ imageModel: "gpt-image-2" }),
        { env: {}, registry: new ProviderAdapterRegistry() }
      )
    ).toThrow("Configured image generation model is invalid");
  });
});

describe("image-generation normalized contract", () => {
  test("defaults size and rejects unknown sizes", () => {
    expect(normalizeImageGenerationSize(undefined)).toBe("1024x1024");
    expect(() => normalizeImageGenerationSize("512x512")).toThrow(
      AtlasApiError
    );
  });

  test("rejects a non-string normalized size instead of silently defaulting", async () => {
    await expect(
      geminiImageGenerationExecutor(
        {
          apiKey: "test-key",
          instance: provider("gemini"),
          model: "gemini-2.5-flash-image",
        },
        { prompt: "a red circle", size: 1024 }
      )
    ).rejects.toThrow("Image generation size must be a string");
  });

  test("maps API usage tokens and falls back when usage is missing", () => {
    expect(
      resolveImageGenerationTokens("hello", "1024x1024", {
        input_tokens: 12,
        output_tokens: 200,
      })
    ).toEqual({ inputTokens: 12, outputTokens: 200 });
    expect(
      resolveImageGenerationTokens("abcd", "1024x1024", undefined)
    ).toEqual(fallbackImageGenerationTokens("abcd", "1024x1024"));
  });

  test("copies non-empty binary output at the adapter boundary", () => {
    const normalized = normalizeImageGenerationOutput(
      successfulOutput("test-image-model")
    );
    expect(normalized.data).toEqual(pngBytes);
    expect(normalized.data).not.toBe(pngBytes);
  });

  test("uses Gemini native image output through generateContent", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requestBody = await request.json();
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    data: Buffer.from(pngBytes).toString("base64"),
                    mimeType: "image/png",
                  },
                },
              ],
              role: "model",
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
        modelVersion: "gemini-2.5-flash-image",
      });
    };

    try {
      const output = await geminiImageGenerationExecutor(
        {
          apiKey: "test-key",
          instance: provider("gemini"),
          model: "gemini-2.5-flash-image",
        },
        { prompt: "a red circle", size: "1024x1024" }
      );

      expect(output).toMatchObject({
        data: pngBytes,
        mediaType: "image/png",
        model: "gemini-2.5-flash-image",
        size: "1024x1024",
      });
      expect(requestBody).toMatchObject({
        contents: [
          {
            parts: [{ text: "a red circle" }],
            role: "user",
          },
        ],
        generationConfig: {
          imageConfig: { aspectRatio: "1:1" },
          responseModalities: ["IMAGE"],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns a structured credential error at the executor boundary", async () => {
    await expect(
      openAIImageGenerationExecutor(
        {
          apiKey: "",
          instance: provider("openai", ""),
          model: "gpt-image-2",
        },
        { prompt: "a red circle" }
      )
    ).rejects.toMatchObject({
      capabilityId,
      code: "CAPABILITY_CREDENTIALS_MISSING",
    });
  });

  test("gracefully rejects a size outside Gemini's partial contract", async () => {
    await expect(
      geminiImageGenerationExecutor(
        {
          apiKey: "test-key",
          instance: provider("gemini"),
          model: "gemini-2.5-flash-image",
        },
        { prompt: "a red circle", size: "1024x1536" }
      )
    ).rejects.toThrow(
      'Gemini image generation does not support Atlas size "1024x1536"'
    );
  });
});

describe("AgentService image generation settings", () => {
  test("round-trips a capability-qualified model and clears it", async () => {
    const db = createInMemoryDatabaseAdapter();
    const service = new AgentService(openaiConfig(), null, db);

    const saved = await service.setImageGenerationSettings({
      model: imageGenerationSelection,
    });
    expect(saved).toEqual({
      imageGeneration: { model: imageGenerationSelection },
    });
    expect(await db.getWorkspaceSettings()).toMatchObject({
      imageModel: imageGenerationSelection,
    });

    const cleared = await service.setImageGenerationSettings({ model: null });
    expect(cleared).toEqual({ imageGeneration: { model: null } });
  });

  test("rejects an unsupported target and preserves stored settings", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [],
      id: WORKSPACE_SETTINGS_ID,
      imageModel: imageGenerationSelection,
      selectedCodingAgentHarness: null,
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });
    const service = new AgentService(
      openaiConfig({ imageModel: imageGenerationSelection }),
      null,
      db
    );

    await expect(
      service.setImageGenerationSettings({
        model: "p-openai::not-an-image-model",
      })
    ).rejects.toThrow(AtlasApiError);
    expect(await db.getWorkspaceSettings()).toMatchObject({
      imageModel: imageGenerationSelection,
    });
  });
});

describe("AgentService image generation usage", () => {
  test("successful generation records model usage and estimated cost", async () => {
    const db = createInMemoryDatabaseAdapter();
    const tracker = await LlmUsageTracker.create(db);
    const service = new AgentService(
      openaiConfig({ imageModel: imageGenerationSelection }),
      null,
      db,
      tracker
    );

    await withMswCassette(
      "image-generation-gpt-image-2",
      () =>
        service.generateImage({
          prompt: "A tiny red circle on white background, minimal",
          size: "1024x1024",
        }),
      { mode: "replay", url: imagesUrl }
    );

    const stats = tracker.getStats();
    expect(stats.requestCount).toBe(1);
    expect(stats.inputTokens).toBe(16);
    expect(stats.outputTokens).toBe(200);
    expect(stats.estimatedCostUsd).toBe(
      estimateUsageCostUsd("gpt-image-2", 16, 200)
    );
  });

  test("failed provider response does not record usage", async () => {
    const db = createInMemoryDatabaseAdapter();
    const tracker = await LlmUsageTracker.create(db);
    const service = new AgentService(
      openaiConfig({ imageModel: imageGenerationSelection }),
      null,
      db,
      tracker
    );

    await expect(
      withMswCassette(
        "image-generation-usage-failure",
        () => service.generateImage({ prompt: "should fail" }),
        { mode: "replay", url: imagesUrl }
      )
    ).rejects.toBeTruthy();
    expect(tracker.getStats().requestCount).toBe(0);
  });

  test("missing provider usage records deterministic fallback tokens", async () => {
    const db = createInMemoryDatabaseAdapter();
    const tracker = await LlmUsageTracker.create(db);
    const service = new AgentService(
      openaiConfig({ imageModel: imageGenerationSelection }),
      null,
      db,
      tracker
    );

    await withMswCassette(
      "image-generation-usage-no-usage-field",
      () => service.generateImage({ prompt: "abcd", size: "1024x1024" }),
      { mode: "replay", url: imagesUrl }
    );

    const fallback = fallbackImageGenerationTokens("abcd", "1024x1024");
    expect(tracker.getStats()).toMatchObject({
      inputTokens: fallback.inputTokens,
      outputTokens: fallback.outputTokens,
      requestCount: 1,
    });
  });
});
