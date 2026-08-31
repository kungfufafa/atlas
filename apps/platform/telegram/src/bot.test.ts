import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { redactBotToken } from "./bot";

const BOT_TOKEN = "7654321098:AAF_fakeTokenValueDoNotUse_zzzz12345";

describe("redactBotToken", () => {
  test("removes a bot token nested in a logged request error", () => {
    const error = Object.assign(new Error("Telegram request failed"), {
      path: `https://api.telegram.org/bot${BOT_TOKEN}/getMe`,
    });
    const logged = redactBotToken(inspect(error), BOT_TOKEN);

    expect(logged).not.toContain(BOT_TOKEN);
    expect(logged).toContain("/bot<redacted>/getMe");
  });

  test("leaves text unchanged when no token is configured", () => {
    expect(redactBotToken("network failure", "")).toBe("network failure");
  });
});
