import { expect, spyOn, test } from "bun:test";
import { type AtlasClient, createClient } from "@atlas/client";
import { saveChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import type {
  ChannelActionReceipt,
  ChannelNativeAction,
  ChannelNativeActionRequest,
} from "@atlas/core/channel-native-actions";
import type { Context } from "grammy";
import { setupTestConfigDir } from "../../../server/src/test-config-dir";
import { createNativeChannelHarness } from "../../../server/src/testing/channel-native-harness";
import { TelegramNativeActions } from "./native-actions";
import type { TelegramControlBinding } from "./native-controls";

setupTestConfigDir("atlas-telegram-native-final-authority-");

const binding: TelegramControlBinding = {
  addressed: true,
  channelOrgKey: "g:-100",
  channelUserId: "42",
  chatId: -100,
  isGroup: true,
  orgId: "org_a",
  profileId: "profile_a",
  sessionId: "session_a",
  sessionKey: "key_a",
  threadId: 77,
};
function fixture(action: ChannelNativeAction) {
  const request: ChannelNativeActionRequest = {
    action,
    channel: "telegram",
    channelChatId: "-100",
    channelIsGroup: true,
    channelThreadId: "77",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    id: crypto.randomUUID(),
    orgId: "org_a",
    profileId: "profile_a",
    sessionId: "session_a",
  };
  const effects: Array<{ method: string; args: unknown[] }> = [];
  const receipts: ChannelActionReceipt[] = [];
  const order: string[] = [];
  let denied = false;
  let loseReply = false;
  const native = new TelegramNativeActions();
  native.recordMessage(binding, "101");
  const api = Object.fromEntries(
    [
      "setMessageReaction",
      "sendPoll",
      "editMessageText",
      "deleteMessage",
      "pinChatMessage",
      "unpinChatMessage",
      "createForumTopic",
      "editForumTopic",
      "closeForumTopic",
      "reopenForumTopic",
      "sendDocument",
      "sendVideo",
      "sendAudio",
      "sendVoice",
    ].map((method) => [
      method,
      async (...args: unknown[]) => {
        order.push("platform");
        effects.push({ args, method });
        if (loseReply) {
          throw new Error("Connection closed after dispatch");
        }
        return method.startsWith("send")
          ? { message_id: 202 }
          : method === "createForumTopic"
            ? { icon_color: 0, message_thread_id: 88, name: "New topic" }
            : true;
      },
    ])
  );
  const ctx = {
    api,
    chat: { id: -100, is_forum: true, type: "supergroup" },
    from: { id: 42 },
    message: { message_id: 50, message_thread_id: 77 },
  } as unknown as Context;
  const client = {
    authorizeChannelPrincipal: async () => {
      order.push("authorize-read");
      if (denied) {
        throw new Error("Revoked");
      }
    },
    claimChannelAction: async () => {
      order.push("claim");
      if (denied) {
        throw new Error("Current action policy denied");
      }
      return request;
    },
    completeChannelAction: async ({
      receipt,
    }: {
      receipt: ChannelActionReceipt;
    }) => {
      order.push("receipt");
      receipts.push(receipt);
      return { recorded: true };
    },
    readProfileArtifactContent: async () => ({
      contentType: "text/plain",
      data: new TextEncoder().encode("synthetic current tenant bytes").buffer,
    }),
  } as unknown as AtlasClient;
  return {
    client,
    ctx,
    deny: () => {
      denied = true;
    },
    effects,
    loseReply: () => {
      loseReply = true;
    },
    native,
    order,
    receipts,
    request,
    run: () => native.dispatch({ binding, client, ctx, request }),
  };
}

for (const [action, method] of [
  [{ emoji: "👍", kind: "react" }, "setMessageReaction"],
  [
    {
      allowMultiple: true,
      anonymous: false,
      kind: "poll",
      openPeriodSeconds: 60,
      options: ["A", "B"],
      question: "Choose",
    },
    "sendPoll",
  ],
  [{ kind: "edit", messageId: "101", text: "Updated" }, "editMessageText"],
  [{ kind: "delete", messageId: "101" }, "deleteMessage"],
  [{ kind: "pin", messageId: "101" }, "pinChatMessage"],
  [{ kind: "unpin", messageId: "101" }, "unpinChatMessage"],
  [{ kind: "topic_create", name: "New topic" }, "createForumTopic"],
  [{ kind: "topic_edit", name: "Renamed" }, "editForumTopic"],
  [{ closed: true, kind: "topic_edit" }, "closeForumTopic"],
  [{ closed: false, kind: "topic_edit" }, "reopenForumTopic"],
  [
    { kind: "send_media", mode: "document", path: "artifacts/note.txt" },
    "sendDocument",
  ],
] as const) {
  test(`${action.kind} claims authority before the exact current-room API call and receipt`, async () => {
    const f = fixture(action as ChannelNativeAction);
    await f.run();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]!.method).toBe(method);
    expect(f.effects[0]!.args[0]).toBe(-100);
    expect(f.order[0]).toBe("claim");
    expect(f.order.at(-1)).toBe("receipt");
    expect(f.receipts[0]!.status).toBe("accepted");
    if (action.kind === "poll") {
      expect(f.effects[0]!.args[3]).toMatchObject({
        allows_multiple_answers: true,
        is_anonymous: false,
        message_thread_id: 77,
        open_period: 60,
      });
    }
    if (action.kind === "topic_edit") {
      expect(f.effects[0]!.args[1]).toBe(77);
    }
  });
}

test("denied or stale action permission causes no platform operation", async () => {
  const f = fixture({ emoji: "👍", kind: "react" });
  f.deny();
  await expect(f.run()).rejects.toThrow();
  expect(f.effects).toEqual([]);
  expect(f.receipts).toEqual([]);
});

