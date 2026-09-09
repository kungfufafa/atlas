import { expect, test } from "bun:test";
import type { AtlasClient } from "@atlas/client";
import type {
  ChannelNativeAction,
  ChannelNativeActionRequest,
} from "@atlas/core/channel-native-actions";
import {
  ChannelType,
  type Client,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import {
  DiscordMessageOwners,
  dispatchDiscordNativeAction,
} from "./native-actions";
import type { DiscordCallbackBinding } from "./native-callbacks";
import type { ThreadStore } from "./thread-store";
import { discordPcmToWav } from "./voice-session";

function fixture(
  action: ChannelNativeAction,
  channelType: ChannelType = ChannelType.GuildText
) {
  const calls: string[] = [];
  const payloads: unknown[] = [];
  let senderPermissions = PermissionsBitField.All;
  let botPermissions = PermissionsBitField.All;
  let transportFails = false;
  let authorizationFails = false;
  const isThread = channelType === ChannelType.PublicThread;
  const binding: DiscordCallbackBinding = {
    channelAddressed: true,
    channelChatId: "room",
    channelId: isThread ? "thread" : "room",
    channelOrgKey: "org-room",
    channelThreadId: isThread ? "thread" : undefined,
    channelUserId: "sender",
    conversationKey: "conversation",
    guildId: "guild",
    orgId: "org",
    profileId: "profile",
    sessionId: "session",
  };
  const event: ChannelNativeActionRequest = {
    action,
    channel: "discord",
    channelChatId: binding.channelChatId,
    channelThreadId: binding.channelThreadId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    id: "request",
    orgId: binding.orgId,
    profileId: binding.profileId,
    sessionId: binding.sessionId,
  };
  const owners = new DiscordMessageOwners();
  const mutate = async (kind: string, payload?: unknown) => {
    calls.push(kind);
    payloads.push(payload);
    if (transportFails) {
      throw new Error("transport lost receipt");
    }
    return { id: "sent" };
  };
  const message = {
    author: { id: "bot" },
    channelId: binding.channelId,
    delete: () => mutate("delete"),
    edit: (payload: unknown) => mutate("edit", payload),
    id: "bot-message",
    pin: () => mutate("pin"),
    react: (emoji: string) => mutate("react", emoji),
    unpin: () => mutate("unpin"),
  };
  const channel = {
    edit: (payload: unknown) => mutate("thread-edit", payload),
    guild: {
      members: {
        fetch: async (input: unknown) => {
          calls.push("sender-refresh");
          expect(input).toEqual({ force: true, user: "sender" });
          return { id: "sender" };
        },
        fetchMe: async (input: unknown) => {
          calls.push("bot-refresh");
          expect(input).toEqual({ force: true });
          return { id: "bot" };
        },
      },
      roles: {
        fetch: async () => {
          calls.push("roles-refresh");
        },
      },
    },
    guildId: "guild",
    id: binding.channelId,
    isDMBased: () => false,
    isSendable: () => channelType !== ChannelType.GuildForum,
    isTextBased: () => channelType !== ChannelType.GuildForum,
    isThread: () => isThread,
    messages: {
      fetch: async () => {
        calls.push("message-fetch");
        return message;
      },
    },
    parentId: isThread ? "room" : null,
    permissionsFor: (member: { id: string }) =>
      new PermissionsBitField(
        member.id === "sender" ? senderPermissions : botPermissions
      ),
    send: (payload: unknown) => mutate("send", payload),
    threads: {
      create: async (payload: unknown) => {
        await mutate("thread-create", payload);
        return {
          id: "new-thread",
          send: (content: unknown) => mutate("thread-send", content),
        };
      },
    },
    type: channelType,
  };
  const client = {
    claimChannelAction: async () => {
      calls.push("claim");
      return event;
    },
    completeChannelAction: async (input: { receipt: unknown }) => {
      calls.push("complete");
      payloads.push(input.receipt);
      return { recorded: true };
    },
    readProfileArtifactContent: async (
      profileId: string,
      filePath: string,
      input: unknown
    ) => {
      calls.push("read-artifact");
      expect(profileId).toBe("profile");
      expect(filePath).toBe("artifacts/media.wav");
      expect(input).toEqual({ sessionId: "session" });
      return {
        contentType: "audio/wav",
        data: discordPcmToWav(Buffer.alloc(3840)),
      };
    },
  } as unknown as AtlasClient;
  const context = {
    binding,
    client,
    discord: {
      channels: {
        fetch: async (id: string, input: unknown) => {
          calls.push("channel-refresh");
          expect(id).toBe(binding.channelId);
          expect(input).toEqual({ force: true });
          return channel;
        },
      },
      rest: {
        post: (route: string, payload: unknown) => {
          expect(route).toBe("/channels/room/messages");
          return mutate("voice-send", payload);
        },
      },
      user: { id: "bot" },
    } as unknown as Client<true>,
    inboundMessageId: "bot-message",
    owners,
    reauthorize: async () => {
      calls.push("authorize");
      if (authorizationFails) {
        throw new Error("role revoked");
      }
    },
    threadStore: {
      add: () => {
        calls.push("own-thread");
      },
      hasThreadId: (id: string) => id === "thread",
      save: async () => {
        calls.push("save-thread");
      },
    } as unknown as ThreadStore,
  };
  owners.record(message.id, binding);
  return {
    binding,
    calls,
    channel,
    context,
    denyBot: (permission: bigint) => {
      botPermissions = new PermissionsBitField(botPermissions).remove([
        permission,
        PermissionFlagsBits.Administrator,
      ]).bitfield;
    },
    denySender: (permission: bigint) => {
      senderPermissions = new PermissionsBitField(senderPermissions).remove([
        permission,
        PermissionFlagsBits.Administrator,
      ]).bitfield;
    },
    event,
    failTransport: () => {
      transportFails = true;
    },
    message,
    payloads,
    revoke: () => {
      authorizationFails = true;
    },
  };
}

for (const kind of ["delete", "pin", "unpin"] as const) {
  for (const boundary of ["session", "unrecorded", "human"] as const) {
    test(`${kind} refuses ${boundary} message in the same authorized channel`, async () => {
      const state = fixture({ kind, messageId: "bot-message" });
      if (boundary === "session") {
        state.context.owners.record(state.message.id, {
          ...state.binding,
          sessionId: "other-session",
        });
      } else if (boundary === "unrecorded") {
        state.context.owners = new DiscordMessageOwners();
      } else {
        state.message.author.id = "another-human";
      }
      const receipt = await dispatchDiscordNativeAction(
        state.context,
        state.event
      );
      expect(receipt.status).toBe("failed");
      expect(state.calls).not.toContain(kind);
    });
  }
}

for (const phase of ["create", "save"] as const) {
  for (const change of ["revoked", "aborted"] as const) {
    test(`thread text stops when ${change} during ${phase}; created thread remains uncertain`, async () => {
      const state = fixture({
        kind: "thread_create",
        name: "Discussion",
        text: "Private follow-up",
      });
      const controller = new AbortController();
      const alter = () =>
        change === "revoked" ? state.revoke() : controller.abort();
      if (phase === "create") {
        const create = state.channel.threads.create;
        state.channel.threads.create = async (payload) => {
          const thread = await create(payload);
          alter();
          return thread;
        };
      } else {
        const save = state.context.threadStore.save.bind(
          state.context.threadStore
        );
        state.context.threadStore.save = async () => {
          await save();
          alter();
        };
      }
      const receipt = await dispatchDiscordNativeAction(
        { ...state.context, signal: controller.signal },
        state.event
      );
      expect(
        state.calls.filter((call) => call === "thread-create")
      ).toHaveLength(1);
      expect(state.calls).not.toContain("thread-send");
      expect(receipt.status).toBe("unknown");
    });
  }
}

test("expired claim during artifact read prevents the delayed platform effect", async () => {
  const state = fixture({
    kind: "send_media",
    mode: "document",
    path: "artifacts/media.wav",
  });
  const originalNow = Date.now;
  const now = originalNow();
  let current = now;
  state.event.expiresAt = new Date(now + 1000).toISOString();
  const read = state.context.client.readProfileArtifactContent.bind(
    state.context.client
  );
  state.context.client.readProfileArtifactContent = async (...args) => {
    const result = await read(...args);
    current = now + 1001;
    return result;
  };
  Date.now = () => current;
  try {
    const receipt = await dispatchDiscordNativeAction(
      state.context,
      state.event
    );
    expect(state.calls).toContain("read-artifact");
    expect(state.calls).not.toContain("send");
    expect(receipt.status).toBe("failed");
  } finally {
    Date.now = originalNow;
  }
});

test("claim expiry while saving a created thread prevents its second message effect", async () => {
  const state = fixture({
    kind: "thread_create",
    name: "Discussion",
    text: "Private follow-up",
  });
  const originalNow = Date.now;
  const now = originalNow();
  let current = now;
  state.event.expiresAt = new Date(now + 1000).toISOString();
  const save = state.context.threadStore.save.bind(state.context.threadStore);
  state.context.threadStore.save = async () => {
    await save();
    current = now + 1001;
  };
  Date.now = () => current;
  try {
    const receipt = await dispatchDiscordNativeAction(
      state.context,
      state.event
    );
    expect(state.calls.filter((call) => call === "thread-create")).toHaveLength(
      1
    );
    expect(state.calls).not.toContain("thread-send");
    expect(receipt.status).toBe("unknown");
  } finally {
    Date.now = originalNow;
  }
});

test.each([
  { emoji: "👍", kind: "react" },
  { kind: "edit", messageId: "bot-message", text: "Updated" },
  { kind: "delete", messageId: "bot-message" },
  { kind: "pin", messageId: "bot-message" },
  { kind: "unpin", messageId: "bot-message" },
] satisfies ChannelNativeAction[])(
  "native $kind executes exact Discord action after claim and authorization",
  async (action) => {
    const state = fixture(action);
    const receipt = await dispatchDiscordNativeAction(
      state.context,
      state.event
    );
    expect(receipt).toEqual({ messageId: "bot-message", status: "accepted" });
    expect(state.calls[0]).toBe("claim");
    expect(state.calls.indexOf("authorize")).toBeLessThan(
      state.calls.indexOf(action.kind)
    );
    expect(state.calls.at(-1)).toBe("complete");
  }
);

test("poll uses native options and thread/forum operations preserve returned IDs", async () => {
  const poll = fixture({
    allowMultiple: true,
    durationHours: 2,
    kind: "poll",
    options: ["A", "B"],
    question: "Choose",
  });
  expect(
    (await dispatchDiscordNativeAction(poll.context, poll.event)).status
  ).toBe("accepted");
  expect(poll.payloads[0]).toMatchObject({
    poll: {
      allowMultiselect: true,
      answers: [{ text: "A" }, { text: "B" }],
      duration: 2,
      question: { text: "Choose" },
    },
  });
  const forum = fixture(
    { kind: "topic_create", name: "Topic" },
    ChannelType.GuildForum
  );
  expect(
    (await dispatchDiscordNativeAction(forum.context, forum.event)).messageId
  ).toBe("new-thread");
  expect(forum.payloads[0]).toMatchObject({
    message: { content: "Topic" },
    name: "Topic",
  });
  const thread = fixture({
    kind: "thread_create",
    name: "Thread",
    text: "Opening",
  });
  expect(
    (await dispatchDiscordNativeAction(thread.context, thread.event)).messageId
  ).toBe("new-thread");
  expect(thread.calls).toContain("own-thread");
  expect(thread.calls).toContain("thread-send");
  const edit = fixture(
    { closed: true, kind: "topic_edit", name: "Renamed" },
    ChannelType.PublicThread
  );
  expect(
    (await dispatchDiscordNativeAction(edit.context, edit.event)).messageId
  ).toBe("thread");
  expect(edit.payloads[0]).toEqual({ archived: true, name: "Renamed" });
});

test.each(["audio", "document", "voice"] as const)(
  "native %s media reads exact protected session artifact before upload",
  async (mode) => {
    const state = fixture({
      kind: "send_media",
      mode,
      path: "artifacts/media.wav",
    });
    expect(
      await dispatchDiscordNativeAction(state.context, state.event)
    ).toEqual({ messageId: "sent", status: "accepted" });
    expect(state.calls.indexOf("read-artifact")).toBeLessThan(
      state.calls.indexOf("authorize")
    );
    expect(
      state.calls.filter(
        (call) => call === (mode === "voice" ? "voice-send" : "send")
      )
    ).toHaveLength(1);
    expect(state.context.owners.owns("sent", state.binding)).toBe(true);
    if (mode === "voice") {
      expect(state.payloads[0]).toMatchObject({ body: { flags: 8192 } });
    } else {
      const payload = state.payloads[0] as {
        files: { attachment: Buffer; name: string }[];
      };
      expect(payload.files[0]?.attachment).toEqual(
        discordPcmToWav(Buffer.alloc(3840))
      );
      expect(payload.files[0]?.name).toBe("media.wav");
    }
  }
);

test("native video requires video MIME and voice permission denial happens before artifact access", async () => {
  const video = fixture({
    kind: "send_media",
    mode: "video",
    path: "artifacts/media.wav",
  });
  expect(
    (await dispatchDiscordNativeAction(video.context, video.event)).status
  ).toBe("failed");
  expect(video.calls).not.toContain("send");
  video.context.client.readProfileArtifactContent = async () => ({
    contentType: "video/mp4",
    data: new Uint8Array([0, 1, 2]).buffer,
  });
  expect(
    (await dispatchDiscordNativeAction(video.context, video.event)).status
  ).toBe("accepted");
  const voice = fixture({
    kind: "send_media",
    mode: "voice",
    path: "artifacts/media.wav",
  });
  voice.denySender(PermissionFlagsBits.SendVoiceMessages);
  expect(
    (await dispatchDiscordNativeAction(voice.context, voice.event)).status
  ).toBe("failed");
  expect(voice.calls).not.toContain("read-artifact");
  expect(voice.calls).not.toContain("voice-send");
});

test.each(["sender", "bot", "revoked"])(
  "current %s permission denial prevents native mutation",
  async (mode) => {
    const state = fixture({ kind: "pin", messageId: "bot-message" });
    if (mode === "sender") {
      state.denySender(PermissionFlagsBits.PinMessages);
    }
    if (mode === "bot") {
      state.denyBot(PermissionFlagsBits.PinMessages);
    }
    if (mode === "revoked") {
      state.revoke();
    }
    expect(
      (await dispatchDiscordNativeAction(state.context, state.event)).status
    ).toBe("failed");
    expect(state.calls).not.toContain("pin");
    expect(state.calls.at(-1)).toBe("complete");
  }
);

test("role change is observed by a fresh permission check on the next action", async () => {
  const state = fixture({ kind: "pin", messageId: "bot-message" });
  expect(
    (await dispatchDiscordNativeAction(state.context, state.event)).status
  ).toBe("accepted");
  state.denySender(PermissionFlagsBits.PinMessages);
  expect(
    (await dispatchDiscordNativeAction(state.context, state.event)).status
  ).toBe("failed");
  expect(state.calls.filter((call) => call === "pin")).toHaveLength(1);
  expect(state.calls.filter((call) => call === "sender-refresh")).toHaveLength(
    3
  );
});

test.each([
  "org",
  "session",
  "profile",
  "room",
  "expiry",
  "message-owner",
  "message-room",
])("foreign %s binding fails before mutation", async (boundary) => {
  const state = fixture({
    kind: "edit",
    messageId: "bot-message",
    text: "Updated",
  });
  if (boundary === "org") {
    state.event.orgId = "other";
  }
  if (boundary === "session") {
    state.event.sessionId = "other";
  }
  if (boundary === "profile") {
    state.event.profileId = "other";
  }
  if (boundary === "room") {
    state.event.channelChatId = "other";
  }
  if (boundary === "expiry") {
    state.event.expiresAt = "invalid";
  }
  if (boundary === "message-owner") {
    state.context.owners.record("bot-message", {
      ...state.binding,
      sessionId: "other",
    });
  }
  if (boundary === "message-room") {
    state.message.channelId = "other";
  }
  expect(
    (await dispatchDiscordNativeAction(state.context, state.event)).status
  ).toBe("failed");
  expect(state.calls).not.toContain("edit");
});

test("transport uncertainty is recorded as unknown and completion failure never retries the effect", async () => {
  const state = fixture({ emoji: "👍", kind: "react" });
  state.failTransport();
  expect(
    (await dispatchDiscordNativeAction(state.context, state.event)).status
  ).toBe("unknown");
  expect(state.calls.filter((call) => call === "react")).toHaveLength(1);
  const completed = fixture({ emoji: "👍", kind: "react" });
  completed.context.client.completeChannelAction = async () => {
    throw new Error("server unavailable");
  };
  await expect(
    dispatchDiscordNativeAction(completed.context, completed.event)
  ).rejects.toThrow();
  expect(completed.calls.filter((call) => call === "react")).toHaveLength(1);
});

test("failed claim performs no Discord reads or effects", async () => {
  const state = fixture({ emoji: "👍", kind: "react" });
  state.context.client.claimChannelAction = async () => {
    throw new Error("already claimed");
  };
  await expect(
    dispatchDiscordNativeAction(state.context, state.event)
  ).rejects.toThrow();
  expect(state.calls).toHaveLength(0);
});

test("Discord role revocation during protected artifact loading prevents the pending upload", async () => {
  const state = fixture({
    kind: "send_media",
    mode: "audio",
    path: "artifacts/media.wav",
  });
  const read = state.context.client.readProfileArtifactContent;
  state.context.client.readProfileArtifactContent = async (...args) => {
    const result = await read(...args);
    state.denyBot(PermissionFlagsBits.AttachFiles);
    return result;
  };
  expect(
    (await dispatchDiscordNativeAction(state.context, state.event)).status
  ).toBe("failed");
  expect(state.calls).toContain("read-artifact");
  expect(state.calls.filter((call) => call === "channel-refresh")).toHaveLength(
    2
  );
  expect(state.calls).not.toContain("send");
});

test("turn cancellation during artifact loading stops voice conversion before any native effect", async () => {
  const state = fixture({
    kind: "send_media",
    mode: "voice",
    path: "artifacts/media.wav",
  });
  const controller = new AbortController();
  const read = state.context.client.readProfileArtifactContent;
  state.context.client.readProfileArtifactContent = async (...args) => {
    const result = await read(...args);
    controller.abort();
    return result;
  };
  expect(
    (
      await dispatchDiscordNativeAction(
        { ...state.context, signal: controller.signal },
        state.event
      )
    ).status
  ).toBe("failed");
  expect(state.calls).not.toContain("authorize");
  expect(state.calls).not.toContain("voice-send");
});
