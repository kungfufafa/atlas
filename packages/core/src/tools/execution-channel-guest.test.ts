import { describe, expect, mock, test } from "bun:test";
import type { ToolContext, ToolDefinition } from "../contract";
import { executeProtectedTool } from "./execution";
import { knowledgeBaseSearchTool } from "./knowledge-base-search";

function guestContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    beforeToolCall: async () => {},
    channel: "whatsapp",
    orgId: "org_guest_knowledge",
    profileId: "profile_guest_knowledge",
    userId: "user_channel_guest_0123456789abcdef",
    workspaceRoot: "/unused-guest-knowledge-workspace",
    ...overrides,
  };
}

function wrappedKnowledgeTool() {
  const run = mock(async () => ({
    matches: [{ text: "Authorized knowledge" }],
  }));
  const tool: ToolDefinition = {
    channelGuestKnowledgeBaseSafe: true,
    description: "Search the authorized profile knowledge base",
    name: "knowledge_base_search",
    parallelSafe: true,
    run,
  };
  return { run, tool };
}

describe("protected channel guest knowledge access", () => {
  test("executes a marked WhatsApp knowledge search only after authorization", async () => {
    const calls: string[] = [];
    const context = guestContext({
      beforeToolCall: async (toolName) => {
        calls.push(`authorize:${toolName}`);
      },
    });
    const { tool } = wrappedKnowledgeTool();
    tool.run = async (_input, receivedContext) => {
      calls.push("search");
      return {
        orgId: receivedContext.orgId,
        profileId: receivedContext.profileId,
        userId: receivedContext.userId,
      };
    };

    const result = await executeProtectedTool(tool, { query: "SE" }, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      orgId: context.orgId,
      profileId: context.profileId,
      userId: context.userId,
    });
    expect(calls).toEqual(["authorize:knowledge_base_search", "search"]);
  });

  test("rejects the raw built-in knowledge tool for a guest", async () => {
    const result = await executeProtectedTool(
      knowledgeBaseSearchTool,
      { query: "SE" },
      guestContext()
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
  });

  test.each([undefined, false])(
    "rejects a knowledge search with marker %s before execution",
    async (channelGuestKnowledgeBaseSafe) => {
      const { run, tool } = wrappedKnowledgeTool();
      tool.channelGuestKnowledgeBaseSafe = channelGuestKnowledgeBaseSafe;

      const result = await executeProtectedTool(tool, {}, guestContext());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("PERMISSION_DENIED");
      expect(run).not.toHaveBeenCalled();
    }
  );

  test.each(["bash", "memory_write", "read_file", "custom_knowledge_search"])(
    "does not authorize %s with a knowledge marker",
    async (name) => {
      const { run, tool } = wrappedKnowledgeTool();
      tool.name = name;

      const result = await executeProtectedTool(tool, {}, guestContext());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("PERMISSION_DENIED");
      expect(run).not.toHaveBeenCalled();
    }
  );

  const otherChannels: ToolContext["channel"][] = [
    undefined,
    "telegram",
    "discord",
    "web",
    "cli",
    "automation",
    "task",
    "subagent",
  ];
  test.each(otherChannels)(
    "rejects the knowledge marker on channel %s",
    async (channel) => {
      const { run, tool } = wrappedKnowledgeTool();

      const result = await executeProtectedTool(
        tool,
        {},
        guestContext({ channel })
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("PERMISSION_DENIED");
      expect(run).not.toHaveBeenCalled();
    }
  );

  test.each(["beforeToolCall", "orgId", "profileId", "workspaceRoot"] as const)(
    "rejects guest knowledge access without %s",
    async (key) => {
      const { run, tool } = wrappedKnowledgeTool();
      const context = guestContext();
      delete context[key];

      const result = await executeProtectedTool(tool, {}, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("PERMISSION_DENIED");
      expect(run).not.toHaveBeenCalled();
    }
  );

  test("retains the viewer prohibition for a marked knowledge search", async () => {
    const { run, tool } = wrappedKnowledgeTool();
    const result = await executeProtectedTool(
      tool,
      {},
      guestContext({ orgRole: "viewer" })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(run).not.toHaveBeenCalled();
  });

  test("does not execute knowledge search after authorization is revoked", async () => {
    const { run, tool } = wrappedKnowledgeTool();
    const beforeToolCall = mock(async () => {
      throw Object.assign(new Error("Access revoked"), {
        code: "PERMISSION_DENIED",
        retryable: false,
      });
    });

    const result = await executeProtectedTool(
      tool,
      {},
      guestContext({ beforeToolCall })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(beforeToolCall).toHaveBeenCalledWith("knowledge_base_search");
    expect(run).not.toHaveBeenCalled();
  });

  test("rechecks authorization before retrying a marked knowledge search", async () => {
    let revoked = false;
    const { run, tool } = wrappedKnowledgeTool();
    run.mockImplementation(async () => {
      revoked = true;
      throw Object.assign(new Error("Transient search failure"), {
        code: "NETWORK_ERROR",
      });
    });
    tool.retryPolicy = { initialDelayMs: 0, maxRetries: 2 };
    const beforeToolCall = mock(async () => {
      if (revoked) {
        throw Object.assign(new Error("Access revoked"), {
          code: "PERMISSION_DENIED",
          retryable: false,
        });
      }
    });

    const result = await executeProtectedTool(
      tool,
      {},
      guestContext({ beforeToolCall })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(beforeToolCall).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

test.each(["whatsapp", "telegram", "discord"] as const)(
  "retains confined guest file execution on %s",
  async (channel) => {
    const run = mock(async () => ({ content: "An authorized work file" }));
    const beforeToolCall = mock(async () => {});
    const result = await executeProtectedTool(
      {
        channelGuestFileSafe: true,
        description: "Read an artifact-confined work file",
        name: "read_file",
        parallelSafe: true,
        run,
      },
      { path: "artifacts/work.txt" },
      guestContext({ beforeToolCall, channel })
    );

    expect(result.success).toBe(true);
    expect(beforeToolCall).toHaveBeenCalledWith("read_file");
    expect(run).toHaveBeenCalledTimes(1);
  }
);
