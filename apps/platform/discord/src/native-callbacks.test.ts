import { expect, test } from "bun:test";
import {
  type DiscordCallbackBinding,
  type DiscordCallbackOrigin,
  DiscordCallbackRegistry,
} from "./native-callbacks";

const binding: DiscordCallbackBinding = {
  channelAddressed: true,
  channelChatId: "channel-a",
  channelId: "channel-a",
  channelOrgKey: "org-channel-a",
  channelUserId: "sender-a",
  conversationKey: "conversation-a",
  guildId: "guild-a",
  orgId: "tenant-a",
  profileId: "profile-a",
  sessionId: "session-a",
};
const origin: DiscordCallbackOrigin = {
  channelId: binding.channelId,
  channelUserId: binding.channelUserId,
  guildId: binding.guildId,
  messageId: "message-a",
};

test("native callback is opaque, message-bound, and consumable exactly once", () => {
  const registry = new DiscordCallbackRegistry<{ decision: string }>();
  const ticket = registry.issue(binding, { decision: "approved" });
  expect(ticket.customId.length).toBeLessThanOrEqual(100);
  expect(ticket.customId).not.toContain(binding.sessionId);
  expect(registry.claim(ticket.customId, origin)).toBeNull();
  ticket.bindMessage("message-a");
  expect(registry.claim(ticket.customId, origin)).toEqual({
    binding,
    messageId: "message-a",
    value: { decision: "approved" },
  });
  expect(registry.claim(ticket.customId, origin)).toBeNull();
});

test.each([
  { channelUserId: "sender-b" },
  { channelId: "channel-b" },
  { guildId: "guild-b" },
  { guildId: null },
  { messageId: "message-b" },
  { messageId: null },
])(
  "foreign callback origin %j cannot consume the owner's ticket",
  (override) => {
    const registry = new DiscordCallbackRegistry<string>();
    const ticket = registry.issue(binding, "choice-a");
    ticket.bindMessage("message-a");
    expect(
      registry.claim(ticket.customId, { ...origin, ...override })
    ).toBeNull();
    expect(registry.claim(ticket.customId, origin)?.value).toBe("choice-a");
  }
);

test("expired, revoked, and forged callback IDs perform no action", () => {
  let now = 100;
  const registry = new DiscordCallbackRegistry<string>({
    now: () => now,
    ttlMs: 50,
  });
  const expired = registry.issue(binding, "expired");
  expired.bindMessage("message-a");
  now = 150;
  expect(registry.claim(expired.customId, origin)).toBeNull();
  const revoked = registry.issue(binding, "revoked");
  revoked.bindMessage("message-a");
  revoked.revoke();
  expect(registry.claim(revoked.customId, origin)).toBeNull();
  expect(registry.claim("atlas:forged", origin)).toBeNull();
});

test("session revocation preserves another tenant's ticket", () => {
  const registry = new DiscordCallbackRegistry<string>();
  const first = registry.issue(binding, "first");
  const second = registry.issue(
    { ...binding, orgId: "tenant-b", sessionId: "session-b" },
    "second"
  );
  first.bindMessage("message-a");
  second.bindMessage("message-a");
  registry.revokeSession(binding.sessionId);
  expect(registry.claim(first.customId, origin)).toBeNull();
  expect(registry.claim(second.customId, origin)?.binding.orgId).toBe(
    "tenant-b"
  );
});

test("bound messages cannot be replaced and capacity is reclaimed after expiry", () => {
  let now = 0;
  const registry = new DiscordCallbackRegistry<string>({
    capacity: 1,
    now: () => now,
    ttlMs: 1,
  });
  const first = registry.issue(binding, "first");
  first.bindMessage("message-a");
  expect(() => first.bindMessage("message-b")).toThrow();
  expect(() => registry.issue(binding, "second")).toThrow();
  now = 1;
  expect(registry.issue(binding, "second").customId).not.toBe(first.customId);
});
