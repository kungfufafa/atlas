import { describe, expect, test } from "bun:test";
import type { ChatListItem } from "@/lib/chat-history";
import {
  clearFailedChatTurn,
  readFailedChatTurn,
  storeFailedChatTurn,
} from "@/lib/chat-history";
import {
  appendFailedTurnIfNeeded,
  buildChatAttachmentScopeKey,
  canSelectSessionModel,
  findFailedRetryPrompt,
  isSupersededChatTurn,
  markStreamingTurnFailed,
  messagesWithoutFailedTurn,
  resolveFailedRetryPayload,
  resolveProfileIdForWorkspaceProfiles,
  shouldResetChatOnWorkspaceChange,
} from "./chat-page.shared";

function user(
  content: string,
  extras: Partial<ChatListItem> = {}
): ChatListItem {
  return { content, id: `user-${content}`, role: "user", ...extras };
}

function assistant(
  content: string,
  extras: Partial<ChatListItem> = {}
): ChatListItem {
  return {
    content,
    id: `assistant-${content || "empty"}`,
    role: "assistant",
    ...extras,
  };
}

describe("session model selection access", () => {
  test("allows drafts and authorized sessions but blocks non-owners and read-only chat", () => {
    expect(
      canSelectSessionModel({
        canUpdateExistingSession: false,
        hasSession: false,
        readOnlySession: false,
        workspaceReadOnly: false,
      })
    ).toBe(true);
    expect(
      canSelectSessionModel({
        canUpdateExistingSession: true,
        hasSession: true,
        readOnlySession: false,
        workspaceReadOnly: false,
      })
    ).toBe(true);
    expect(
      canSelectSessionModel({
        canUpdateExistingSession: false,
        hasSession: true,
        readOnlySession: false,
        workspaceReadOnly: false,
      })
    ).toBe(false);
    expect(
      canSelectSessionModel({
        canUpdateExistingSession: true,
        hasSession: true,
        readOnlySession: false,
        workspaceReadOnly: true,
      })
    ).toBe(false);
  });
});

describe("workspace chat reset", () => {
  test("resets only when the workspace id actually changes", () => {
    expect(shouldResetChatOnWorkspaceChange(null, "org_b")).toBe(false);
    expect(shouldResetChatOnWorkspaceChange("org_a", "org_a")).toBe(false);
    expect(shouldResetChatOnWorkspaceChange("org_a", "org_b")).toBe(true);
  });

  test("treats a bumped stream generation as a superseded turn", () => {
    expect(isSupersededChatTurn(1, 1)).toBe(false);
    expect(isSupersededChatTurn(2, 1)).toBe(true);
  });

  test("isolates attachment drafts across orgs, profiles, sessions, and draft routes", () => {
    const scope = (overrides: {
      draftKey?: string;
      orgId?: string;
      profileId?: string;
      sessionId?: string;
    }) =>
      buildChatAttachmentScopeKey({
        draftKey: overrides.draftKey ?? "draft-a",
        orgId: overrides.orgId ?? "org-a",
        profileId: overrides.profileId ?? "profile-a",
        sessionId: overrides.sessionId,
      });
    const baseline = scope({});

    expect(scope({ orgId: "org-b" })).not.toBe(baseline);
    expect(scope({ profileId: "profile-b" })).not.toBe(baseline);
    expect(scope({ sessionId: "session-a" })).not.toBe(baseline);
    expect(scope({ draftKey: "draft-b" })).not.toBe(baseline);
  });

  test("keeps the current profile when it still exists after a workspace change", () => {
    expect(
      resolveProfileIdForWorkspaceProfiles({
        currentProfileId: "p1",
        profiles: [{ id: "p1" }, { id: "p2" }],
        search: "",
      })
    ).toBe("p1");
  });

  test("falls back when the current profile belongs to the previous workspace", () => {
    expect(
      resolveProfileIdForWorkspaceProfiles({
        currentProfileId: "old-org-profile",
        liveChatProfileId: "old-org-profile",
        profiles: [{ id: "default" }, { id: "research" }],
        search: "profile=old-org-profile",
      })
    ).toBe("default");
  });
});

