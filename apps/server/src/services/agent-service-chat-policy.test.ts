import { describe, expect, mock, test } from "bun:test";
import {
  PROVIDER_CAPABILITY_CONTRACT_VERSION,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type ProviderClient,
  type UserConfig,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ProviderAdapterRegistry } from "../providers";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-agent-chat-policy-");

const ORG_ID = "org-chat-policy";
const INSTANCE_ID = "synthetic-instance";
const MODEL_ID = "synthetic-model";
const NOW = "2026-08-27T00:00:00.000Z";

function syntheticRegistry(
  status: "supported" | "unsupported",
  generateText: ProviderClient["generateText"]
): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry();
  const claim = {
    source: "static-manifest",
    status,
    verified: true,
  } as const;
  const manifest: ProviderCapabilityManifestV1 = {
    adapterApiVersion: 1,
    capabilities: {
      [PROVIDER_CAPABILITY_IDS.chatCompletion]: {
        contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
        implementation: { status: "available" },
        metadata: {
          description: "Generate synthetic chat output.",
          label: "Synthetic completion",
          routable: false,
        },
        modelDefault: claim,
        native: claim,
      },
      [PROVIDER_CAPABILITY_IDS.chatStructuredOutput]: {
        contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
        implementation: { status: "available" },
        metadata: {
          description: "Generate synthetic structured output.",
          label: "Synthetic structured output",
          routable: false,
        },
        modelDefault: {
          source: "static-manifest",
          status: "supported",
          verified: true,
        },
        native: {
          source: "static-manifest",
          status: "supported",
          verified: true,
        },
      },
    },
    manifestRevision: "test",
    provider: {
      displayName: "Synthetic adapter",
      id: "openai_compatible",
    },
    schemaVersion: 1,
  };
  registry.register({
    chatCapabilities: [
      PROVIDER_CAPABILITY_IDS.chatCompletion,
      PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
    ],
    createChatClient: () => ({
      async generateChat() {
        throw new Error("unused");
      },
      generateText,
      name: "openai_compatible",
      async streamChat() {
        throw new Error("unused");
      },
    }),
    credentialsRequired: () => false,
    manifest,
  });
  return registry;
}

function config(): UserConfig {
  return {
    defaultProviderId: INSTANCE_ID,
    providers: [
      {
        apiKey: "",
        baseUrl: "https://synthetic.invalid/v1",
        createdAt: NOW,
        customModels: [{ default: true, id: MODEL_ID }],
        id: INSTANCE_ID,
        label: "Synthetic",
        type: "openai_compatible",
      },
    ],
  };
}

async function serviceWithRegistry(
  registry: ProviderAdapterRegistry
): Promise<AgentService> {
  const db = createInMemoryDatabaseAdapter();
  await db.upsertOrgAiConfig({
    config: config(),
    orgId: ORG_ID,
    updatedAt: NOW,
  });
  return new AgentService(null, null, db, undefined, registry);
}

describe("AgentService chat invocation policy", () => {
  test("draftAutomation uses an injected synthetic adapter and capability policy", async () => {
    const generateText = mock(async () => ({ content: "{}" }));
    const service = await serviceWithRegistry(
      syntheticRegistry("supported", generateText)
    );

    const draft = await service.draftAutomation(
      ORG_ID,
      "Prepare a daily summary",
      "web"
    );

    expect(draft.prompt).toBe("Prepare a daily summary");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("draftAutomation fails before provider work when completion is unsupported", async () => {
    const generateText = mock(async () => ({ content: "{}" }));
    const service = await serviceWithRegistry(
      syntheticRegistry("unsupported", generateText)
    );

    await expect(
      service.draftAutomation(ORG_ID, "Prepare a daily summary", "web")
    ).rejects.toMatchObject({
      capabilityId: PROVIDER_CAPABILITY_IDS.chatCompletion,
      code: "CHAT_CAPABILITY_UNSUPPORTED",
    });
    expect(generateText).toHaveBeenCalledTimes(0);
  });

  test("direct generateText helpers cannot bypass an unsupported completion policy", async () => {
    const generateText = mock(async () => ({ content: "unsafe bypass" }));
    const service = await serviceWithRegistry(
      syntheticRegistry("unsupported", generateText)
    );

    const prompt = await service.draftTaskPrompt(
      ORG_ID,
      "Review launch risks",
      "Prioritize customer impact"
    );

    expect(prompt).toContain(
      "Complete the following task: Review launch risks"
    );
    expect(prompt).not.toContain("unsafe bypass");
    expect(generateText).toHaveBeenCalledTimes(0);
  });
});
