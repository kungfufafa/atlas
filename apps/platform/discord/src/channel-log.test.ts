import { afterEach, describe, expect, test } from "bun:test";
import { formatDiscordInboundMessageLog } from "./channel-log";

const originalDebug = process.env.ATLAS_CH_DEBUG;

afterEach(() => {
  process.env.ATLAS_CH_DEBUG = originalDebug;
});

describe("Discord channel logs", () => {
  test("redacts content and routing identifiers by default", () => {
    delete process.env.ATLAS_CH_DEBUG;
    const line = formatDiscordInboundMessageLog({
      author: { id: "user-secret" },
      channelId: "channel-secret",
      content: "private message contents",
      id: "message-1",
    });

    expect(line).toContain("messageId=message-1");
    expect(line).toContain("textBytes=24");
    expect(line).not.toContain("user-secret");
    expect(line).not.toContain("channel-secret");
    expect(line).not.toContain("private message contents");
  });

  test("includes routing identifiers only in explicit debug mode", () => {
    process.env.ATLAS_CH_DEBUG = "1";
    const line = formatDiscordInboundMessageLog({
      author: { id: "user-1" },
      channelId: "channel-1",
      content: "hello",
      id: "message-1",
    });

    expect(line).toContain("authorId=user-1");
    expect(line).toContain("channelId=channel-1");
  });
});