describe("failed chat turns", () => {
  test("turns the active stream into a failed marker", () => {
    const next = markStreamingTurnFailed(
      [user("hello"), assistant("", { id: "stream", streaming: true })],
      "Rate limited"
    );

    expect(next[1]).toMatchObject({
      content: "Rate limited",
      failed: true,
      id: "stream",
      streaming: false,
    });
  });

  test("restores a failed turn after reload without duplicating persisted prompts", () => {
    const failed = { error: "429", text: "retry me" };
    const restored = appendFailedTurnIfNeeded(
      [user("earlier", { historyIndex: 0 })],
      failed
    );
    expect(restored.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);

    const persisted = appendFailedTurnIfNeeded(
      [user("retry me", { historyIndex: 2 })],
      failed
    );
    expect(persisted.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("finds the failed prompt and removes only optimistic messages", () => {
    const failed = assistant("429", { failed: true, id: "failed" });
    const messages = [
      user("kept", { historyIndex: 0 }),
      user("retry me"),
      failed,
    ];

    expect(findFailedRetryPrompt(messages, failed)?.content).toBe("retry me");
    expect(messagesWithoutFailedTurn(messages, failed)).toEqual([
      user("kept", { historyIndex: 0 }),
    ]);
  });

  test("removes the complete optimistic turn when tools ran before failure", () => {
    const failed = assistant("Provider failed", {
      failed: true,
      id: "failed",
    });
    const kept = assistant("Earlier answer", { historyIndex: 1 });
    const messages: ChatListItem[] = [
      user("earlier", { historyIndex: 0 }),
      kept,
      user("retry with file", {
        retryFiles: [
          {
            filename: "notes.md",
            mediaType: "text/markdown",
            type: "file",
            url: "data:text/markdown;base64,IyBOb3Rlcw==",
          },
        ],
      }),
      assistant("", { thinking: "Checking", thinkingStreaming: false }),
      {
        content: "done",
        id: "tool",
        role: "tool",
        tool: "read_file",
        toolStatus: "done",
      },
      failed,
    ];

    expect(messagesWithoutFailedTurn(messages, failed)).toEqual([
      user("earlier", { historyIndex: 0 }),
      kept,
    ]);
  });

  test("reuses in-memory attachments for failed-turn retry", () => {
    const retryFile = {
      filename: "notes.md",
      mediaType: "text/markdown",
      type: "file" as const,
      url: "data:text/markdown;base64,IyBOb3Rlcw==",
    };
    const prompt = user("", {
      documents: [{ filename: "notes.md", mediaType: "text/markdown" }],
      retryFiles: [retryFile],
    });
    const failedMessages = markStreamingTurnFailed(
      [prompt, assistant("", { id: "stream", streaming: true })],
      "Provider failed after acceptance"
    );
    const failedMessage = failedMessages[1]!;
    const failedPrompt = findFailedRetryPrompt(failedMessages, failedMessage);
    const retryPayload = resolveFailedRetryPayload(failedPrompt);

    expect(retryPayload).toEqual({
      files: [retryFile],
      status: "ready",
      text: "",
    });
    if (retryPayload.status === "ready") {
      expect(retryPayload.files).not.toBe(failedPrompt?.retryFiles);
    }
    expect(messagesWithoutFailedTurn(failedMessages, failedMessage)).toEqual(
      []
    );
    expect(
      resolveFailedRetryPayload(
        user("summarize", {
          documents: [{ filename: "lost.md", mediaType: "text/markdown" }],
        })
      )
    ).toEqual({ status: "attachments_unavailable" });
    expect(
      resolveFailedRetryPayload(
        user("describe", {
          imageAttachments: [
            {
              description: "A diagram",
              mediaType: "image/png",
            },
          ],
        })
      )
    ).toEqual({ status: "attachments_unavailable" });
    expect(resolveFailedRetryPayload(user("retry text"))).toEqual({
      files: [],
      status: "ready",
      text: "retry text",
    });
  });

  test("round-trips failed-turn storage and rejects malformed payloads", () => {
    const store = new Map<string, string>();
    const previousLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => {
          store.delete(key);
        },
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    });

    try {
      const failedTurnWithRetrySnapshot = {
        error: "Rate limit",
        retryFiles: [
          {
            filename: "secret.md",
            mediaType: "text/markdown",
            type: "file",
            url: "data:text/markdown;base64,c2VjcmV0",
          },
        ],
        text: "hello",
      };
      storeFailedChatTurn("session-failed", failedTurnWithRetrySnapshot);
      expect(readFailedChatTurn("session-failed")).toEqual({
        error: "Rate limit",
        text: "hello",
      });
      expect(store.get("atlas:failed-chat-turn:session-failed")).toBe(
        JSON.stringify({ error: "Rate limit", text: "hello" })
      );

      clearFailedChatTurn("session-failed");
      expect(readFailedChatTurn("session-failed")).toBeNull();

      store.set(
        "atlas:failed-chat-turn:session-malformed",
        JSON.stringify({ error: "missing text" })
      );
      expect(readFailedChatTurn("session-malformed")).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: previousLocalStorage,
      });
    }
  });
});
