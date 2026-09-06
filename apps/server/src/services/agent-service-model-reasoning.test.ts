import { afterEach, describe, expect, test } from "bun:test";
import {
  type GenerateChatInput,
  PROVIDER_CAPABILITY_IDS,
  type ProviderModelOption,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { seedOrgAdmin } from "../http/test-session-helpers";
import {
  setChatgptRuntimeForTests,
  setClaudeRuntimeForTests,
} from "../providers/subscription";
import type { ChatgptSubscriptionRuntime } from "../providers/subscription/chatgpt/runtime";
import type { ClaudeSubscriptionRuntime } from "../providers/subscription/claude/runtime";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-model-reasoning-service-");

afterEach(() => {
  setChatgptRuntimeForTests(null);
  setClaudeRuntimeForTests(null);
});

const EFFORT_CASES = [
  {
    defaultReasoningEffort: undefined,
    expected: undefined,
    label: "no advertised effort levels",
    reasoningEffortValues: [],
  },
  {
    defaultReasoningEffort: undefined,
    expected: undefined,
    label: "an unsupported saved effort without a default",
    reasoningEffortValues: ["low", "high"],
  },
  {
    defaultReasoningEffort: "high",
    expected: "high",
    label: "an advertised provider default",
    reasoningEffortValues: ["low", "high"],
  },
];

describe("subscription chat effort follows live model metadata", () => {
  for (const kind of ["chatgpt", "claude"] as const) {
    test.each(EFFORT_CASES)(
      `${kind} respects $label instead of sending stale saved medium`,
      async ({ defaultReasoningEffort, reasoningEffortValues, expected }) => {
        const db = createInMemoryDatabaseAdapter();
        const admin = await seedOrgAdmin(db);
        const profileId = "reasoning-profile";
        const instanceId = "subscription";
        const modelId = "live-model";
        const now = "2026-09-06T00:00:00.000Z";
        await db.upsertProfile({
          createdAt: now,
          id: profileId,
          isDefault: true,
          isSuper: false,
          model: `${instanceId}::${modelId}`,
          name: "Reasoning",
          orgId: admin.orgId,
          systemPrompt: "Be concise.",
          updatedAt: now,
        });
        await db.upsertOrgAiConfig({
          config: {
            defaultProviderId: instanceId,
            providers: [
              {
                apiKey: "",
                createdAt: now,
                customModels: [
                  {
                    defaultReasoningEffort: "medium",
                    id: modelId,
                    reasoningEffortValues: ["medium"],
                    supportsThinking: true,
                  },
                ],
                id: instanceId,
                label: "Subscription",
                type: kind,
              },
            ],
            thinkingEffort: "medium",
            thinkingEnabled: true,
          },
          orgId: admin.orgId,
          updatedAt: now,
        });
        const inputs: GenerateChatInput[] = [];
        const models: ProviderModelOption[] = [
          {
            capabilities: {
              [PROVIDER_CAPABILITY_IDS.chatReasoning]: {
                source: "runtime-probe",
                status: "supported",
                verified: true,
              },
            },
            default: true,
            ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            id: modelId,
            name: "Live model",
            provider: kind,
            reasoningEffortValues,
            supportsThinking: true,
          },
        ];
        const result = {
          assistantMessage: { content: "ok", role: "assistant" as const },
          content: "ok",
          toolCalls: [],
        };
        const runtime = {
          generateChat: async (input: GenerateChatInput) => {
            inputs.push(input);
            return result;
          },
          listModels: async () => models,
          streamChat: async (input: GenerateChatInput) => {
            inputs.push(input);
            return result;
          },
        };
        if (kind === "chatgpt") {
          setChatgptRuntimeForTests(
            runtime as unknown as ChatgptSubscriptionRuntime
          );
        } else {
          setClaudeRuntimeForTests(
            runtime as unknown as ClaudeSubscriptionRuntime
          );
        }
        const service = new AgentService(null, null, db);
        const sessionId = await service.createSession(
          admin.orgId,
          "web",
          profileId,
          admin.userId,
          { orgRole: "admin" }
        );
        const session = await service.resolveSession(admin.orgId, sessionId, {
          userId: admin.userId,
        });
        expect(session).not.toBeNull();
        await session!.send("Hello");

        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.providerOptions?.thinking).toEqual({
          enabled: true,
          ...(expected ? { effort: expected } : {}),
        });
        const savedModel = (await db.getOrgAiConfig(admin.orgId))?.config
          .providers[0]?.customModels?.[0];
        expect(savedModel?.reasoningEffortValues).toEqual(
          reasoningEffortValues
        );
        expect(savedModel?.defaultReasoningEffort).toBe(defaultReasoningEffort);
      }
    );
  }
});
