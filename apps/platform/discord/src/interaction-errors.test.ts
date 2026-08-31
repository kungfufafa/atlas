import { describe, expect, test } from "bun:test";
import {
  deferSlashInteraction,
  getDiscordErrorCode,
  isIgnorableInteractionError,
} from "./interaction-errors";

describe("isIgnorableInteractionError", () => {
  test("treats Unknown interaction (10062) as ignorable", () => {
    expect(isIgnorableInteractionError({ code: 10_062 })).toBe(true);
  });

  test("treats already acknowledged (40060) as ignorable", () => {
    expect(isIgnorableInteractionError({ code: 40_060 })).toBe(true);
  });

  test("does not ignore unrelated errors", () => {
    expect(isIgnorableInteractionError({ code: 50_035 })).toBe(false);
    expect(isIgnorableInteractionError(new Error("boom"))).toBe(false);
    expect(isIgnorableInteractionError(null)).toBe(false);
  });
});

describe("getDiscordErrorCode", () => {
  test("reads numeric code", () => {
    expect(getDiscordErrorCode({ code: 10_062 })).toBe(10_062);
  });

  test("returns null without a numeric code", () => {
    expect(getDiscordErrorCode({ code: "10062" })).toBeNull();
    expect(getDiscordErrorCode("nope")).toBeNull();
  });
});

describe("deferSlashInteraction", () => {
  test("replies with a visible failure when defer fails", async () => {
    const replies: string[] = [];
    const shouldContinue = await deferSlashInteraction({
      commandName: "status",
      deferReply: async () => {
        throw new Error("gateway failed");
      },
      editReply: async ({ content }) => {
        replies.push(`edit:${content}`);
      },
      reply: async ({ content }) => {
        replies.push(content);
      },
    });

    expect(shouldContinue).toBe(false);
    expect(replies).toEqual(["Something went wrong."]);
  });

  test("falls back to editReply if the failure was already acknowledged", async () => {
    const replies: string[] = [];
    await deferSlashInteraction({
      commandName: "status",
      deferReply: async () => {
        throw new Error("defer failed");
      },
      editReply: async ({ content }) => {
        replies.push(content);
      },
      reply: async () => {
        throw new Error("already acknowledged");
      },
    });

    expect(replies).toEqual(["Something went wrong."]);
  });
});
