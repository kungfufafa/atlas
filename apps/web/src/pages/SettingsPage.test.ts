import { describe, expect, test } from "bun:test";
import {
  canManageWorkspaceSettings,
  providerSettingsScopeKey,
} from "./SettingsPage";

describe("settings access", () => {
  test("allows platform admins regardless of active workspace membership", () => {
    expect(
      canManageWorkspaceSettings({
        isOrgAdmin: false,
        isPlatformAdmin: true,
      })
    ).toBe(true);
  });

  test("allows workspace admins and rejects other workspace roles", () => {
    expect(
      canManageWorkspaceSettings({
        isOrgAdmin: true,
        isPlatformAdmin: false,
      })
    ).toBe(true);
    expect(
      canManageWorkspaceSettings({
        isOrgAdmin: false,
        isPlatformAdmin: false,
      })
    ).toBe(false);
  });

  test("scopes provider setup state to the active workspace", () => {
    expect(providerSettingsScopeKey("org-a")).toBe("org-a");
    expect(providerSettingsScopeKey("org-b")).toBe("org-b");
    expect(providerSettingsScopeKey(null)).toBe("no-workspace");
  });
});
