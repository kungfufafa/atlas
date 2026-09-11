import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import type {
  AgentChatSession,
  AgentChatSessionOptions,
  AgentHarness,
} from "@atlas/agent";
import {
  builtinTools,
  getProfileSoulDir,
  LOCAL_CLIENT_USER_ID,
  saveWhatsAppConfig,
  type ToolDefinition,
} from "@atlas/core";
import { saveChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import { executeProtectedTool } from "@atlas/core/tools/execution";
import { createSqliteDatabase } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-guest-kb-integration-");

const PHONE = "628111111111";
const PHONE_JID = `${PHONE}@s.whatsapp.net`;
const KNOWLEDGE_TEXT = "SURAT_EDARAN: authorized retail policy for this agent.";
const PRIVATE_MEMORY = "PRIVATE_PROFILE_MEMORY_SENTINEL";
const databases: Awaited<ReturnType<typeof createSqliteDatabase>>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

const unusedSession: AgentChatSession = {
  clear() {},
  async compact() {
    return { action: "none", messagesAfter: 0, messagesBefore: 0 };
  },
  async createAutomation() {
    throw new Error("Unexpected automation invocation");
  },
  getContextUsage: () => null,
  getHistory: () => [],
  getHistoryRevision: () => 0,
  send: async () => "unused",
  sendStream: async () => "unused",
};

async function fixture(options: { open?: boolean; paired?: boolean } = {}) {
  const database = await createSqliteDatabase(":memory:");
  databases.push(database);
  const db = database.adapter;
  const orgId = `org_${crypto.randomUUID()}`;
  const profileId = `profile_${crypto.randomUUID()}`;
  const toolId = `kb_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: orgId,
    name: "Knowledge integration",
    slug: orgId,
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: profileId,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Knowledge integration",
    orgId,
    systemPrompt: "Help with uploaded retail knowledge.",
    updatedAt: now,
  });
  await db.upsertTool({
    createdAt: now,
    description: "Uploaded profile knowledge",
    handlerConfig: {},
    handlerType: "builtin",
    id: toolId,
    name: "knowledge_base_search",
    orgId,
    updatedAt: now,
  });
  await db.assignToolToProfile(profileId, toolId);
  const configure = async (allowedNumbers: string[], open = false) => {
    await saveWhatsAppConfig(
      {
        accessMode: open ? "open" : "allowlist",
        allowedNumbers,
        phoneNumber: "628999999999",
        profileId,
      },
      orgId
    );
  };
  await configure(options.open ? [] : [PHONE], options.open);
  if (options.paired) {
    const userId = "user_paired_integration";
    await db.createUser({
      createdAt: now,
      email: "paired@example.test",
      id: userId,
      isPlatformAdmin: false,
      passwordHash: "!disabled!",
      updatedAt: now,
    });
    await db.upsertOrgMember({ createdAt: now, orgId, role: "member", userId });
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: PHONE_JID,
      createdAt: now,
      orgId,
      userId,
    });
  }

  const service = new AgentService(null, null, db);
  await service.uploadKnowledgeBaseDocument(orgId, profileId, {
    data: Buffer.from(KNOWLEDGE_TEXT).toString("base64"),
    filename: "retail-policy.txt",
    mediaType: "text/plain",
  });
  await writeFile(
    `${getProfileSoulDir(orgId, profileId)}/MEMORY.md`,
    PRIVATE_MEMORY
  );

  const captured: AgentChatSessionOptions[] = [];
  const customRun = mock(async () => "CUSTOM_KB_MUST_NOT_RUN");
  const assignedTools: ToolDefinition[] = options.paired
    ? builtinTools.filter((tool) => tool.name === "knowledge_base_search")
    : [
        {
          description: "Custom namesake",
          name: "knowledge_base_search",
          run: customRun,
        },
      ];
  assignedTools.push({
    description: "Private assigned tool",
    name: "private_profile_probe",
    run: customRun,
  });
  const loadProfileTools = mock(async () => assignedTools);
  const internals = service as unknown as {
    createHarnessForProfile: () => AgentHarness;
    resolveProfileTools: () => Promise<ToolDefinition[]>;
  };
  internals.resolveProfileTools = loadProfileTools;
  internals.createHarnessForProfile = () => ({
    async createAutomationFromPrompt() {
      throw new Error("Unexpected automation invocation");
    },
    createChatSession(sessionOptions) {
      captured.push(sessionOptions ?? {});
      return unusedSession;
    },
  });

  const sessionId = await service.createSession(
    orgId,
    "whatsapp",
    profileId,
    LOCAL_CLIENT_USER_ID,
    { externalPrincipal: { channelUserId: PHONE_JID }, orgRole: "member" }
  );
  const current = () => {
    const latest = captured.at(-1);
    if (!(latest?.toolContext && latest.resolvePromptContext)) {
      throw new Error("Missing captured tool and prompt context");
    }
    return {
      ...latest,
      resolvePromptContext: latest.resolvePromptContext,
      toolContext: latest.toolContext,
    };
  };
  const bind = () =>
    service.channelNativeActions.bind(orgId, "whatsapp", {
      channelChatId: PHONE_JID,
      channelIsGroup: false,
      channelUserId: PHONE_JID,
      sessionId,
    });
  return {
    bind,
    captured,
    configure,
    current,
    customRun,
    db,
    loadProfileTools,
    orgId,
    profileId,
    service,
    sessionId,
    toolId,
  };
}

function requireTool(options: AgentChatSessionOptions, name: string) {
  const tool = options.tools?.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing expected tool: ${name}`);
  }
  return tool;
}

