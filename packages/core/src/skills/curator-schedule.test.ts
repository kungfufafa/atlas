import { describe, expect, test } from "bun:test";
import {
  isSkillCuratorDue,
  SKILL_CURATOR_INTERVAL_MS,
} from "./curator-schedule";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("isSkillCuratorDue", () => {
  test("requires the workspace opt-in", () => {
    expect(
      isSkillCuratorDue({ enabled: false, lastRunAt: null, now: NOW })
    ).toBe(false);
  });

  test("runs when no valid durable clock exists", () => {
    expect(
      isSkillCuratorDue({ enabled: true, lastRunAt: null, now: NOW })
    ).toBe(true);
    expect(
      isSkillCuratorDue({ enabled: true, lastRunAt: "invalid", now: NOW })
    ).toBe(true);
  });

  test("becomes due exactly seven days after completion", () => {
    expect(
      isSkillCuratorDue({
        enabled: true,
        lastRunAt: new Date(
          NOW.getTime() - SKILL_CURATOR_INTERVAL_MS + 1
        ).toISOString(),
        now: NOW,
      })
    ).toBe(false);
    expect(
      isSkillCuratorDue({
        enabled: true,
        lastRunAt: new Date(
          NOW.getTime() - SKILL_CURATOR_INTERVAL_MS
        ).toISOString(),
        now: NOW,
      })
    ).toBe(true);
  });
});
