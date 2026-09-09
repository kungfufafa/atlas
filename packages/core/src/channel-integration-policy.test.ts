import { describe, expect, test } from "bun:test";
import {
  assertChannelIntegrationPolicy,
  type ChannelIntegrationPolicy,
  type ChannelIntegrationRule,
  channelIntegrationPolicySchema,
  effectiveChannelRules,
} from "./channel-integration-policy";
import type { CanonicalPrincipal } from "./identity/principal";

const channels = ["telegram", "whatsapp", "discord"] as const;
const layers = [
  "mode",
  "room-wildcard",
  "room",
  "thread",
  "sender-wildcard",
  "sender",
] as const;
const restrictions = [
  "disabled",
  "blacklist",
  "empty-whitelist",
  "role",
  "tool",
  "action",
  "mention",
] as const;

describe("intersection of integration policy layers; no privileged bypass", () => {
  for (const channel of channels) {
    for (const layer of layers) {
      test(`${channel}/${layer}: every restrictive rule wins over a broader allow`, () => {
        const sender =
          channel === "whatsapp" ? "6281111111111@s.whatsapp.net" : "123456789";
        const origin = {
          channelAddressed: false,
          channelChatId: "room",
          channelIsGroup: true,
          channelThreadId: "topic",
          channelUserId: sender,
        };
        for (const role of ["admin", "member", "platform-admin"] as const) {
          const principal: CanonicalPrincipal = {
            isPlatformAdmin: role === "platform-admin",
            orgId: "org",
            orgRole: role === "member" ? "member" : "admin",
            userId: "user",
          };
          for (const restriction of restrictions) {
            const rule: ChannelIntegrationRule = {};
            if (restriction === "disabled") {
              rule.enabled = false;
            }
            if (restriction === "blacklist") {
              rule.blockedSenders = [sender];
            }
            if (restriction === "empty-whitelist") {
              rule.allowedSenders = [];
            }
            if (restriction === "role") {
              rule.roles = [];
            }
            if (restriction === "tool") {
              rule.allowedTools = [];
            }
            if (restriction === "action") {
              rule.actions = { poll: false };
            }
            if (restriction === "mention") {
              rule.requireMention = true;
            }
            const policy: ChannelIntegrationPolicy = {
              actions: { poll: true },
              enabled: true,
              groups: {
                allowedSenders: ["*"],
                allowedTools: ["*"],
                requireMention: false,
              },
              version: 1,
            };
            if (layer === "mode") {
              policy.groups = { ...policy.groups, ...rule };
            }
            if (layer === "room-wildcard") {
              policy.rooms = { "*": rule };
            }
            if (layer === "room") {
              policy.rooms = { room: rule };
            }
            if (layer === "thread") {
              policy.rooms = { topic: rule };
            }
            if (layer === "sender-wildcard") {
              policy.senders = { "*": rule };
            }
            if (layer === "sender") {
              policy.senders = { [sender]: rule };
            }
            expect(() =>
              assertChannelIntegrationPolicy(
                policy,
                channel,
                origin,
                principal,
                { action: "poll", tool: "channel_action" }
              )
            ).toThrow();
          }
        }
      });
    }
  }
});

test("WhatsApp numeric and PN/LID sender keys preserve every deny across aliases", () => {
  const origin = {
    channelAddressed: true,
    channelChatId: "group@g.us",
    channelIsGroup: true,
    channelUserAliases: ["6281111111111@s.whatsapp.net"],
    channelUserId: "154352568283178@lid",
  };
  const policy: ChannelIntegrationPolicy = {
    senders: {
      "6281111111111": { allowedTools: [] },
      "154352568283178@lid": { allowedTools: ["*"] },
    },
    version: 1,
  };
  const principal: CanonicalPrincipal = {
    isPlatformAdmin: true,
    orgId: "org",
    orgRole: "admin",
    userId: "user",
  };
  expect(effectiveChannelRules(policy, "whatsapp", origin)).toHaveLength(2);
  expect(() =>
    assertChannelIntegrationPolicy(policy, "whatsapp", origin, principal, {
      tool: "bash",
    })
  ).toThrow();
  expect(() =>
    assertChannelIntegrationPolicy(
      {
        groups: {
          allowedSenders: ["6281111111111"],
          blockedSenders: ["154352568283178@lid"],
        },
        version: 1,
      },
      "whatsapp",
      origin,
      principal
    )
  ).toThrow();
});

test("missing channel origin, explicit empty lists, and false are never treated as absent", () => {
  const principal: CanonicalPrincipal = {
    isPlatformAdmin: false,
    orgId: "org",
    orgRole: "member",
    userId: "user",
  };
  const origin = {
    channelChatId: "room",
    channelIsGroup: false,
    channelUserId: "123",
  };
  expect(() =>
    assertChannelIntegrationPolicy(
      { version: 1 },
      "telegram",
      { channelUserId: "123" },
      principal
    )
  ).not.toThrow();
  expect(() =>
    assertChannelIntegrationPolicy(
      { senders: { "123": { requireMention: true } }, version: 1 },
      "telegram",
      { channelUserId: "123" },
      principal
    )
  ).toThrow();
  expect(() =>
    assertChannelIntegrationPolicy(
      { dm: { enabled: true }, groups: { enabled: false }, version: 1 },
      "telegram",
      origin,
      principal
    )
  ).not.toThrow();
  expect(() =>
    assertChannelIntegrationPolicy(
      { approvals: false, version: 1 },
      "telegram",
      origin,
      principal,
      { approval: true }
    )
  ).toThrow();
  const policy: ChannelIntegrationPolicy = {
    actions: { react: false },
    approvals: false,
    enabled: false,
    groups: {
      allowedSenders: [],
      allowedTools: [],
      requireMention: false,
      roles: [],
    },
    version: 1,
  };
  expect(channelIntegrationPolicySchema.parse(policy)).toEqual(policy);
});

test("policy rejects prototype keys, extra fields, invalid limits and incomplete explicit speech selections", () => {
  for (const value of [
    JSON.parse('{"version":1,"rooms":{"__proto__":{"enabled":true}}}'),
    { rooms: { constructor: { enabled: true } }, version: 1 },
    { adminsBypass: true, version: 1 },
    {
      version: 1,
      voice: { allowedRoomIds: [], enabled: true, maxSessionSeconds: 0 },
    },
    {
      speech: { providerId: "x", transport: "openai-audio-speech", voice: "v" },
      version: 1,
    },
  ]) {
    expect(channelIntegrationPolicySchema.safeParse(value).success).toBe(false);
  }
});
