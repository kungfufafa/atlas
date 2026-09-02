import { describe, expect, test } from "bun:test";
import {
  type CanonicalPrincipal,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type ProviderClient,
  type UserConfig,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ProviderAdapterRegistry } from "../providers";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";
import { TaskRunner } from "./task-runner";
import { TaskService } from "./task-service";
import { UsageReportService } from "./usage-report-service";

setupTestConfigDir("atlas-usage-attribution-");

const createdAt = "2026-08-27T00:00:00.000Z";
const ORG_ID = "org_usage_attribution";
const PROVIDER_ID = "prov-openai";
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

function buildVisionFallbackRegistry(
  selectedVisionModels: string[]
): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry();
  const chatCapabilities = [
    PROVIDER_CAPABILITY_IDS.chatCompletion,
    PROVIDER_CAPABILITY_IDS.chatInputImage,
    PROVIDER_CAPABILITY_IDS.chatStreaming,
    PROVIDER_CAPABILITY_IDS.chatToolUse,
  ];
  const manifest: ProviderCapabilityManifestV1 = {
    adapterApiVersion: 1,
    capabilities: {
      [PROVIDER_CAPABILITY_IDS.chatCompletion]:
        capabilityEntry("Chat completion"),
      [PROVIDER_CAPABILITY_IDS.chatInputImage]: capabilityEntry("Image input"),
      [PROVIDER_CAPABILITY_IDS.chatStreaming]: capabilityEntry("Streaming"),
      [PROVIDER_CAPABILITY_IDS.chatToolUse]: capabilityEntry("Tool use"),
      [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: capabilityEntry(
        "Image understanding"
      ),
    },
    manifestRevision: "vision-usage-test",
    models: [
      {
        capabilities: {
          [PROVIDER_CAPABILITY_IDS.chatInputImage]: unsupportedClaim(),
          [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: unsupportedClaim(),
        },
        id: "text-only",
      },
      {
        capabilities: {
          [PROVIDER_CAPABILITY_IDS.chatInputImage]: supportedClaim(),
          [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: supportedClaim(),
        },
        id: "vision-model",
      },
    ],
    provider: {
      displayName: "Synthetic vision usage",
      id: "openai_compatible",
    },
    schemaVersion: 1,
  };
  const chatResult = {
    assistantMessage: { content: "Image handled.", role: "assistant" as const },
    content: "Image handled.",
    toolCalls: [],
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  };
  const createChatClient = (): ProviderClient => ({
    async generateChat() {
      return chatResult;
    },
    async generateText() {
      return { content: "Image handled." };
    },
    name: "openai_compatible",
    async streamChat(_input, handlers) {
      handlers.onChunk(chatResult.content);
      return chatResult;
    },
  });

  registry.register({
    chatCapabilities,
    createChatClient,
    credentialsRequired: () => false,
    executors: {
      [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: async (context) => {
        selectedVisionModels.push(context.model);
        return {
          descriptions: ["A tiny red square."],
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        };
      },
    },
    manifest,
  });
  return registry;
}

function unsupportedClaim() {
  return {
    source: "static-manifest",
    status: "unsupported",
    verified: true,
  } as const;
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
  await db.upsertOrganization({
    createdAt,
    id: ORG_ID,
    name: "Usage attribution",
    slug: "usage-attribution",
    updatedAt: createdAt,
  });
  await db.upsertProfile({
    createdAt,
    id: "profile_support",
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Support",
    orgId: ORG_ID,
    systemPrompt: "Support users.",
    updatedAt: createdAt,
  });
  await db.createUser({
    createdAt,
    email: "whatsapp-sender@example.com",
    id: "user_whatsapp_sender",
    passwordHash: "unused",
    updatedAt: createdAt,
  });
  await db.upsertOrgMember({
    createdAt,
    orgId: ORG_ID,
    role: "member",
    userId: "user_whatsapp_sender",
  });
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

  test("transcription resolves WhatsApp usage from the persisted session principal", async () => {
    const { db, service } = await setup();
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "whatsapp",
      createdAt,
      id: "session_whatsapp_audio",
      modelOverride: null,
      orgId: ORG_ID,
      profileId: "profile_support",
      title: null,
      userId: "user_whatsapp_sender",
    });

    await service.transcribeAudioForOrg(
      ORG_ID,
      {
        data: Buffer.from("fake audio").toString("base64"),
        mediaType: "audio/ogg",
        sessionId: "session_whatsapp_audio",
      },
      {
        allowPersistedSessionPrincipal: true,
        userId: "user_local_client",
      }
    );
    await flushFireAndForgetWrites();

    const [byUser, byProfile, byChannel] = await Promise.all([
      db.aggregateLlmUsage({ groupBy: "user", orgId: ORG_ID }),
      db.aggregateLlmUsage({ groupBy: "profile", orgId: ORG_ID }),
      db.aggregateLlmUsage({ groupBy: "channel", orgId: ORG_ID }),
    ]);
    expect(byUser[0]?.key).toBe("user_whatsapp_sender");
    expect(byProfile[0]?.key).toBe("profile_support");
    expect(byChannel[0]?.key).toBe("whatsapp");
  });

  test("vision fallback usage keeps the WhatsApp session channel", async () => {
    const db = createInMemoryDatabaseAdapter();
    const selectedVisionModels: string[] = [];
    const providerId = "vision-provider";
    const profileId = "profile_whatsapp_vision";
    const userId = "user_whatsapp_vision";
    await db.upsertOrganization({
      createdAt,
      id: ORG_ID,
      name: "Vision Usage",
      slug: "vision-usage",
      updatedAt: createdAt,
    });
    await db.createUser({
      createdAt,
      email: "vision@example.com",
      id: userId,
      passwordHash: "unused",
      updatedAt: createdAt,
    });
    await db.upsertOrgMember({
      createdAt,
      orgId: ORG_ID,
      role: "member",
      userId,
    });
    await db.upsertProfile({
      createdAt,
      id: profileId,
      isDefault: true,
      isSuper: false,
      model: `${providerId}::text-only`,
      name: "WhatsApp vision",
      orgId: ORG_ID,
      systemPrompt: "Describe images concisely.",
      updatedAt: createdAt,
    });
    await db.upsertOrgAiConfig({
      config: {
        capabilityConfig: {
          bindings: {
            [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: {
              contractVersion: 1,
              enabled: true,
              fallbacks: [{ modelId: "vision-model", providerId }],
              mode: "manual",
              primary: { modelId: "text-only", providerId },
            },
          },
          schemaVersion: 1,
        },
        defaultProviderId: providerId,
        providers: [
          {
            apiKey: "",
            baseUrl: "https://synthetic.invalid/v1",
            createdAt,
            customModels: [
              { default: true, id: "text-only" },
              { id: "vision-model" },
            ],
            id: providerId,
            label: "Vision provider",
            type: "openai_compatible",
          },
        ],
      } satisfies UserConfig,
      orgId: ORG_ID,
      updatedAt: createdAt,
    });
    const service = new AgentService(
      null,
      null,
      db,
      undefined,
      buildVisionFallbackRegistry(selectedVisionModels)
    );
    const sessionId = await service.createSession(
      ORG_ID,
      "whatsapp",
      profileId,
      userId,
      { orgRole: "member" }
    );
    const session = await service.resolveSession(ORG_ID, sessionId, {
      userId,
    });

    await session?.send({
      images: [{ data: TINY_PNG_BASE64, mediaType: "image/png" }],
      message: "What is in this image?",
    });
    await flushFireAndForgetWrites();

    expect(selectedVisionModels).toEqual(["vision-model"]);
    const byChannel = await db.aggregateLlmUsage({
      groupBy: "channel",
      orgId: ORG_ID,
    });
    expect(byChannel.map((row) => row.key)).toEqual(["whatsapp"]);
    const byCapability = await db.aggregateLlmUsage({
      groupBy: "capability",
      orgId: ORG_ID,
    });
    expect(byCapability).toContainEqual(
      expect.objectContaining({
        key: PROVIDER_CAPABILITY_IDS.imageUnderstanding,
        requestCount: 1,
      })
    );
  });

  test("does not let a caller borrow another user's session attribution", async () => {
    const { db, service } = await setup();
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "whatsapp",
      createdAt,
      id: "session_other_user",
      modelOverride: null,
      orgId: ORG_ID,
      profileId: "profile_support",
      title: null,
      userId: "user_owner",
    });

    await expect(
      service.transcribeAudioForOrg(
        ORG_ID,
        {
          data: Buffer.from("fake audio").toString("base64"),
          mediaType: "audio/ogg",
          sessionId: "session_other_user",
        },
        { userId: "user_intruder" }
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  test("does not let a scoped worker borrow another channel's session", async () => {
    const { db, service } = await setup();
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt,
      id: "session_web_audio",
      modelOverride: null,
      orgId: ORG_ID,
      profileId: "profile_support",
      title: null,
      userId: "user_owner",
    });

    await expect(
      service.transcribeAudioForOrg(
        ORG_ID,
        {
          data: Buffer.from("fake audio").toString("base64"),
          mediaType: "audio/ogg",
          sessionId: "session_web_audio",
        },
        {
          allowPersistedSessionPrincipal: true,
          expectedChannel: "whatsapp",
          userId: "user_local_client",
        }
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  test("requires a session for scoped worker transcription", async () => {
    const { service } = await setup();

    await expect(
      service.transcribeAudioForOrg(
        ORG_ID,
        {
          data: Buffer.from("fake audio").toString("base64"),
          mediaType: "audio/ogg",
        },
        {
          allowPersistedSessionPrincipal: true,
          expectedChannel: "whatsapp",
          userId: "user_local_client",
        }
      )
    ).rejects.toMatchObject({ name: "PrincipalRequiredError" });
  });

  test("rejects legacy, removed, viewer, and Super Agent worker attribution", async () => {
    const { db, service } = await setup();
    await db.upsertProfile({
      createdAt,
      id: "profile_super_audio",
      isDefault: false,
      isSuper: true,
      model: null,
      name: "Super audio",
      orgId: ORG_ID,
      systemPrompt: "Admin only.",
      updatedAt: createdAt,
    });
    for (const [userId, role] of [
      ["user_audio_removed", null],
      ["user_audio_viewer", "viewer"],
    ] as const) {
      await db.createUser({
        createdAt,
        email: `${userId}@example.com`,
        id: userId,
        passwordHash: "unused",
        updatedAt: createdAt,
      });
      if (role) {
        await db.upsertOrgMember({
          createdAt,
          orgId: ORG_ID,
          role,
          userId,
        });
      }
    }
    const cases = [
      {
        expected: { name: "PrincipalRequiredError" },
        id: "session_audio_legacy",
        profileId: "profile_support",
        userId: null,
      },
      {
        expected: { status: 404 },
        id: "session_audio_removed",
        profileId: "profile_support",
        userId: "user_audio_removed",
      },
      {
        expected: { status: 404 },
        id: "session_audio_viewer",
        profileId: "profile_support",
        userId: "user_audio_viewer",
      },
      {
        expected: { status: 404 },
        id: "session_audio_super",
        profileId: "profile_super_audio",
        userId: "user_whatsapp_sender",
      },
    ] as const;
    for (const testCase of cases) {
      await db.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel: "whatsapp",
        createdAt,
        id: testCase.id,
        modelOverride: null,
        orgId: ORG_ID,
        profileId: testCase.profileId,
        title: null,
        userId: testCase.userId,
      });
      await expect(
        service.transcribeAudioForOrg(
          ORG_ID,
          {
            data: Buffer.from("fake audio").toString("base64"),
            mediaType: "audio/ogg",
            sessionId: testCase.id,
          },
          {
            allowPersistedSessionPrincipal: true,
            expectedChannel: "whatsapp",
            userId: "user_local_client",
          }
        )
      ).rejects.toMatchObject(testCase.expected);
    }
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

  test("image generation resolves profile and channel from an owned session", async () => {
    const { db, service } = await setup();
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "whatsapp",
      createdAt,
      id: "session_whatsapp_image",
      modelOverride: null,
      orgId: ORG_ID,
      profileId: "profile_support",
      title: null,
      userId: "user_painter",
    });

    await service.generateImageForOrg(
      ORG_ID,
      { prompt: "a lighthouse", sessionId: "session_whatsapp_image" },
      { userId: "user_painter" }
    );
    await flushFireAndForgetWrites();

    const [byUser, byProfile, byChannel] = await Promise.all([
      db.aggregateLlmUsage({ groupBy: "user", orgId: ORG_ID }),
      db.aggregateLlmUsage({ groupBy: "profile", orgId: ORG_ID }),
      db.aggregateLlmUsage({ groupBy: "channel", orgId: ORG_ID }),
    ]);
    expect(byUser[0]?.key).toBe("user_painter");
    expect(byProfile[0]?.key).toBe("profile_support");
    expect(byChannel[0]?.key).toBe("whatsapp");
  });

  test("does not let direct image generation borrow another user's session", async () => {
    const { db, service } = await setup();
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt,
      id: "session_other_image_user",
      modelOverride: null,
      orgId: ORG_ID,
      profileId: "profile_support",
      title: null,
      userId: "user_owner",
    });

    await expect(
      service.generateImageForOrg(
        ORG_ID,
        { prompt: "a lighthouse", sessionId: "session_other_image_user" },
        { userId: "user_intruder" }
      )
    ).rejects.toMatchObject({ status: 404 });
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

describe("task usage attribution", () => {
  test("persists actor A on the task session and member reports stay self-scoped", async () => {
    const db = createInMemoryDatabaseAdapter();
    const providerId = "task-provider";
    const profileId = "profile_task_usage";
    const userAId = "user_task_a";
    const userBId = "user_task_b";
    await db.upsertOrganization({
      createdAt,
      id: ORG_ID,
      name: "Task Usage",
      slug: "task-usage",
      updatedAt: createdAt,
    });
    for (const [id, email] of [
      [userAId, "task-a@example.com"],
      [userBId, "task-b@example.com"],
    ] as const) {
      await db.createUser({
        createdAt,
        email,
        id,
        passwordHash: "unused",
        updatedAt: createdAt,
      });
      await db.upsertOrgMember({
        createdAt,
        orgId: ORG_ID,
        role: "member",
        userId: id,
      });
    }
    await db.upsertProfile({
      createdAt,
      id: profileId,
      isDefault: true,
      isSuper: false,
      model: `${providerId}::text-only`,
      name: "Task agent",
      orgId: ORG_ID,
      systemPrompt: "Complete the assigned task.",
      updatedAt: createdAt,
    });
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: providerId,
        providers: [
          {
            apiKey: "",
            baseUrl: "https://synthetic.invalid/v1",
            createdAt,
            customModels: [{ default: true, id: "text-only" }],
            id: providerId,
            label: "Task provider",
            type: "openai_compatible",
          },
        ],
      } satisfies UserConfig,
      orgId: ORG_ID,
      updatedAt: createdAt,
    });

    const agent = new AgentService(
      null,
      null,
      db,
      undefined,
      buildVisionFallbackRegistry([])
    );
    const taskService = new TaskService(db);
    const taskRunner = new TaskRunner(
      taskService,
      agent,
      agent.identityService
    );
    const task = await taskService.create(
      ORG_ID,
      { prompt: "Summarize the launch notes.", title: "Launch summary" },
      profileId,
      undefined,
      userAId
    );
    const principalA: CanonicalPrincipal = {
      isPlatformAdmin: false,
      orgId: ORG_ID,
      orgRole: "member",
      userId: userAId,
    };

    const result = await taskRunner.run(task.id, principalA);
    expect(result.output).toBe("Image handled.");
    await flushFireAndForgetWrites();

    const updatedTask = await taskService.get(task.id, ORG_ID);
    expect(updatedTask?.sessionId).toBeTruthy();
    const taskSession = updatedTask?.sessionId
      ? await db.getSession(updatedTask.sessionId)
      : null;
    expect(taskSession).toMatchObject({
      channel: "task",
      userId: userAId,
    });

    const reportService = new UsageReportService(db);
    const [ownerReport, otherMemberReport] = await Promise.all([
      reportService.getReport(
        { channel: "task", groupBy: "channel" },
        { orgId: ORG_ID, orgRole: "member", userId: userAId }
      ),
      reportService.getReport(
        { channel: "task", groupBy: "channel" },
        { orgId: ORG_ID, orgRole: "member", userId: userBId }
      ),
    ]);
    expect(ownerReport.rows).toEqual([
      expect.objectContaining({ key: "task", requestCount: 1 }),
    ]);
    expect(otherMemberReport.rows).toEqual([]);
  });
});
