/**
 * The OpenAI image-generation request is recorded once and replayed offline.
 * Gemini has a record-only harness because no successful Gemini cassette is
 * committed yet. Record mode fails fast when provider credentials or paid
 * image-generation quota are unavailable; it never creates synthetic evidence.
 *
 * Record one provider test at a time with its matching credential, for example:
 *   LLM_VCR_MODE=record bun test apps/server/src/services/image-generation.llm.test.ts -t "real Gemini"
 *
 * Record all tests (requires both provider credentials):
 *   LLM_VCR_MODE=record bun test apps/server/src/services/image-generation.llm.test.ts
 *
 * Replay (requires no provider credential or network):
 *   LLM_VCR_MODE=replay bun test apps/server/src/services/image-generation.llm.test.ts
 */
import { expect, test } from "bun:test";
import {
  loadUserConfig,
  PROVIDER_CAPABILITY_IDS,
  type UserConfig,
} from "@atlas/core";
import { builtinProviderAdapterRegistry } from "../providers/capabilities/builtin-adapters";
import type { ImageGenerationOutput } from "../providers/capabilities/executors/image-generation";
import { executeConfiguredCapability } from "../providers/capabilities/runtime";
import { readApiKeyForInstance } from "../providers/create";
import {
  cassetteFilePath,
  loadCassette,
  withMswCassette,
} from "../testing/llm-msw-cassette";

const capabilityId = PROVIDER_CAPABILITY_IDS.imageGeneration;
const cassetteName = "image-generation-gpt-image-2";
const imagesUrl = "https://api.openai.com/v1/images/generations";
const model = "gpt-image-2";
const geminiCassetteName = "image-generation-gemini-2-5-flash-image";
const geminiGenerateContentUrl =
  /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent(?:\?.*)?$/;
const geminiModel = "gemini-2.5-flash-image";

function capabilityConfig(apiKey: string): UserConfig {
  return {
    capabilityConfig: {
      bindings: {
        [capabilityId]: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [],
          mode: "manual",
          primary: { modelId: model, providerId: "openai-cassette" },
        },
      },
      schemaVersion: 1,
    },
    defaultProviderId: "openai-cassette",
    providers: [
      {
        apiKey,
        createdAt: "2026-08-27T00:00:00.000Z",
        id: "openai-cassette",
        label: "OpenAI cassette",
        type: "openai",
      },
    ],
  };
}

function geminiCapabilityConfig(apiKey: string): UserConfig {
  return {
    capabilityConfig: {
      bindings: {
        [capabilityId]: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [],
          mode: "manual",
          primary: {
            modelId: geminiModel,
            providerId: "gemini-cassette",
          },
        },
      },
      schemaVersion: 1,
    },
    defaultProviderId: "gemini-cassette",
    providers: [
      {
        apiKey,
        createdAt: "2026-08-27T00:00:00.000Z",
        id: "gemini-cassette",
        label: "Gemini cassette",
        type: "gemini",
      },
    ],
  };
}

async function resolveOpenAIKeyForRecording(): Promise<string> {
  const config = await loadUserConfig();
  const configured = config?.providers.find(
    (provider) => provider.type === "openai"
  );
  const configuredKey = configured
    ? readApiKeyForInstance(configured, process.env)?.trim()
    : undefined;
  const key = configuredKey || process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      `OpenAI credential is required to record ${cassetteFilePath(cassetteName)}.`
    );
  }
  return key;
}

async function resolveGeminiKeyForRecording(): Promise<string> {
  const config = await loadUserConfig();
  const configured = config?.providers.find(
    (provider) => provider.type === "gemini"
  );
  const configuredKey = configured
    ? readApiKeyForInstance(configured, process.env)?.trim()
    : undefined;
  const key = configuredKey || process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      `Gemini credential is required to record ${cassetteFilePath(geminiCassetteName)}.`
    );
  }
  return key;
}

test("generates an image through configured capability routing under offline replay", async () => {
  const cassettePath = cassetteFilePath(cassetteName);
  const cassette = await loadCassette(cassettePath);
  const isRecording = process.env.LLM_VCR_MODE?.trim() === "record";
  if (!isRecording) {
    expect(cassette).not.toBeNull();
  }
  const apiKey = isRecording
    ? await resolveOpenAIKeyForRecording()
    : "cassette-replay-key";

  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const result = await withMswCassette(
      cassetteName,
      () =>
        executeConfiguredCapability<ImageGenerationOutput>({
          capabilityId,
          config: capabilityConfig(apiKey),
          input: {
            prompt: "A tiny red circle on white background, minimal",
            size: "1024x1024",
          },
          readApiKey: (instance) => instance.apiKey,
          registry: builtinProviderAdapterRegistry,
        }),
      { mode: isRecording ? "record" : "replay", url: imagesUrl }
    );

    expect(result.selection.instance.type).toBe("openai");
    expect(result.selection.model).toBe(model);
    expect(result.output.model).toBe(model);
    expect(result.output.mediaType).toBe("image/png");
    expect(result.output.data.byteLength).toBeGreaterThan(0);
    expect(result.output.data[0]).toBe(0x89);
    expect(result.output.data[1]).toBe(0x50);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }

  const serializedCassette = await Bun.file(cassettePath).text();
  expect(serializedCassette).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
});

if (process.env.LLM_VCR_MODE?.trim() === "record") {
  test("generates a real Gemini image through configured capability routing", async () => {
    const cassettePath = cassetteFilePath(geminiCassetteName);
    const apiKey = await resolveGeminiKeyForRecording();

    const result = await withMswCassette(
      geminiCassetteName,
      () =>
        executeConfiguredCapability<ImageGenerationOutput>({
          capabilityId,
          config: geminiCapabilityConfig(apiKey),
          input: {
            prompt:
              "A tiny red circle on a plain white background, minimal icon",
            size: "1024x1024",
          },
          readApiKey: (instance) => instance.apiKey,
          registry: builtinProviderAdapterRegistry,
        }),
      { mode: "record", url: geminiGenerateContentUrl }
    );

    expect(result.selection.instance.type).toBe("gemini");
    expect(result.selection.model).toBe(geminiModel);
    expect(result.output.model).toBe(geminiModel);
    expect(result.output.mediaType).toMatch(/^image\//);
    expect(result.output.data.byteLength).toBeGreaterThan(1024);

    const recorded = await loadCassette(cassettePath);
    const requestBody = JSON.stringify(
      recorded?.exchanges?.[0]?.request.body ?? recorded?.request?.body
    );
    expect(requestBody).toContain('"responseModalities":["IMAGE"]');
    expect(requestBody).toContain('"aspectRatio":"1:1"');

    const serializedCassette = await Bun.file(cassettePath).text();
    expect(serializedCassette).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
  }, 60_000);
}
