import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { runWithUserConfigDir, type SubscriptionAuthState } from "@atlas/core";
import { readSubscriptionSession } from "../session-store";
import { type ClaudeAgentSdk, ClaudeSubscriptionRuntime } from "./runtime";

class AuthenticatedRuntime extends ClaudeSubscriptionRuntime {
  override async getAuthState(): Promise<SubscriptionAuthState> {
    return { authenticated: true, provider: "claude", status: "authenticated" };
  }
}

async function withTemporaryConfig(run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp("/tmp/atlas-claude-integrity-");
  try {
    await runWithUserConfigDir(directory, run);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function runtimeWithMessages(messages: unknown[]) {
  const deleted: string[] = [];
  const sdk: ClaudeAgentSdk = {
    deleteSession: async (id) => {
      deleted.push(id);
    },
    query: () => ({
      async *[Symbol.asyncIterator]() {
        for (const message of messages) {
          yield message;
        }
      },
    }),
  };
  return { deleted, runtime: new AuthenticatedRuntime({ sdk }) };
}

function delta(kind: "text" | "thinking", text: string): unknown {
  return {
    event: {
      delta: { type: `${kind}_delta`, [kind]: text },
      type: "content_block_delta",
    },
    type: "stream_event",
  };
}

function success(text: string): unknown {
  return {
    result: text,
    session_id: "native-session",
    subtype: "success",
    type: "result",
  };
}

describe("Claude runtime stream integrity", () => {
  test("preserves repeated delta fragments and emits the terminal snapshot tail once", async () => {
    const { runtime } = runtimeWithMessages([
      delta("text", "ha"),
      delta("text", "ha"),
      delta("text", "haha"),
      success("hahahaha!"),
    ]);
    const chunks: string[] = [];
    await withTemporaryConfig(async () => {
      const result = await runtime.streamChat(
        { messages: [{ content: "Repeat", role: "user" }], system: "Atlas" },
        { onChunk: (chunk) => chunks.push(chunk) }
      );
      expect(result.content).toBe("hahahaha!");
    });
    expect(chunks).toEqual(["ha", "ha", "haha", "!"]);
  });

  test("keeps thinking in nonstreaming results without a thinking callback", async () => {
    const { runtime } = runtimeWithMessages([
      {
        message: {
          content: [
            { thinking: "Check the evidence.", type: "thinking" },
            { text: "Verified.", type: "text" },
          ],
        },
        type: "assistant",
      },
      success("Verified."),
    ]);
    await withTemporaryConfig(async () => {
      const result = await runtime.generateChat({
        messages: [{ content: "Verify", role: "user" }],
        system: "Atlas",
      });
      expect(result.assistantMessage.thinking).toBe("Check the evidence.");
    });
  });

  test("appends repeated thinking deltas without duplicating the completed thinking snapshot", async () => {
    const { runtime } = runtimeWithMessages([
      delta("thinking", "a"),
      delta("thinking", "a"),
      {
        message: { content: [{ thinking: "aa", type: "thinking" }] },
        type: "assistant",
      },
      success("Done"),
    ]);
    const thoughts: string[] = [];
    await withTemporaryConfig(async () => {
      const result = await runtime.streamChat(
        { messages: [{ content: "Check", role: "user" }], system: "Atlas" },
        {
          onChunk: () => undefined,
          onThinking: (chunk) => thoughts.push(chunk),
        }
      );
      expect(result.assistantMessage.thinking).toBe("aa");
    });
    expect(thoughts).toEqual(["a", "a"]);
  });

  test.each([
    {
      label: "missing terminal result",
      messages: [
        {
          message: { content: [{ text: "Partial answer", type: "text" }] },
          session_id: "native-session",
          type: "assistant",
        },
      ],
    },
    {
      label: "malformed tool call",
      messages: [
        success(
          '```atlas-tool-call\n{"name":"read_file","arguments":"bad"}\n```'
        ),
      ],
    },
  ])(
    "rejects $label and removes the unusable native session",
    async ({ messages }) => {
      const { runtime, deleted } = runtimeWithMessages(messages);
      const chunks: string[] = [];
      await withTemporaryConfig(async () => {
        await expect(
          runtime.streamChat(
            {
              conversationId: "conversation",
              messages: [{ content: "Read", role: "user" }],
              system: "Atlas",
              tools: [
                {
                  description: "Read",
                  name: "read_file",
                  parameters: { type: "object" },
                },
              ],
            },
            { onChunk: (chunk) => chunks.push(chunk) }
          )
        ).rejects.toMatchObject({ code: "runtime_error" });
        expect(
          await readSubscriptionSession("claude", "conversation")
        ).toBeNull();
      });
      expect(deleted).toEqual(["native-session"]);
      expect(chunks).toEqual([]);
    }
  );
});
