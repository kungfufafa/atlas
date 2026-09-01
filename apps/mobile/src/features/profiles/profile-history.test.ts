import { expect, test } from "bun:test";
import {
  formatProfileChangeActor,
  formatProfileChangeField,
  formatProfileChangeMetadata,
  formatProfileChangeSource,
  formatProfileChangeTime,
  formatProfileChangeValue,
  getNextProfileHistoryOffset,
  mergeProfileHistoryPages,
  PROFILE_HISTORY_PAGE_SIZE,
} from "./profile-history";

test("formats profile history fields and sources with product labels", () => {
  expect(formatProfileChangeField("soul.instructions")).toBe("INSTRUCTIONS.md");
  expect(formatProfileChangeField("mcp")).toBe("MCP servers");
  expect(formatProfileChangeSource("super_bot")).toBe("Super Agent");
  expect(formatProfileChangeSource("skill_manage")).toBe("Skill manager");
  expect(formatProfileChangeActor(null)).toBe("System");
  expect(formatProfileChangeActor("user_123")).toBe("user_123");
});

test("formats empty, text, and structured history values", () => {
  expect(formatProfileChangeValue(null, "system_prompt")).toBe("Not set");
  expect(formatProfileChangeValue("", "system_prompt")).toBe("Empty");
  expect(formatProfileChangeValue("Keep this exact", "system_prompt")).toBe(
    "Keep this exact"
  );
  expect(formatProfileChangeValue('["tool_b","tool_a"]', "tools")).toBe(
    '[\n  "tool_b",\n  "tool_a"\n]'
  );
  expect(formatProfileChangeValue("not-json", "skills")).toBe("not-json");
});

test("formats timestamps predictably and handles invalid input", () => {
  const options = { locale: "en-US", timeZone: "UTC" };

  expect(formatProfileChangeTime("2026-08-30T14:05:00.000Z", options)).toBe(
    "Aug 30, 2026, 2:05 PM"
  );
  expect(
    formatProfileChangeMetadata(
      {
        actorUserId: null,
        createdAt: "2026-08-30T14:05:00.000Z",
        source: "dashboard",
      },
      options
    )
  ).toBe("Aug 30, 2026, 2:05 PM · Dashboard · System");
  expect(formatProfileChangeTime("not-a-date", options)).toBe("Unknown time");
});

test("paginates and deduplicates profile history", () => {
  const baseEvent = {
    actorUserId: null,
    afterValue: "after",
    beforeValue: "before",
    createdAt: "2026-08-30T14:05:00.000Z",
    field: "system_prompt" as const,
    orgId: "org-1",
    profileId: "profile-1",
    source: "dashboard" as const,
  };
  const firstPage = {
    events: Array.from({ length: PROFILE_HISTORY_PAGE_SIZE }, (_, index) => ({
      ...baseEvent,
      id: `event-${index}`,
    })),
  };
  const secondPage = {
    events: [
      { ...baseEvent, id: "event-99" },
      { ...baseEvent, id: "event-100" },
    ],
  };

  expect(getNextProfileHistoryOffset([firstPage])).toBe(
    PROFILE_HISTORY_PAGE_SIZE
  );
  expect(getNextProfileHistoryOffset([firstPage, secondPage])).toBeUndefined();
  expect(mergeProfileHistoryPages([firstPage, secondPage])).toHaveLength(101);
});
