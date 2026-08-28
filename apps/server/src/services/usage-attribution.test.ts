import { describe, expect, test } from "bun:test";
import {
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type UserConfig,
} from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  type DatabaseAdapter,
  type StoredProfileRecord,
} from "@atlas/db";
import { ProviderAdapterRegistry } from "../providers";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";
import {
  USER_REQUEST_LIMIT_CODE,
  WORKSPACE_BUDGET_LIMIT_CODE,
} from "./usage-limit-service";

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

async function seedSpend(
  db: DatabaseAdapter,
  orgId: string,
  options: {
    estimatedCostUsd?: number;
    providerType?: string;
    requestCount?: number;
    userId?: string;
  } = {}
) {
  await db.incrementLlmUsageDaily(
    {
      capability: "chat.completion",
      modelId: "model-x",
      orgId,
      profileId: "p1",
      providerCredentialId: "cred_seed",
      providerType: options.providerType ?? "openai",
      userId: options.userId ?? "user_seed",
    },
    {
      estimatedCostUsd: options.estimatedCostUsd ?? 0,
      inputTokens: 10,
      outputTokens: 5,
      requestCount: options.requestCount ?? 1,
    }
  );
}

async function setPolicy(
  db: DatabaseAdapter,
  orgId: string,
  policy: {
    enforceBudget?: boolean;
    monthlyLimitUsd?: number;
    perUserMonthlyRequests?: number;
  }
) {
  await db.upsertOrgUsageBudget({
    enforceBudget: policy.enforceBudget ?? false,
    monthlyLimitUsd: policy.monthlyLimitUsd ?? 0,
    orgId,
    perUserMonthlyRequests: policy.perUserMonthlyRequests ?? 0,
    updatedAt: createdAt,
  });
}

describe("usage limit enforcement at execution boundaries", () => {
  test("enforced budget rejects API image generation with a clear 429", async () => {
    const { db, service } = await setup();
    await setPolicy(db, ORG_ID, { enforceBudget: true, monthlyLimitUsd: 1 });
    await seedSpend(db, ORG_ID, { estimatedCostUsd: 1.5 });

    await expect(
      service.generateImageForOrg(
        ORG_ID,
        { prompt: "a lighthouse" },
        { userId: "user_painter" }
      )
    ).rejects.toMatchObject({
      path: WORKSPACE_BUDGET_LIMIT_CODE,
      status: 429,
    });

    // The rejected request must not be recorded as usage.
    await flushFireAndForgetWrites();
    const byCapability = await db.aggregateLlmUsage({
      groupBy: "capability",
      orgId: ORG_ID,
    });
    expect(
      byCapability.find(
        (row) => row.key === PROVIDER_CAPABILITY_IDS.imageGeneration
      )
    ).toBeUndefined();
  });

  test("per-user request limit rejects transcription for the exhausted user only", async () => {
    const { db, service } = await setup();
    await setPolicy(db, ORG_ID, { perUserMonthlyRequests: 3 });
    await seedSpend(db, ORG_ID, { requestCount: 3, userId: "user_heavy" });

    const request = {
      data: Buffer.from("fake audio").toString("base64"),
      filename: "note.ogg",
      mediaType: "audio/ogg",
    };
    await expect(
      service.transcribeAudioForOrg(ORG_ID, request, {
        userId: "user_heavy",
      })
    ).rejects.toMatchObject({ path: USER_REQUEST_LIMIT_CODE, status: 429 });

    const allowed = await service.transcribeAudioForOrg(ORG_ID, request, {
      userId: "user_light",
    });
    expect(allowed.text).toBe("hello from audio");
  });
});

describe("session turn usage gate", () => {
  function profileRecord(orgId: string, id: string): StoredProfileRecord {
    return {
      createdAt,
      id,
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Default",
      orgId,
      systemPrompt: "You are helpful.",
      updatedAt: createdAt,
    };
  }

  async function setupSessionOrg(options: {
    orgId: string;
    provider: "subscription" | "api";
  }) {
    const db = createInMemoryDatabaseAdapter();
    const providers: UserConfig["providers"] =
      options.provider === "subscription"
        ? [
            {
              apiKey: "",
              createdAt,
              customModels: [{ default: true, id: "claude-sonnet-4-6" }],
              id: "prov-claude-sub",
              label: "Claude",
              type: "claude",
            },
          ]
        : [
            {
              apiKey: "sk-test",
              createdAt,
              id: "prov-openai-key",
              label: "OpenAI",
              type: "openai",
            },
          ];
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: providers[0]?.id ?? null,
        providers,
      },
      orgId: options.orgId,
      updatedAt: createdAt,
    });
    const profileId = `profile_${options.orgId}`;
    await db.upsertProfile(profileRecord(options.orgId, profileId));
    const service = new AgentService(null, null, db);
    const sessionId = `session_${options.orgId}`;
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt,
      id: sessionId,
      modelOverride: null,
      orgId: options.orgId,
      profileId,
      title: null,
      userId: null,
    });
    return { db, service, sessionId };
  }

  test("enforced budget blocks API-backed chat turns", async () => {
    const orgId = "org_gate_api";
    const { db, service, sessionId } = await setupSessionOrg({
      orgId,
      provider: "api",
    });
    await setPolicy(db, orgId, { enforceBudget: true, monthlyLimitUsd: 1 });
    await seedSpend(db, orgId, { estimatedCostUsd: 2 });

    await expect(
      service.assertSessionTurnAllowed(orgId, sessionId, "user_1")
    ).rejects.toMatchObject({
      path: WORKSPACE_BUDGET_LIMIT_CODE,
      status: 429,
    });
  });

  test("enforced budget does not block subscription chat turns", async () => {
    const orgId = "org_gate_sub";
    const { db, service, sessionId } = await setupSessionOrg({
      orgId,
      provider: "subscription",
    });
    await setPolicy(db, orgId, { enforceBudget: true, monthlyLimitUsd: 1 });
    await seedSpend(db, orgId, { estimatedCostUsd: 2 });

    await expect(
      service.assertSessionTurnAllowed(orgId, sessionId, "user_1")
    ).resolves.toBeUndefined();
  });

  test("per-user request limit blocks subscription chat turns too", async () => {
    const orgId = "org_gate_sub_user";
    const { db, service, sessionId } = await setupSessionOrg({
      orgId,
      provider: "subscription",
    });
    await setPolicy(db, orgId, { perUserMonthlyRequests: 2 });
    await seedSpend(db, orgId, {
      providerType: "claude",
      requestCount: 2,
      userId: "user_1",
    });

    await expect(
      service.assertSessionTurnAllowed(orgId, sessionId, "user_1")
    ).rejects.toMatchObject({ path: USER_REQUEST_LIMIT_CODE, status: 429 });
    await expect(
      service.assertSessionTurnAllowed(orgId, sessionId, "user_2")
    ).resolves.toBeUndefined();
  });

  test("a missing session passes through to the caller's own 404 handling", async () => {
    const orgId = "org_gate_missing";
    const { service } = await setupSessionOrg({ orgId, provider: "api" });

    await expect(
      service.assertSessionTurnAllowed(orgId, "session_missing", "user_1")
    ).resolves.toBeUndefined();
  });
});
