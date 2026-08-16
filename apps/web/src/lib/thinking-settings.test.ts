import { describe, expect, test } from "bun:test";
import {
  buildAutoEnableThinkingPayload,
  buildThinkingEffortOptions,
  shouldAutoEnableThinking,
  shouldBlockThinkingEffortChange,
  shouldShowThinkingBlocks,
  shouldShowThinkingEffort,
  thinkingEffortLabel,
  thinkingEffortShortLabel,
} from "./thinking-settings";

describe("thinking-settings helpers", () => {
  test("shouldShowThinkingEffort is true only when model explicitly supports thinking", () => {
    expect(shouldShowThinkingEffort(true)).toBe(true);
    expect(shouldShowThinkingEffort(false)).toBe(false);
    expect(shouldShowThinkingEffort(undefined)).toBe(false);
  });

  test("shouldShowThinkingBlocks matches effort visibility gate", () => {
    expect(shouldShowThinkingBlocks).toBe(shouldShowThinkingEffort);
    expect(shouldShowThinkingBlocks(true)).toBe(true);
    expect(shouldShowThinkingBlocks(undefined)).toBe(false);
  });

  test("buildAutoEnableThinkingPayload always enables thinking", () => {
    expect(buildAutoEnableThinkingPayload({ effort: "high" })).toEqual({
      effort: "high",
      enabled: true,
    });
    expect(buildAutoEnableThinkingPayload({ effort: "medium" })).toEqual({
      effort: "medium",
      enabled: true,
    });
  });

  test("shouldAutoEnableThinking respects guards", () => {
    const disabled = { effort: "low" as const, enabled: false };

    expect(shouldAutoEnableThinking(disabled, true, false, false)).toBe(true);
    expect(shouldAutoEnableThinking(disabled, true, true, false)).toBe(false);
    expect(shouldAutoEnableThinking(disabled, false, false, false)).toBe(false);
    expect(shouldAutoEnableThinking(disabled, true, false, true)).toBe(false);
    expect(
      shouldAutoEnableThinking(
        { effort: "low", enabled: true },
        true,
        false,
        false
      )
    ).toBe(false);
    expect(
      shouldAutoEnableThinking(disabled, true, false, false, {
        hasRouteSession: true,
      })
    ).toBe(false);
    expect(
      shouldAutoEnableThinking(disabled, true, false, false, {
        hasMessages: true,
      })
    ).toBe(false);
    expect(
      shouldAutoEnableThinking(disabled, true, false, false, {
        hasProfileId: false,
      })
    ).toBe(false);
  });

  test("shouldBlockThinkingEffortChange blocks while busy", () => {
    expect(shouldBlockThinkingEffortChange(true)).toBe(true);
    expect(shouldBlockThinkingEffortChange(false)).toBe(false);
  });

  test("thinkingEffortLabel maps effort values", () => {
    expect(thinkingEffortLabel("low")).toBe("Low");
    expect(thinkingEffortLabel("medium")).toBe("Medium");
    expect(thinkingEffortLabel("high")).toBe("High");
    expect(thinkingEffortLabel("xhigh")).toBe("Extra High");
    expect(thinkingEffortLabel("max")).toBe("Max");
  });

  test("thinkingEffortShortLabel maps short labels", () => {
    expect(thinkingEffortShortLabel("low")).toBe("Low");
    expect(thinkingEffortShortLabel("medium")).toBe("Med");
    expect(thinkingEffortShortLabel("high")).toBe("High");
    expect(thinkingEffortShortLabel("xhigh")).toBe("XHigh");
    expect(thinkingEffortShortLabel("max")).toBe("Max");
  });

  test("buildThinkingEffortOptions builds dynamic options list", () => {
    expect(buildThinkingEffortOptions()).toEqual([
      { label: "Low", value: "low" },
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" },
    ]);

    expect(buildThinkingEffortOptions(["low", "medium", "xhigh"])).toEqual([
      { label: "Low", value: "low" },
      { label: "Medium", value: "medium" },
      { label: "Extra High", value: "xhigh" },
    ]);
  });
});
