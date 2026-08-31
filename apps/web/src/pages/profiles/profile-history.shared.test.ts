import { describe, expect, test } from "bun:test";
import type { ProfileChangeEvent } from "@atlas/core/contract";
import {
  canViewProfileHistory,
  formatProfileChangeActor,
  formatProfileChangeField,
  formatProfileChangeSource,
  formatProfileChangeValue,
  getNextProfileHistoryOffset,
  mergeProfileHistoryPages,
  PROFILE_HISTORY_PAGE_SIZE,
} from "./profile-history.shared";

function historyEvent(index: number): ProfileChangeEvent {
  return {
    actorUserId: "user_admin",
    afterValue: `after-${index}`,
    beforeValue: `before-${index}`,
    createdAt: `2026-08-30T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    field: "system_prompt",
    id: `event-${index}`,
    orgId: "org_1",
    profileId: "profile_1",
    source: "dashboard",
  };
}

describe("profile history presentation", () => {
  test("allows only workspace and platform admins", () => {
    expect(
      canViewProfileHistory({ isPlatformAdmin: false, orgRole: "admin" })
    ).toBe(true);
    expect(
      canViewProfileHistory({ isPlatformAdmin: true, orgRole: "viewer" })
    ).toBe(true);
    expect(
      canViewProfileHistory({ isPlatformAdmin: false, orgRole: "member" })
    ).toBe(false);
    expect(
      canViewProfileHistory({ isPlatformAdmin: false, orgRole: "viewer" })
    ).toBe(false);
  });

  test("uses Atlas labels and readable values", () => {
    expect(formatProfileChangeField("soul.instructions")).toBe(
      "INSTRUCTIONS.md"
    );
    expect(formatProfileChangeSource("super_bot")).toBe("Super Agent");
    expect(formatProfileChangeValue('["tool_b","tool_a"]', "tools")).toBe(
      '[\n  "tool_b",\n  "tool_a"\n]'
    );
    expect(formatProfileChangeValue("plain text", "system_prompt")).toBe(
      "plain text"
    );
    expect(formatProfileChangeValue(null, "system_prompt")).toBe("Not set");
    expect(formatProfileChangeValue("", "system_prompt")).toBe("Empty");
  });

  test("shortens opaque actor ids without hiding short ids", () => {
    expect(formatProfileChangeActor(null)).toBe("System");
    expect(formatProfileChangeActor("user_admin")).toBe("user_admin");
    expect(formatProfileChangeActor("user_1234567890_abcdefghijklmnop")).toBe(
      "user_1234567890_…"
    );
  });

  test("loads and merges history beyond the first page", () => {
    const firstPage = {
      events: Array.from({ length: PROFILE_HISTORY_PAGE_SIZE }, (_, index) =>
        historyEvent(index)
      ),
    };
    expect(getNextProfileHistoryOffset([firstPage])).toBe(
      PROFILE_HISTORY_PAGE_SIZE
    );

    const secondPage = {
      events: [historyEvent(PROFILE_HISTORY_PAGE_SIZE - 1), historyEvent(100)],
    };
    const pages = [firstPage, secondPage];

    expect(getNextProfileHistoryOffset(pages)).toBeUndefined();
    expect(mergeProfileHistoryPages(pages)).toHaveLength(101);
    expect(mergeProfileHistoryPages(pages).at(-1)?.id).toBe("event-100");
  });
});
