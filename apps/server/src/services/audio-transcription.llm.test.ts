/**
 * Live Gemini audio-transcription cassette test.
 *
 * Record (requires a configured Gemini provider or GEMINI_API_KEY):
 *   LLM_VCR_MODE=record bun test apps/server/src/services/audio-transcription.llm.test.ts
 *
 * Replay (offline and CI-safe once the cassette is committed):
 *   bun test apps/server/src/services/audio-transcription.llm.test.ts
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  loadUserConfig,
  PROVIDER_CAPABILITY_IDS,
  type UserConfig,
} from "@atlas/core";
import { builtinProviderAdapterRegistry } from "../providers/capabilities/builtin-adapters";
import type { AudioTranscriptionOutput } from "../providers/capabilities/executors/audio-transcription";
import { executeConfiguredCapability } from "../providers/capabilities/runtime";
import { readApiKeyForInstance } from "../providers/create";
import {
  cassetteFilePath,
  loadCassette,
  withMswCassette,
} from "../testing/llm-msw-cassette";

const capabilityId = PROVIDER_CAPABILITY_IDS.audioTranscription;
const cassetteName = "audio-transcription-gemini-3-flash-preview";
const geminiGenerateContentUrl =
  /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent(?:\?.*)?$/;
const model = "gemini-3-flash-preview";
const fixturePath = join(
  import.meta.dir,
  "../testing/fixtures/audio-transcription.mp3"
);

async function resolveGeminiApiKey(): Promise<string> {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }

  const config = await loadUserConfig();
  const instance = config?.providers.find(
    (provider) => provider.type === "gemini"
  );
  const configuredKey = instance
    ? readApiKeyForInstance(instance, process.env)?.trim()
    : undefined;
  if (!configuredKey) {
    throw new Error(
      `Missing Gemini credential. Record ${cassetteName} with GEMINI_API_KEY or a configured Gemini provider.`
    );
  }
  return configuredKey;
}

function createConfig(apiKey: string): UserConfig {
  return {
    capabilityConfig: {
      bindings: {
        [capabilityId]: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [],
          mode: "manual",
          primary: { modelId: model, providerId: "gemini-cassette" },
        },
      },
      schemaVersion: 1,
    },
    defaultProviderId: "gemini-cassette",
    providers: [
      {
        apiKey,
        createdAt: "2026-08-27T00:00:00.000Z",
        customModels: [
          {
            capabilities: {
              [capabilityId]: {
                source: "admin-override",
                status: "supported",
                verified: false,
              },
            },
            id: model,
          },
        ],
        id: "gemini-cassette",
        label: "Gemini cassette",
        type: "gemini",
      },
    ],
  };
}

test("transcribes committed speech through configured capability routing", async () => {
  const cassettePath = cassetteFilePath(cassetteName);
  const existingCassette = await loadCassette(cassettePath);
  const isRecording = process.env.LLM_VCR_MODE?.trim() === "record";
  if (!isRecording) {
    expect(existingCassette).not.toBeNull();
  }
  const apiKey = isRecording
    ? await resolveGeminiApiKey()
    : "cassette-replay-key";
  const bytes = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);

  const result = await withMswCassette(
    cassetteName,
    () =>
      executeConfiguredCapability<AudioTranscriptionOutput>({
        capabilityId,
        config: createConfig(apiKey),
        input: {
          bytes,
          filename: "audio-transcription.mp3",
          mediaType: "audio/mpeg",
        },
        readApiKey: (instance) => instance.apiKey,
        registry: builtinProviderAdapterRegistry,
      }),
    {
      mode: isRecording ? "record" : "replay",
      url: geminiGenerateContentUrl,
    }
  );

  expect(result.selection.instance.type).toBe("gemini");
  expect(result.selection.model).toBe(model);
  expect(result.output.text.toLowerCase()).toContain("atlas");
  expect(result.output.text.toLowerCase()).toContain("audio capability test");
});
