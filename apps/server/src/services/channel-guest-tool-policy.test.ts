import { describe, expect, test } from "bun:test";
import type {
  AgentChatSession,
  AgentChatSessionOptions,
  AgentHarness,
} from "@atlas/agent";
import type { ToolDefinition } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";
import { resolveExecutableToolsForPrincipal } from "./channel-guest-tool-policy";

setupTestConfigDir("atlas-channel-guest-tools-");

const ORG_ID = "org_channel_guest_tools";
const PROFILE_ID = "profile_channel_guest_tools";

const assignedTool: ToolDefinition = {
  description: "Read profile memory",
  name: "read_file",
  async run() {
    return "secret";
  },
};

describe("channel guest chat tool policy", () => {
  test("returns zero executable tools without loading shared profile tools", async () => {
    let loadCalls = 0;
    const tools = await resolveExecutableToolsForPrincipal(
      "user_channel_guest_0123456789abcdef",
      async () => {
        loadCalls += 1;
        return [assignedTool];
      }
    );

    expect(tools).toEqual([]);
    expect(loadCalls).toBe(0);
  });

  test("keeps assigned tools for a paired canonical member", async () => {
    let loadCalls = 0;
    const tools = await resolveExecutableToolsForPrincipal(
      "user_paired_member",
      async () => {
        loadCalls += 1;
        return [assignedTool];
      }
    );

    expect(tools).toEqual([assignedTool]);
    expect(loadCalls).toBe(1);
  });

  test("builds guest chat with no tools while preserving paired member tools", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertProfile({
      createdAt: now,
      id: PROFILE_ID,
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Channel guest tool policy",
      orgId: ORG_ID,
      systemPrompt: "Public profile prompt",
      updatedAt: now,
    });
    const service = new AgentService(null, null, db);
    const capturedOptions: AgentChatSessionOptions[] = [];
    let loadCalls = 0;
    const session: AgentChatSession = {
      clear() {},
      async compact() {
        return {
          action: "none",
          messagesAfter: 0,
          messagesBefore: 0,
        };
      },
      async createAutomation() {
        throw new Error("not used");
      },
      getContextUsage: () => null,
      getHistory: () => [],
      getHistoryRevision: () => 0,
      send: async () => "unused",
      sendStream: async () => "unused",
    };
    (
      service as unknown as {
        createHarnessForProfile: () => AgentHarness;
        resolveProfileTools: () => Promise<ToolDefinition[]>;
      }
    ).createHarnessForProfile = () => ({
      async createAutomationFromPrompt() {
        throw new Error("not used");
      },
      createChatSession(options) {
        capturedOptions.push(options ?? {});
        return session;
      },
    });
    (
      service as unknown as {
        resolveProfileTools: () => Promise<ToolDefinition[]>;
      }
    ).resolveProfileTools = async () => {
      loadCalls += 1;
      return [assignedTool];
    };
    const builder = service as unknown as {
      buildChatSession(
        channel: "whatsapp",
        orgId: string,
        profileId: string,
        sessionId: string,
        modelOverride: null,
        userId: string,
        orgRole: "member",
        isPlatformAdmin: false
      ): Promise<AgentChatSession>;
    };

    await builder.buildChatSession(
      "whatsapp",
      ORG_ID,
      PROFILE_ID,
      "session_guest",
      null,
      "user_channel_guest_0123456789abcdef",
      "member",
      false
    );
    await builder.buildChatSession(
      "whatsapp",
      ORG_ID,
      PROFILE_ID,
      "session_paired",
      null,
      "user_paired_member",
      "member",
      false
    );

    expect(capturedOptions[0]?.tools).toEqual([]);
    expect(capturedOptions[0]?.enableToolLoop).toBe(false);
    expect(capturedOptions[1]?.tools).toEqual([assignedTool]);
    expect(capturedOptions[1]?.enableToolLoop).toBe(true);
    expect(loadCalls).toBe(1);
  });
});
