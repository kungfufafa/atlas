import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import {
  isCodingAgentProviderPassthroughEnabled,
  mergeWorkspaceSettings,
  updateWorkspaceSettingsForOrg,
} from "./workspace-settings";

describe("workspace settings", () => {
  test("defaults provider passthrough on", () => {
    expect(isCodingAgentProviderPassthroughEnabled(null)).toBe(true);
    expect(
      isCodingAgentProviderPassthroughEnabled({
        codingAgentProviderPassthrough: false,
      })
    ).toBe(false);
  });

  test("preserves the provider mode while patching another field", () => {
    const existing = mergeWorkspaceSettings(null, {
      codingAgentProviderPassthrough: false,
      orgId: "org-a",
      tokenOptimizerEnabled: true,
    });
    const merged = mergeWorkspaceSettings(existing, {
      visionModel: "provider::vision",
    });
    expect(merged).toMatchObject({
      codingAgentProviderPassthrough: false,
      orgId: "org-a",
      tokenOptimizerEnabled: true,
      visionModel: "provider::vision",
    });
  });

  test("keeps explicit nulls instead of restoring old nullable values", () => {
    const existing = mergeWorkspaceSettings(null, {
      imageModel: "provider::image",
      tokenOptimizerEnabled: true,
    });
    const merged = mergeWorkspaceSettings(existing, {
      imageModel: null,
      tokenOptimizerEnabled: null,
    });
    expect(merged.imageModel).toBeNull();
    expect(merged.tokenOptimizerEnabled).toBeNull();
  });

  test("serializes concurrent patches without losing either field", async () => {
    const db = createInMemoryDatabaseAdapter();
    await Promise.all([
      updateWorkspaceSettingsForOrg(db, "org-race", () => ({
        codingAgentProviderPassthrough: false,
      })),
      updateWorkspaceSettingsForOrg(db, "org-race", () => ({
        tokenOptimizerEnabled: true,
      })),
    ]);
    expect(await db.getWorkspaceSettings("org-race")).toMatchObject({
      codingAgentProviderPassthrough: false,
      tokenOptimizerEnabled: true,
    });
  });
});