for (const change of [
  "orgId",
  "profileId",
  "sessionId",
  "channelChatId",
  "channelThreadId",
] as const) {
  test(`foreign ${change} is rejected before claim or dispatch`, async () => {
    const f = fixture({ emoji: "👍", kind: "react" });
    f.request[change] = "foreign";
    await expect(f.run()).rejects.toThrow();
    expect(f.order).toEqual([]);
    expect(f.effects).toEqual([]);
  });
}

test("unknown message IDs and reacted inbound messages never become bot-owned mutation targets", async () => {
  const f = fixture({ emoji: "👍", kind: "react" });
  await f.run();
  f.request.id = crypto.randomUUID();
  f.request.action = { kind: "delete", messageId: "50" };
  await f.run();
  expect(f.effects).toHaveLength(1);
  expect(f.receipts.at(-1)!.status).not.toBe("accepted");
});

test("lost platform acknowledgement reports unknown and replays cannot duplicate delivery", async () => {
  const f = fixture({ kind: "poll", options: ["A", "B"], question: "Q" });
  f.loseReply();
  await f.run();
  expect(f.effects).toHaveLength(1);
  expect(f.receipts[0]!.status).toBe("unknown");
  await expect(f.run()).rejects.toThrow();
  expect(f.effects).toHaveLength(1);
});

test("foreign artifact path is refused with zero artifact reads or sends", async () => {
  const f = fixture({
    kind: "send_media",
    mode: "document",
    path: "../other_tenant/secret.txt",
  });
  await f.run();
  expect(f.order).toEqual(["claim", "receipt"]);
  expect(f.effects).toEqual([]);
  expect(f.receipts[0]!.status).toBe("failed");
});

test("stale request never claims authority", async () => {
  const f = fixture({ emoji: "👍", kind: "react" });
  f.request.expiresAt = new Date(0).toISOString();
  await expect(f.run()).rejects.toThrow();
  expect(f.order).toEqual([]);
});

for (const change of [
  "unchanged",
  "viewer",
  "unassigned",
  "disabled",
] as const) {
  test(`native media rechecks ${change} authority after deferred artifact read through real HTTP and SQLite`, async () => {
    const h = await createNativeChannelHarness("telegram", 5000);
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    try {
      const f = fixture({
        kind: "send_media",
        mode: "document",
        path: "artifacts/note.txt",
      });
      const actor = {
        ...h.actor,
        channelChatId: "-100",
        channelThreadId: "77",
      };
      const currentBinding = {
        ...binding,
        channelUserId: actor.channelUserId,
        orgId: h.orgId,
        profileId: h.profileId,
        sessionId: h.sessionId,
      };
      const ctx = {
        ...f.ctx,
        from: { id: Number(actor.channelUserId) },
      } as Context;
      const client = createClient({
        authToken: h.token,
        baseUrl: "http://localhost:4310",
        fetch: ((url, init) =>
          h.app.fetch(new Request(url, init))) as typeof fetch,
        orgId: h.orgId,
        tokenAuth: true,
      });
      client.readProfileArtifactContent = async () => {
        readStarted.resolve();
        await releaseRead.promise;
        return {
          contentType: "text/plain",
          data: new TextEncoder().encode("current tenant bytes").buffer,
        };
      };
      await client.bindChannelActionContext(actor);
      const emitted = Promise.withResolvers<ChannelNativeActionRequest>();
      const receipt = h.service.request(
        h.context,
        f.request.action,
        emitted.resolve
      );
      const request = await emitted.promise;
      const running = f.native.dispatch({
        binding: currentBinding,
        client,
        ctx,
        request,
      });
      await readStarted.promise;
      expect(f.effects).toEqual([]);
      if (change === "viewer") {
        await h.db.upsertOrgMember({
          createdAt: new Date().toISOString(),
          orgId: h.orgId,
          role: "viewer",
          userId: h.userId,
        });
      } else if (change === "unassigned") {
        await h.db.unassignToolFromProfile(
          h.profileId,
          "native_action_fixture"
        );
      } else if (change === "disabled") {
        await saveChannelIntegrationPolicy(h.orgId, "telegram", {
          actions: { send_media: false },
          version: 1,
        });
      }
      releaseRead.resolve();
      await running;
      const recorded = await receipt;
      expect(f.effects).toHaveLength(change === "unchanged" ? 1 : 0);
      expect(recorded.status).toBe(
        change === "unchanged" ? "accepted" : "failed"
      );
    } finally {
      releaseRead.resolve();
      h.database.close();
    }
  });
}

for (const interruption of ["expired", "aborted"] as const) {
  test(`native media ${interruption} during deferred read has no platform effect`, async () => {
    const f = fixture({
      kind: "send_media",
      mode: "document",
      path: "artifacts/note.txt",
    });
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const controller = new AbortController();
    const now = Date.now();
    f.client.readProfileArtifactContent = async () => {
      readStarted.resolve();
      await releaseRead.promise;
      return {
        contentType: "text/plain",
        data: new TextEncoder().encode("synthetic").buffer,
      };
    };
    const running = f.native.dispatch({
      binding,
      client: f.client,
      ctx: f.ctx,
      request: f.request,
      signal: controller.signal,
    });
    await readStarted.promise;
    const clock =
      interruption === "expired"
        ? spyOn(Date, "now").mockReturnValue(now + 120_000)
        : undefined;
    try {
      if (interruption === "aborted") {
        controller.abort();
      }
      releaseRead.resolve();
      await running;
      expect(f.effects).toEqual([]);
      expect(f.receipts[0]?.status).toBe("failed");
    } finally {
      clock?.mockRestore();
      releaseRead.resolve();
    }
  });
}
