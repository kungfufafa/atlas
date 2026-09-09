import { describe, expect, test } from "bun:test";
import type { ProviderInstance } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { enrichCodingAgentBashInput } from "./coding-agent-bash-env";

const anthropicProvider: ProviderInstance = {
  apiKey: "sk-ant-test",
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "prov_anthropic",
  label: "Anthropic",
  type: "anthropic",
};

const openaiProvider: ProviderInstance = {
  apiKey: "sk-openai-test",
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "prov_openai",
  label: "OpenAI",
  type: "openai",
};

describe("enrichCodingAgentBashInput", () => {
  test("keeps host-native login isolated to the selected workspace", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "echo",
          enabled: true,
          id: "coding-harness-claude-code",
          kind: "claude_code",
          name: "Claude Code",
        },
      ],
      codingAgentProviderPassthrough: true,
      id: "workspace-settings",
      imageModel: null,
      selectedCodingAgentHarness: null,
      transcriptionModel: null,
      updatedAt: now,
      visionModel: null,
    });
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [],
      codingAgentProviderPassthrough: false,
      id: "workspace-settings:org-native",
      imageModel: null,
      orgId: "org-native",
      selectedCodingAgentHarness: null,
      transcriptionModel: null,
      updatedAt: now,
      visionModel: null,
    });
    for (const [id, orgId] of [
      ["profile_native", "org-native"],
      ["profile_atlas", "org-atlas"],
    ] as const) {
      await db.upsertProfile({
        createdAt: now,
        id,
        isDefault: true,
        isSuper: false,
        model: "anthropic:claude-sonnet-4-6",
        name: id,
        orgId,
        systemPrompt: "test",
        updatedAt: now,
      });
    }

    const native = (await enrichCodingAgentBashInput(
      db,
      { command: "echo task", env: { SAFE: "1" } },
      { orgId: "org-native", profileId: "profile_native" },
      {
        defaultProviderId: anthropicProvider.id,
        providers: [anthropicProvider],
      }
    )) as {
      codingAgent?: boolean;
      codingAgentNativeLogin?: boolean;
      env?: Record<string, string>;
    };
    expect(native).toMatchObject({
      codingAgent: true,
      codingAgentNativeLogin: true,
      env: { SAFE: "1" },
    });
    expect(native.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(native.env?.OPENAI_API_KEY).toBeUndefined();

    const atlas = (await enrichCodingAgentBashInput(
      db,
      { command: "echo task" },
      { orgId: "org-atlas", profileId: "profile_atlas" },
      {
        defaultProviderId: anthropicProvider.id,
        providers: [anthropicProvider],
      }
    )) as { env?: Record<string, string> };
    expect(atlas.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  test("merges provider passthrough env when coding agent command is detected", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "echo",
          enabled: true,
          id: "coding-harness-claude-code",
          kind: "claude_code",
          name: "Claude Code",
        },
      ],
      codingAgentProviderPassthrough: true,
      id: "workspace-settings",
      imageModel: null,
      selectedCodingAgentHarness: null,
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });
    await db.upsertProfile({
      createdAt: new Date().toISOString(),
      id: "profile_test",
      isDefault: true,
      isSuper: false,
      model: "anthropic:claude-sonnet-4-6",
      name: "Test",
      orgId: "org_test",
      systemPrompt: "test",
      updatedAt: new Date().toISOString(),
    });

    const enriched = (await enrichCodingAgentBashInput(
      db,
      { command: "echo hello" },
      { orgId: "org_test", profileId: "profile_test" },
      {
        defaultProviderId: anthropicProvider.id,
        providers: [anthropicProvider],
      }
    )) as { env?: Record<string, string> };

    expect(enriched.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(enriched.env?.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(enriched.env?.PATH).toBeUndefined();
  });

  test("resolves spawn env from command binary even when another harness is selected", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "claude",
          enabled: true,
          id: "coding-harness-claude-code",
          kind: "claude_code",
          name: "Claude Code",
        },
        {
          args: [],
          command: "echo",
          enabled: true,
          id: "coding-harness-codex",
          kind: "codex",
          name: "Codex",
        },
      ],
      codingAgentProviderPassthrough: true,
      id: "workspace-settings",
      imageModel: null,
      selectedCodingAgentHarness: "coding-harness-claude-code",
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });
    await db.upsertProfile({
      createdAt: new Date().toISOString(),
      id: "profile_test",
      isDefault: true,
      isSuper: false,
      model: "openai:gpt-4.1",
      name: "Test",
      orgId: "org_test",
      systemPrompt: "test",
      updatedAt: new Date().toISOString(),
    });

    const enriched = (await enrichCodingAgentBashInput(
      db,
      { command: "echo exec task" },
      { orgId: "org_test", profileId: "profile_test" },
      {
        defaultProviderId: openaiProvider.id,
        providers: [openaiProvider],
      }
    )) as { env?: Record<string, string> };

    expect(enriched.env?.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(enriched.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("fails closed when codingAgent is set without a known harness binary", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "claude",
          enabled: true,
          id: "coding-harness-claude-code",
          kind: "claude_code",
          name: "Claude Code",
        },
      ],
      codingAgentProviderPassthrough: true,
      id: "workspace-settings",
      imageModel: null,
      selectedCodingAgentHarness: "coding-harness-claude-code",
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });

    await expect(
      enrichCodingAgentBashInput(
        db,
        { codingAgent: true, command: "ls -la" },
        { orgId: "org_test", profileId: "profile_test" },
        {
          defaultProviderId: anthropicProvider.id,
          providers: [anthropicProvider],
        }
      )
    ).rejects.toThrow(/known coding-agent CLI/);
  });

  test("does not merge provider credentials for Cursor Agent when routing is active", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "echo",
          enabled: true,
          id: "coding-harness-cursor-agent",
          kind: "cursor_agent",
          name: "Cursor Agent",
        },
      ],
      codingAgentProviderPassthrough: true,
      id: "workspace-settings",
      imageModel: null,
      selectedCodingAgentHarness: null,
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });
    await db.upsertProfile({
      createdAt: new Date().toISOString(),
      id: "profile_test",
      isDefault: true,
      isSuper: false,
      model: "anthropic:claude-sonnet-4-6",
      name: "Test",
      orgId: "org_test",
      systemPrompt: "test",
      updatedAt: new Date().toISOString(),
    });

    const enriched = (await enrichCodingAgentBashInput(
      db,
      {
        codingAgent: true,
        command: "echo -p 'task' --output-format text --yolo",
      },
      { orgId: "org_test", profileId: "profile_test" },
      {
        defaultProviderId: anthropicProvider.id,
        providers: [anthropicProvider],
      }
    )) as { env?: Record<string, string>; codingAgent?: boolean };

    expect(enriched.codingAgent).toBe(true);
    expect(enriched.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(enriched.env?.OPENAI_API_KEY).toBeUndefined();
  });
});
