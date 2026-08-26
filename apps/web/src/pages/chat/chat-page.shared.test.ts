import { describe, expect, test } from "bun:test";
import {
  canSelectSessionModel,
  isSupersededChatTurn,
  resolveProfileIdForWorkspaceProfiles,
  shouldResetChatOnWorkspaceChange,
} from "./chat-page.shared";

describe("session model selection access", () => {
  test("allows drafts and authorized sessions but blocks non-owners and read-only chat", () => {
    expect(
      canSelectSessionModel({
        canUpdateExistingSession: false,
        hasSession: false,
        readOnlySession: false,
        workspaceReadOnly: false,
      })
    ).toBe(true);
    expect(
      canSelectSessionModel({
        canUpdateExistingSession: true,
        hasSession: true,
        readOnlySession: false,
        workspaceReadOnly: false,
      })
    ).toBe(true);
    expect(
      canSelectSessionModel({
        canUpdateExistingSession: false,
        hasSession: true,
        readOnlySession: false,
        workspaceReadOnly: false,
      })
    ).toBe(false);
    expect(
      canSelectSessionModel({
        canUpdateExistingSession: true,
        hasSession: true,
        readOnlySession: false,
        workspaceReadOnly: true,
      })
    ).toBe(false);
  });
});

describe("workspace chat reset", () => {
  test("resets only when the workspace id actually changes", () => {
    expect(shouldResetChatOnWorkspaceChange(null, "org_b")).toBe(false);
    expect(shouldResetChatOnWorkspaceChange("org_a", "org_a")).toBe(false);
    expect(shouldResetChatOnWorkspaceChange("org_a", "org_b")).toBe(true);
  });

  test("treats a bumped stream generation as a superseded turn", () => {
    expect(isSupersededChatTurn(1, 1)).toBe(false);
    expect(isSupersededChatTurn(2, 1)).toBe(true);
  });

  test("keeps the current profile when it still exists after a workspace change", () => {
    expect(
      resolveProfileIdForWorkspaceProfiles({
        currentProfileId: "p1",
        profiles: [{ id: "p1" }, { id: "p2" }],
        search: "",
      })
    ).toBe("p1");
  });

  test("falls back when the current profile belongs to the previous workspace", () => {
    expect(
      resolveProfileIdForWorkspaceProfiles({
        currentProfileId: "old-org-profile",
        liveChatProfileId: "old-org-profile",
        profiles: [{ id: "default" }, { id: "research" }],
        search: "profile=old-org-profile",
      })
    ).toBe("default");
  });
});
