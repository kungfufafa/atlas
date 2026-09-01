import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import type { Context } from "grammy";
import { dispatchTelegramUpdate, redactBotToken } from "./bot";

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

describe("dispatchTelegramUpdate", () => {
  test("starts an independent update while an earlier chat is still running", async () => {
    const started: number[] = [];
    const errors: unknown[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = async (ctx: Context): Promise<void> => {
      const id = (ctx as Context & { testId: number }).testId;
      started.push(id);
      if (id === 1) {
        await firstBlocked;
      }
    };

    dispatchTelegramUpdate(
      handler,
      { testId: 1 } as unknown as Context,
      (error) => errors.push(error)
    );
    dispatchTelegramUpdate(
      handler,
      { testId: 2 } as unknown as Context,
      (error) => errors.push(error)
    );
    await Bun.sleep(0);

    expect(started).toEqual([1, 2]);
    releaseFirst();
    await Bun.sleep(0);
    expect(errors).toEqual([]);
  });
});