describe("allowlisted WhatsApp guest knowledge integration", () => {
  test("retains the live session while guest knowledge access is unchanged", async () => {
    const h = await fixture();
    const first = await h.service.resolveSession(h.orgId, h.sessionId);
    await h.bind();
    const next = await h.service.resolveSession(h.orgId, h.sessionId);
    expect(first).toBe(next);
    expect(h.captured).toHaveLength(1);
  });

  test("searches actual profile knowledge only after binding without loading private tools", async () => {
    const h = await fixture();
    const options = h.current();
    const kb = requireTool(options, "knowledge_base_search");
    expect(options.toolContext.userId?.startsWith("user_channel_guest_")).toBe(
      true
    );
    expect(options.tools?.map((tool) => tool.name).sort()).toEqual([
      "extract_document_text",
      "knowledge_base_search",
      "read_file",
      "spreadsheet",
      "write_docx",
      "write_file",
      "write_pptx",
    ]);
    expect(
      await options.resolvePromptContext({ userMessage: "SURAT_EDARAN" })
    ).toBe("");
    expect(
      (
        await executeProtectedTool(
          kb,
          { query: "SURAT_EDARAN" },
          options.toolContext
        )
      ).success
    ).toBe(false);
    await h.bind();

    const result = await executeProtectedTool(
      kb,
      { query: "SURAT_EDARAN" },
      options.toolContext
    );
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).toContain(KNOWLEDGE_TEXT);
    const grounding = await options.resolvePromptContext({
      userMessage: "SURAT_EDARAN",
    });
    expect(grounding).toContain(KNOWLEDGE_TEXT);
    expect(grounding).not.toContain(PRIVATE_MEMORY);
    expect(options.systemPrompt).not.toContain(PRIVATE_MEMORY);
    expect(h.loadProfileTools).not.toHaveBeenCalled();
    expect(h.customRun).not.toHaveBeenCalled();

    const write = requireTool(options, "write_file");
    expect(
      (
        await executeProtectedTool(
          write,
          { content: "work result", path: "artifacts/result.txt" },
          options.toolContext
        )
      ).success
    ).toBe(true);
    expect(
      (
        await executeProtectedTool(
          requireTool(options, "read_file"),
          { path: "artifacts/result.txt" },
          options.toolContext
        )
      ).success
    ).toBe(true);
    for (const tool of [write, requireTool(options, "read_file")]) {
      expect(
        (
          await executeProtectedTool(
            tool,
            {
              path: "MEMORY.md",
              ...(tool === write ? { content: "overwrite" } : {}),
            },
            options.toolContext
          )
        ).success
      ).toBe(false);
    }
    expect(
      await readFile(
        `${getProfileSoulDir(h.orgId, h.profileId)}/MEMORY.md`,
        "utf8"
      )
    ).toBe(PRIVATE_MEMORY);
    for (const name of ["bash", "memory_write", "private_profile_probe"]) {
      await expect(
        options.toolContext.beforeToolCall?.(name)
      ).rejects.toThrow();
    }
  });

  test("keeps search and automatic excerpts within the selected org and profile", async () => {
    const h = await fixture();
    const other = await fixture();
    const otherProfile = {
      ...(await h.db.getProfileForOrg(h.profileId, h.orgId))!,
      id: "other_profile",
      isDefault: false,
    };
    await h.db.upsertProfile(otherProfile);
    for (const target of [
      { orgId: h.orgId, profileId: otherProfile.id, service: h.service },
      {
        orgId: other.orgId,
        profileId: other.profileId,
        service: other.service,
      },
    ]) {
      await target.service.uploadKnowledgeBaseDocument(
        target.orgId,
        target.profileId,
        {
          data: Buffer.from("SURAT_EDARAN: OTHER_SCOPE_SECRET").toString(
            "base64"
          ),
          filename: "private-other-scope.txt",
          mediaType: "text/plain",
        }
      );
    }
    await h.service.resolveSession(h.orgId, h.sessionId);
    await h.bind();
    const options = h.current();
    const result = await executeProtectedTool(
      requireTool(options, "knowledge_base_search"),
      { query: "SURAT_EDARAN" },
      options.toolContext
    );
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).toContain(KNOWLEDGE_TEXT);
    expect(JSON.stringify(result.data)).not.toContain("OTHER_SCOPE_SECRET");
    const grounding = await options.resolvePromptContext({
      userMessage: "SURAT_EDARAN",
    });
    expect(grounding).toContain(KNOWLEDGE_TEXT);
    expect(grounding).not.toContain("OTHER_SCOPE_SECRET");
  });

  test("honors sender allowedTools for both explicit and automatic knowledge reads", async () => {
    const h = await fixture();
    await h.bind();
    await saveChannelIntegrationPolicy(h.orgId, "whatsapp", {
      senders: { [PHONE_JID]: { allowedTools: ["read_file", "write_file"] } },
      version: 1,
    });
    const options = h.current();
    expect(
      (
        await executeProtectedTool(
          requireTool(options, "knowledge_base_search"),
          { query: "SURAT_EDARAN" },
          options.toolContext
        )
      ).success
    ).toBe(false);
    expect(
      await options.resolvePromptContext({ userMessage: "SURAT_EDARAN" })
    ).toBe("");
  });

  test.each(["allowlist", "assignment"] as const)(
    "revokes %s access in retained contexts and refreshed sessions",
    async (revocation) => {
      const h = await fixture();
      await h.bind();
      const options = h.current();
      if (revocation === "allowlist") {
        await h.configure([], true);
      } else {
        await h.db.unassignToolFromProfile(h.profileId, h.toolId);
      }
      expect(
        (
          await executeProtectedTool(
            requireTool(options, "knowledge_base_search"),
            { query: "SURAT_EDARAN" },
            options.toolContext
          )
        ).success
      ).toBe(false);
      expect(
        await options.resolvePromptContext({ userMessage: "SURAT_EDARAN" })
      ).toBe("");
      await h.service.resolveSession(h.orgId, h.sessionId);
      expect(
        h.current().tools?.some((tool) => tool.name === "knowledge_base_search")
      ).toBe(false);
      expect(h.loadProfileTools).not.toHaveBeenCalled();
    }
  );

  test("adds knowledge access to an existing open guest after whitelisting", async () => {
    const h = await fixture({ open: true });
    const userId = h.current().toolContext.userId;
    expect(
      h.current().tools?.some((tool) => tool.name === "knowledge_base_search")
    ).toBe(false);
    await h.configure([PHONE]);
    await h.service.resolveSession(h.orgId, h.sessionId);
    await h.bind();
    const options = h.current();
    expect(options.toolContext.userId).toBe(userId);
    expect(
      (
        await executeProtectedTool(
          requireTool(options, "knowledge_base_search"),
          { query: "SURAT_EDARAN" },
          options.toolContext
        )
      ).success
    ).toBe(true);
    expect(
      await options.resolvePromptContext({ userMessage: "SURAT_EDARAN" })
    ).toContain(KNOWLEDGE_TEXT);
    expect(h.loadProfileTools).not.toHaveBeenCalled();
  });

  test("does not grant knowledge after switching away from the Reply-as profile", async () => {
    const h = await fixture();
    const otherProfile = {
      ...(await h.db.getProfileForOrg(h.profileId, h.orgId))!,
      id: "internal_finance",
      isDefault: false,
      name: "Internal Finance",
    };
    await h.db.upsertProfile(otherProfile);
    await h.db.assignToolToProfile(otherProfile.id, h.toolId);
    await h.service.uploadKnowledgeBaseDocument(h.orgId, otherProfile.id, {
      data: Buffer.from("FINANCE_SECRET: payroll table").toString("base64"),
      filename: "payroll.txt",
      mediaType: "text/plain",
    });
    const switchedSessionId = await h.service.createSession(
      h.orgId,
      "whatsapp",
      otherProfile.id,
      LOCAL_CLIENT_USER_ID,
      {
        externalPrincipal: { channelUserId: PHONE_JID },
        orgRole: "member",
      }
    );
    await h.service.channelNativeActions.bind(h.orgId, "whatsapp", {
      channelChatId: PHONE_JID,
      channelIsGroup: false,
      channelUserId: PHONE_JID,
      sessionId: switchedSessionId,
    });
    await h.service.resolveSession(h.orgId, switchedSessionId);
    const options = h.current();
    expect(
      options.tools?.some((tool) => tool.name === "knowledge_base_search")
    ).toBe(false);
    expect(
      await options.resolvePromptContext({ userMessage: "FINANCE_SECRET" })
    ).toBe("");
    expect(h.loadProfileTools).not.toHaveBeenCalled();
  });

  test("preserves assigned tools and knowledge for an existing paired member", async () => {
    const h = await fixture({ open: true, paired: true });
    await h.bind();
    const options = h.current();
    expect(options.toolContext.userId).toBe("user_paired_integration");
    expect(options.tools?.map((tool) => tool.name)).toContain(
      "private_profile_probe"
    );
    expect(
      (
        await executeProtectedTool(
          requireTool(options, "knowledge_base_search"),
          { query: "SURAT_EDARAN" },
          options.toolContext
        )
      ).success
    ).toBe(true);
    expect(
      await options.resolvePromptContext({ userMessage: "SURAT_EDARAN" })
    ).toContain(KNOWLEDGE_TEXT);
    expect(h.loadProfileTools).toHaveBeenCalledTimes(1);
  });
});
