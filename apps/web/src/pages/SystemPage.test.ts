import { describe, expect, test } from "bun:test";
import {
  automationsQueryOptions,
  mcpServersQueryOptions,
  modelsQueryOptions,
  profilesQueryOptions,
  skillsQueryOptions,
  toolsQueryOptions,
} from "@/hooks/use-app-queries";
import { systemStatusQueryOptions } from "@/hooks/use-system-status";
import { resolveSystemTab, visibleSystemTabs } from "./system-page.shared";

describe("SystemPage tab access", () => {
  test("shows every system tab to workspace admins and Superadmins", () => {
    expect(visibleSystemTabs().map((tab) => tab.id)).toEqual([
      "status",
      "organization",
      "tools",
      "mcp",
    ]);
  });

  test("resolves each system tab from the query string", () => {
    expect(resolveSystemTab("status")).toBe("status");
    expect(resolveSystemTab("organization")).toBe("organization");
    expect(resolveSystemTab("mcp")).toBe("mcp");
    expect(resolveSystemTab("tools")).toBe("tools");
    expect(resolveSystemTab("data")).toBe("tools");
    expect(resolveSystemTab("unknown")).toBe("tools");
    expect(resolveSystemTab(null)).toBe("tools");
  });

  test("keys System queries by the active workspace", () => {
    expect([...systemStatusQueryOptions("org_a").queryKey]).toEqual([
      "systemStatus",
      "org_a",
    ]);
    expect([...profilesQueryOptions("org_a").queryKey]).toEqual([
      "profiles",
      "org_a",
    ]);
    expect([...toolsQueryOptions("org_a").queryKey]).toEqual([
      "tools",
      "org_a",
    ]);
    expect([...mcpServersQueryOptions("org_b").queryKey]).toEqual([
      "mcp",
      "servers",
      "org_b",
    ]);
    expect([...modelsQueryOptions("org_a").queryKey]).toEqual([
      "models",
      "org_a",
    ]);
    expect([...skillsQueryOptions("org_b").queryKey]).toEqual([
      "skills",
      "org_b",
    ]);
    expect([...automationsQueryOptions("org_a").queryKey]).toEqual([
      "automations",
      "org_a",
    ]);
    expect([...systemStatusQueryOptions(null).queryKey]).toEqual([
      "systemStatus",
      "none",
    ]);
    expect([...modelsQueryOptions(null).queryKey]).toEqual(["models", "none"]);
  });
});
