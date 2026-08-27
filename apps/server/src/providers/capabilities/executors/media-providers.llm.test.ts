/**
 * Record one real HTTP exchange per provider × capability, then replay offline.
 *
 * Record (requires the matching provider credential):
 *   LLM_VCR_MODE=record bun test apps/server/src/providers/capabilities/executors/media-providers.llm.test.ts -t "fireworks audio"
 *
 * Replay is registered only after a cassette file is committed. Missing
 * cassettes are not skipped-to-green; they simply have no replay test yet,
 * matching Gemini image generation until the first live recording lands.
 *
 * Record mode fails fast when credentials are missing and never writes a
 * synthetic cassette.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadUserConfig,
  PROVIDER_CAPABILITY_IDS,
  type ProviderName,
  type UserConfig,
} from "@atlas/core";
import {
  cassetteFilePath,
  loadCassette,
  withMswCassette,
} from "../../../testing/llm-msw-cassette";
import { readApiKeyForInstance } from "../../create";
import { builtinProviderAdapterRegistry } from "../builtin-adapters";
import { executeConfiguredCapability } from "../runtime";
import type { AudioTranscriptionOutput } from "./audio-transcription";
import type { ImageGenerationOutput } from "./image-generation";

const audioFixturePath = join(
  import.meta.dir,
  "../../../testing/fixtures/audio-transcription.mp3"
);
const isRecording = process.env.LLM_VCR_MODE?.trim() === "record";

interface MediaCase {
  capability: "audio" | "image";
  cassette: string;
  envVars: readonly string[];
  model: string;
  provider: ProviderName;
  url: string | RegExp;
}

const cases: readonly MediaCase[] = [
  {
    capability: "audio",
    cassette: "audio-transcription-fireworks-whisper-v3",
    envVars: ["FIREWORKS_API_KEY"],
    model: "whisper-v3",
    provider: "fireworks",
    url: /^https:\/\/audio-(prod|turbo)\.api\.fireworks\.ai\/v1\/audio\/transcriptions$/,
  },
  {
    capability: "image",
    cassette: "image-generation-fireworks-flux-1-schnell-fp8",
    envVars: ["FIREWORKS_API_KEY"],
    model: "accounts/fireworks/models/flux-1-schnell-fp8",
    provider: "fireworks",
    url: /^https:\/\/api\.fireworks\.ai\/inference\/v1\/.+$/,
  },
  {
    capability: "audio",
    cassette: "audio-transcription-cloudflare-whisper",
    envVars: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
    model: "@cf/openai/whisper",
    provider: "cloudflare",
    url: /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/ai\/run\/@cf\/openai\/whisper/,
  },
  {
    capability: "image",
    cassette: "image-generation-cloudflare-flux-1-schnell",
    envVars: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
    model: "@cf/black-forest-labs/flux-1-schnell",
    provider: "cloudflare",
    url: /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell/,
  },
  {
    capability: "audio",
    cassette: "audio-transcription-openrouter-whisper-large-v3",
    envVars: ["OPENROUTER_API_KEY"],
    model: "openai/whisper-large-v3",
    provider: "openrouter",
    url: "https://openrouter.ai/api/v1/audio/transcriptions",
  },
  {
    capability: "image",
    cassette: "image-generation-openrouter-flux-1-schnell",
    envVars: ["OPENROUTER_API_KEY"],
    model: "black-forest-labs/flux-1-schnell",
    provider: "openrouter",
    url: "https://openrouter.ai/api/v1/images",
  },
  {
    capability: "image",
    cassette: "image-generation-minimax-image-01",
    envVars: ["MINIMAX_API_KEY"],
    model: "image-01",
    provider: "minimax",
    url: /^https:\/\/api\.minimax\.io\/v1\/image_generation$/,
  },
  {
    capability: "image",
    cassette: "image-generation-minimax-cn-image-01",
    envVars: ["MINIMAX_CN_API_KEY"],
    model: "image-01",
    provider: "minimax_cn",
    url: /^https:\/\/api\.minimaxi\.com\/v1\/image_generation$/,
  },
  {
    capability: "audio",
    cassette: "audio-transcription-xai-grok-stt",
    envVars: ["XAI_API_KEY"],
    model: "grok-stt",
    provider: "xai",
    url: "https://api.x.ai/v1/stt",
  },
  {
    capability: "image",
    cassette: "image-generation-xai-grok-imagine-image-2",
    envVars: ["XAI_API_KEY"],
    model: "grok-imagine-image-2.0",
    provider: "xai",
    url: "https://api.x.ai/v1/images/generations",
  },
  {
    capability: "audio",
    cassette: "audio-transcription-zhipu-glm-asr-2512",
    envVars: ["ZHIPU_API_KEY"],
    model: "glm-asr-2512",
    provider: "zhipu",
    url: "https://api.z.ai/api/paas/v4/audio/transcriptions",
  },
  {
    capability: "image",
    cassette: "image-generation-zhipu-glm-image",
    envVars: ["ZHIPU_API_KEY"],
    model: "glm-image",
    provider: "zhipu",
    url: "https://api.z.ai/api/paas/v4/images/generations",
  },
  {
    capability: "audio",
    cassette: "audio-transcription-zhipu-cn-glm-asr-2512",
    envVars: ["ZHIPU_CN_API_KEY"],
    model: "glm-asr-2512",
    provider: "zhipu_cn",
    url: "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions",
  },
  {
    capability: "image",
    cassette: "image-generation-zhipu-cn-glm-image",
    envVars: ["ZHIPU_CN_API_KEY"],
    model: "glm-image",
    provider: "zhipu_cn",
    url: "https://open.bigmodel.cn/api/paas/v4/images/generations",
  },
  {
    capability: "image",
    cassette: "image-generation-ollama-z-image-turbo",
    envVars: [],
    model: "x/z-image-turbo",
    provider: "ollama",
    url: /^https?:\/\/127\.0\.0\.1:11434\/v1\/images\/generations$|^https?:\/\/localhost:11434\/v1\/images\/generations$/,
  },
];

function capabilityIdFor(kind: MediaCase["capability"]) {
  return kind === "audio"
    ? PROVIDER_CAPABILITY_IDS.audioTranscription
    : PROVIDER_CAPABILITY_IDS.imageGeneration;
}

async function resolveApiKey(
  provider: ProviderName,
  envVars: readonly string[]
): Promise<string> {
  for (const name of envVars) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  const config = await loadUserConfig();
  const instance = config?.providers.find((item) => item.type === provider);
  const configured = instance
    ? readApiKeyForInstance(instance, process.env)?.trim()
    : undefined;
  if (configured) {
    return configured;
  }
  if (provider === "ollama") {
    return "";
  }
  throw new Error(
    `Missing ${provider} credential. Record with ${envVars.join(" / ") || "a running local endpoint"}.`
  );
}

function createConfig(
  testCase: MediaCase,
  apiKey: string,
  accountId?: string
): UserConfig {
  const capabilityId = capabilityIdFor(testCase.capability);
  const providerId = `${testCase.provider}-cassette`;
  return {
    capabilityConfig: {
      bindings: {
        [capabilityId]: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [],
          mode: "manual",
          primary: { modelId: testCase.model, providerId },
        },
      },
      schemaVersion: 1,
    },
    defaultProviderId: providerId,
    providers: [
      {
        apiKey,
        createdAt: "2026-08-27T00:00:00.000Z",
        ...(testCase.provider === "cloudflare" && accountId
          ? {
              baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
            }
          : {}),
        ...(testCase.provider === "ollama"
          ? { baseUrl: "http://127.0.0.1:11434/v1", hostMode: "local" as const }
          : {}),
        ...(testCase.provider === "minimax"
          ? { baseUrl: "https://api.minimax.io/v1" }
          : {}),
        ...(testCase.provider === "minimax_cn"
          ? { baseUrl: "https://api.minimaxi.com/v1" }
          : {}),
        ...(testCase.provider === "xai"
          ? { baseUrl: "https://api.x.ai/v1" }
          : {}),
        ...(testCase.provider === "zhipu"
          ? { baseUrl: "https://api.z.ai/api/paas/v4" }
          : {}),
        ...(testCase.provider === "zhipu_cn"
          ? { baseUrl: "https://open.bigmodel.cn/api/paas/v4" }
          : {}),
        customModels: [
          {
            capabilities: {
              [capabilityId]: {
                source: "admin-override",
                status: "supported",
                verified: false,
              },
            },
            id: testCase.model,
          },
        ],
        id: providerId,
        label: `${testCase.provider} cassette`,
        type: testCase.provider,
      },
    ],
  };
}

async function runCase(testCase: MediaCase): Promise<void> {
  const cassettePath = cassetteFilePath(testCase.cassette);
  const existing = await loadCassette(cassettePath);
  if (!isRecording) {
    expect(existing).not.toBeNull();
  }

  const apiKey = isRecording
    ? await resolveApiKey(testCase.provider, testCase.envVars)
    : "cassette-replay-key";
  const accountId = isRecording
    ? process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
    : "cassette-account";
  const config = createConfig(testCase, apiKey, accountId);

  if (testCase.capability === "audio") {
    const bytes = new Uint8Array(
      await Bun.file(audioFixturePath).arrayBuffer()
    );
    const result = await withMswCassette(
      testCase.cassette,
      () =>
        executeConfiguredCapability<AudioTranscriptionOutput>({
          capabilityId: capabilityIdFor("audio"),
          config,
          input: {
            bytes,
            filename: "audio-transcription.mp3",
            mediaType: "audio/mpeg",
          },
          readApiKey: (instance) => instance.apiKey,
          registry: builtinProviderAdapterRegistry,
        }),
      { mode: isRecording ? "record" : "replay", url: testCase.url }
    );
    expect(result.selection.instance.type).toBe(testCase.provider);
    expect(result.output.text.trim().length).toBeGreaterThan(0);
    return;
  }

  const result = await withMswCassette(
    testCase.cassette,
    () =>
      executeConfiguredCapability<ImageGenerationOutput>({
        capabilityId: capabilityIdFor("image"),
        config,
        input: {
          prompt: "A tiny red circle on a plain white background, minimal icon",
          size: "1024x1024",
        },
        readApiKey: (instance) => instance.apiKey,
        registry: builtinProviderAdapterRegistry,
      }),
    { mode: isRecording ? "record" : "replay", url: testCase.url }
  );
  expect(result.selection.instance.type).toBe(testCase.provider);
  expect(result.output.mediaType).toMatch(/^image\//);
  expect(result.output.data.byteLength).toBeGreaterThan(0);
}

test("registers live media cases for recording without inventing cassettes", () => {
  expect(cases.length).toBeGreaterThan(0);
});

for (const testCase of cases) {
  const title = `${testCase.provider} ${testCase.capability} through configured capability routing`;
  if (isRecording) {
    test(title, async () => {
      await runCase(testCase);
    }, 120_000);
    continue;
  }

  if (existsSync(cassetteFilePath(testCase.cassette))) {
    test(title, async () => {
      await runCase(testCase);
    });
  }
}
