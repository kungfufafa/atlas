import { describe, expect, test } from "bun:test";
import { withExclusiveAtlasConfigDir } from "@atlas/core/testing/atlas-home";
import { runChannelLoopHarness } from "./run";

describe("channel loop harness", () => {
  test("file in is processed and a real file comes back on WhatsApp, Telegram, and Discord", async () => {
    const result = await withExclusiveAtlasConfigDir(() =>
      runChannelLoopHarness()
    );
    const failed = result.results.filter((item) => item.status === "fail");

    expect(failed.map((item) => `${item.id}: ${item.message}`)).toEqual([]);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(result.results.length);
  }, 180_000);
});
