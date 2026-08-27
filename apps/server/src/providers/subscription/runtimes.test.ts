import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { ChatCompletionResult, GenerateChatInput } from "@atlas/core";
import { runWithUserConfigDir } from "@atlas/core";
import { createChatgptProvider } from "./chatgpt/provider";
import { ChatgptSubscriptionRuntime } from "./chatgpt/runtime";
import { ClaudeSubscriptionRuntime } from "./claude/runtime";
import {
  deleteSubscriptionConversation,
  setChatgptRuntimeForTests,
  setClaudeRuntimeForTests,
} from "./runtimes";
import {
  readSubscriptionSession,
  writeSubscriptionSession,
} from "./session-store";

class RecordingChatgptRuntime extends ChatgptSubscriptionRuntime {
  constructor(
    private readonly deleteSession: (runtimeSessionId: string) => Promise<void>
  ) {
    super();
  }

  override async deleteConversationSession(
    runtimeSessionId: string
  ): Promise<void> {
    await this.deleteSession(runtimeSessionId);
  }
}

class RecordingClaudeRuntime extends ClaudeSubscriptionRuntime {
  constructor(
    private readonly deleteSession: (runtimeSessionId: string) => Promise<void>
  ) {
    super();
  }

  override async deleteConversationSession(
    runtimeSessionId: string
  ): Promise<void> {
    await this.deleteSession(runtimeSessionId);
  }
}

class ControlledChatgptRuntime extends RecordingChatgptRuntime {
  constructor(
    deleteSession: (runtimeSessionId: string) => Promise<void>,
    private readonly run: (input: GenerateChatInput) => Promise<void>
  ) {
    super(deleteSession);
  }

  override async generateChat(
    input: GenerateChatInput
  ): Promise<ChatCompletionResult> {
    await this.run(input);
    return {
      assistantMessage: { content: "done", role: "assistant" },
      content: "done",
      toolCalls: [],
    };
  }
}

describe("subscription native session deletion", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    setChatgptRuntimeForTests(null);
    setClaudeRuntimeForTests(null);
    for (const directory of temporaryDirectories) {
      await rm(directory, { force: true, recursive: true });
    }
    temporaryDirectories.length = 0;
  });

  test("retains failed bindings so native deletion can be retried", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-delete-");
    temporaryDirectories.push(directory);
    const deleted: string[] = [];
    setChatgptRuntimeForTests(
      new RecordingChatgptRuntime(async (runtimeSessionId) => {
        deleted.push(runtimeSessionId);
      })
    );
    setClaudeRuntimeForTests(
      new RecordingClaudeRuntime(async () => {
        throw new Error("temporary native deletion failure");
      })
    );

    await runWithUserConfigDir(directory, async () => {
      await writeSubscriptionSession("chatgpt", "conversation-1", {
        lastMessageCount: 1,
        runtimeSessionId: "codex-thread",
      });
      await writeSubscriptionSession("claude", "conversation-1", {
        lastMessageCount: 1,
        runtimeSessionId: "claude-session",
      });

      await expect(
        deleteSubscriptionConversation("conversation-1")
      ).rejects.toThrow("Could not delete every native subscription session");
      expect(deleted).toEqual(["codex-thread"]);
      expect(
        await readSubscriptionSession("chatgpt", "conversation-1")
      ).toBeNull();
      expect(
        await readSubscriptionSession("claude", "conversation-1")
      ).toMatchObject({ runtimeSessionId: "claude-session" });

      setClaudeRuntimeForTests(
        new RecordingClaudeRuntime(async (runtimeSessionId) => {
          deleted.push(runtimeSessionId);
        })
      );
      await deleteSubscriptionConversation("conversation-1");

      expect(deleted).toEqual(["codex-thread", "claude-session"]);
      expect(
        await readSubscriptionSession("claude", "conversation-1")
      ).toBeNull();
    });
  });

  test("discards and deletes a binding written by a cancelled in-flight turn", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-delete-");
    temporaryDirectories.push(directory);
    const deleted: string[] = [];
    let markStarted: () => void = () => undefined;
    let releaseTurn: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    setChatgptRuntimeForTests(
      new ControlledChatgptRuntime(
        async (runtimeSessionId) => {
          deleted.push(runtimeSessionId);
        },
        async (input) => {
          markStarted();
          await release;
          await writeSubscriptionSession(
            "chatgpt",
            input.conversationId ?? "",
            {
              lastMessageCount: input.messages.length,
              runtimeSessionId: "late-codex-thread",
            }
          );
        }
      )
    );

    await runWithUserConfigDir(directory, async () => {
      const provider = createChatgptProvider({ model: "gpt-test" });
      const turn = provider.generateChat({
        conversationId: "conversation-race",
        messages: [{ content: "hello", role: "user" }],
        system: "You are Atlas.",
      });
      await started;

      const deletion = deleteSubscriptionConversation("conversation-race");
      releaseTurn();
      await turn;
      await deletion;

      expect(deleted).toEqual(["late-codex-thread"]);
      expect(
        await readSubscriptionSession("chatgpt", "conversation-race")
      ).toBeNull();
    });
  });

  test("treats an already-missing native thread as successfully deleted", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-delete-");
    temporaryDirectories.push(directory);
    setChatgptRuntimeForTests(
      new RecordingChatgptRuntime(async () => {
        throw new Error("Thread was not found because it was already deleted");
      })
    );

    await runWithUserConfigDir(directory, async () => {
      await writeSubscriptionSession("chatgpt", "conversation-missing", {
        lastMessageCount: 1,
        runtimeSessionId: "missing-codex-thread",
      });

      await expect(
        deleteSubscriptionConversation("conversation-missing")
      ).resolves.toBeUndefined();
      expect(
        await readSubscriptionSession("chatgpt", "conversation-missing")
      ).toBeNull();
    });
  });
});
