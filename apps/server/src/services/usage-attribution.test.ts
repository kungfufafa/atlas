import { describe, expect, test } from "bun:test";
import {
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type UserConfig,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ProviderAdapterRegistry } from "../providers";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-usage-attribution-");

const createdAt = "2026-08-27T00:00:00.000Z";
const ORG_ID = "org_usage_attribution";
const PROVIDER_ID = "prov-openai";
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);

function supportedClaim() {
  return {
    source: "static-manifest",
    status: "supported",
    verified: true,
  } as const;
}

function capabilityEntry(label: string) {
  return {
    contractVersion: 1 as const,
    implementation: { status: "available" as const },
    metadata: {
      description: `${label}.`,
      label,
      routable: true,
    },
    modelDefault: supportedClaim(),
    native: supportedClaim(),
  };
}

function buildRegistry(): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry();
  const manifest: ProviderCapabilityManifestV1 = {
    adapterApiVersion: 1,
    capabilities: {
      [PROVIDER_CAPABILITY_IDS.audioTranscription]:
        capabilityEntry("Transcription"),
      [PROVIDER_CAPABILITY_IDS.imageGeneration]:
        capabilityEntry("Image generation"),
    },
    manifestRevision: "test",
    provider: { displayName: "OpenAI (test)", id: "openai" },
    schemaVersion: 1,
  };
  registry.register({
    executors: {
      [PROVIDER_CAPABILITY_IDS.audioTranscription]: async () => ({
        text: "hello from audio",
      }),
      [PROVIDER_CAPABILITY_IDS.imageGeneration]: async () => ({
        data: PNG_BYTES,
        mediaType: "image/png",
        model: "gpt-image-2",
        size: "1024x1024",
      }),
    },
    manifest,
  });
  return registry;
}

function binding(modelId: string) {
  return {
    contractVersion: 1 as const,
    enabled: true,
    fallbacks: [],
    mode: "manual" as const,
    primary: { modelId, providerId: PROVIDER_ID },
  };
}

function orgConfig(): UserConfig {
  return {
    capabilityConfig: {
      bindings: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: binding("whisper-1"),
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: binding("gpt-image-2"),
      },
      schemaVersion: 1,
    },
    defaultProviderId: PROVIDER_ID,
    providers: [
      {
        apiKey: "sk-test",
        createdAt,
        id: PROVIDER_ID,
        label: "OpenAI",
        type: "openai",
      },
    ],
  };
}

async function flushFireAndForgetWrites() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function setup() {
  const db = createInMemoryDatabaseAdapter();
  await db.upsertOrgAiConfig({
    config: orgConfig(),
    orgId: ORG_ID,
    updatedAt: createdAt,
  });
  const service = new AgentService(null, null, db, undefined, buildRegistry());
  return { db, service };
}

describe("capability usage attribution", () => {
  test("transcription records a workspace/user-attributed request", async () => {
    const { db, service } = await setup();

    const response = await service.transcribeAudioForOrg(
      ORG_ID,
      {
        data: Buffer.from("fake audio").toString("base64"),
        filename: "note.ogg",
        mediaType: "audio/ogg",
      },
      { userId: "user_listener" }
    );
    expect(response.text).toBe("hello from audio");
    await flushFireAndForgetWrites();

    const byCapability = await db.aggregateLlmUsage({
      groupBy: "capability",
      orgId: ORG_ID,
    });
    expect(byCapability).toHaveLength(1);
    expect(byCapability[0]).toMatchObject({
      key: PROVIDER_CAPABILITY_IDS.audioTranscription,
      requestCount: 1,
    });

    const byUser = await db.aggregateLlmUsage({
      groupBy: "user",
      orgId: ORG_ID,
    });
    expect(byUser[0]?.key).toBe("user_listener");

    const byProvider = await db.aggregateLlmUsage({
      groupBy: "provider",
      orgId: ORG_ID,
    });
    expect(byProvider[0]?.key).toBe("openai");
  });

  test("image generation attributes the requesting user, not unknown", async () => {
    const { db, service } = await setup();

    const response = await service.generateImageForOrg(
      ORG_ID,
      { prompt: "a lighthouse" },
      { userId: "user_painter" }
    );
    expect(response.model).toBe("gpt-image-2");
    await flushFireAndForgetWrites();

    const byUser = await db.aggregateLlmUsage({
      groupBy: "user",
      orgId: ORG_ID,
    });
    expect(byUser).toHaveLength(1);
    expect(byUser[0]).toMatchObject({ key: "user_painter", requestCount: 1 });

    const byCapability = await db.aggregateLlmUsage({
      groupBy: "capability",
      orgId: ORG_ID,
    });
    expect(byCapability[0]?.key).toBe(PROVIDER_CAPABILITY_IDS.imageGeneration);
  });

  test("image generation without a caller identity still counts the request", async () => {
    const { db, service } = await setup();

    await service.generateImageForOrg(ORG_ID, { prompt: "a lighthouse" });
    await flushFireAndForgetWrites();

    const byUser = await db.aggregateLlmUsage({
      groupBy: "user",
      orgId: ORG_ID,
    });
    expect(byUser).toHaveLength(1);
    expect(byUser[0]).toMatchObject({ key: "unknown", requestCount: 1 });
  });
});
