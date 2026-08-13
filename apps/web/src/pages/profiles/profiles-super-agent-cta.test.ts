import { describe, expect, test } from "bun:test";
import type { ProfileSummary } from "@atlas/core/contract";
import { resolveSuperAgentChatProfileId } from "@/lib/profiles";

function profile(
  partial: Pick<ProfileSummary, "id" | "name" | "isSuper" | "isDefault">
): ProfileSummary {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    hasAvatar: false,
    id: partial.id,
    isDefault: partial.isDefault,
    isSuper: partial.isSuper,
    mcpServerCount: 0,
    model: null,
    name: partial.name,
    soulActive: false,
    toolCount: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("resolveSuperAgentChatProfileId", () => {
  test("returns the super agent profile id when present", () => {
    expect(
      resolveSuperAgentChatProfileId([
        profile({
          id: "default",
          isDefault: true,
          isSuper: false,
          name: "Default",
        }),
        profile({
          id: "super_agent",
          isDefault: false,
          isSuper: true,
          name: "Super Agent",
        }),
      ])
    ).toBe("super_agent");
  });

  test("returns null when no super agent exists", () => {
    expect(
      resolveSuperAgentChatProfileId([
        profile({
          id: "default",
          isDefault: true,
          isSuper: false,
          name: "Default",
        }),
      ])
    ).toBeNull();
  });
});
