import { describe, expect, test } from "bun:test";
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
});
