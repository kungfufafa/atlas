/**
 * Real Gemini image-input call recorded once and replayed offline thereafter.
 *
 * Record (needs a configured Gemini credential or GEMINI_API_KEY):
 *   LLM_VCR_MODE=record bun test apps/server/src/services/image-vision-fallback.llm.test.ts
 *
 * Replay (default when the cassette exists):
 *   bun test apps/server/src/services/image-vision-fallback.llm.test.ts
 */
import { expect, test } from "bun:test";
import {
  loadUserConfig,
  PROVIDER_CAPABILITY_IDS,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import { builtinProviderAdapterRegistry } from "../providers/capabilities";
import { readApiKeyForInstance } from "../providers/create";
import {
  cassetteFilePath,
  loadCassette,
  withMswCassette,
} from "../testing/llm-msw-cassette";
import { describeImagesWithConfiguredVisionModel } from "./image-vision-fallback";

const cassetteName = "vision-understanding-gemini-3-flash-preview";
const model = "gemini-3-flash-preview";
const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const geminiGenerateContentUrl =
  /https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/;

async function resolveGeminiApiKey(): Promise<string> {
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
      `Gemini credential is required to record ${cassetteFilePath(cassetteName)}. Configure Gemini or set GEMINI_API_KEY, then run LLM_VCR_MODE=record bun test apps/server/src/services/image-vision-fallback.llm.test.ts.`
    );
  }
  return key;
}

function capabilityConfig(apiKey: string): UserConfig {
  const instance: ProviderInstance = {
    apiKey,
    createdAt: "2026-08-27T00:00:00.000Z",
    id: "cassette-gemini",
    label: "Gemini cassette",
    type: "gemini",
  };
  return {
    capabilityConfig: {
      bindings: {
        [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [],
          mode: "manual",
          primary: { modelId: model, providerId: instance.id },
        },
      },
      schemaVersion: 1,
    },
    defaultProviderId: instance.id,
    providers: [instance],
  };
}

test("parses a real inline image through registry/runtime under cassette replay", async () => {
  const cassettePath = cassetteFilePath(cassetteName);
  const existing = await loadCassette(cassettePath);
  const isRecording = process.env.LLM_VCR_MODE?.trim() === "record";
  if (!isRecording) {
    expect(existing).not.toBeNull();
  }
  const apiKey = isRecording
    ? await resolveGeminiApiKey()
    : "cassette-replay-key";

  const descriptions = await withMswCassette(
    cassetteName,
    () =>
      describeImagesWithConfiguredVisionModel(
        capabilityConfig(apiKey),
        [{ data: tinyPngBase64, mediaType: "image/png", type: "image" }],
        { registry: builtinProviderAdapterRegistry }
      ),
    {
      mode: isRecording ? "record" : "replay",
      url: geminiGenerateContentUrl,
    }
  );

  expect(descriptions).toHaveLength(1);
  expect(descriptions[0]?.trim().length).toBeGreaterThan(0);

  const recorded = await loadCassette(cassettePath);
  expect(recorded).not.toBeNull();
  const recordedRequest = JSON.stringify(
    recorded?.exchanges?.[0]?.request.body ?? recorded?.request?.body
  );
  expect(recordedRequest).toContain("inlineData");
  expect(recordedRequest).toContain(tinyPngBase64);
}, 30_000);
