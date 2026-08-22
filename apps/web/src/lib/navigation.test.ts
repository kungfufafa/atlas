import { describe, expect, it } from "bun:test";
import {
  loginPathWithReturn,
  safeInternalPath,
  visibleNavGroups,
} from "./navigation";

const WORKSPACE_ADMIN_NAV = [
  "chat",
  "history",
  "files",
  "profiles",
  "automations",
  "integrations",
  "soul",
  "settings",
] as const;

describe("visibleNavGroups", () => {
  it("platform admin and workspace admin see the same sidebar", () => {
    const platformAdmin = visibleNavGroups({
      isPlatformAdmin: true,
      orgRole: "admin",
    });
    const workspaceAdmin = visibleNavGroups({
      isPlatformAdmin: false,
      orgRole: "admin",
    });

    expect(
      platformAdmin.flatMap((group) => group.items.map((item) => item.id))
    ).toEqual([...WORKSPACE_ADMIN_NAV]);
    expect(
      workspaceAdmin.flatMap((group) => group.items.map((item) => item.id))
    ).toEqual([...WORKSPACE_ADMIN_NAV]);
  });

  it("member sees Integrations and automations but not System, Files, or Profiles", () => {
    const groups = visibleNavGroups({
      isPlatformAdmin: false,
      orgRole: "member",
    });

    const pageIds = groups.flatMap((group) =>
      group.items.map((item) => item.id)
    );
    expect(pageIds).toContain("integrations");
    expect(pageIds).toContain("automations");
    expect(pageIds).toContain("chat");
    expect(pageIds).not.toContain("soul");
    expect(pageIds).not.toContain("files");
    expect(pageIds).not.toContain("profiles");
  });

  it("viewer sees chat history only", () => {
    const groups = visibleNavGroups({
      isPlatformAdmin: false,
      orgRole: "viewer",
    });

    const pageIds = groups.flatMap((group) =>
      group.items.map((item) => item.id)
    );
    expect(pageIds).toEqual(["history", "settings"]);
    expect(pageIds).not.toContain("chat");
    expect(pageIds).not.toContain("automations");
    expect(pageIds).not.toContain("profiles");
    expect(pageIds).not.toContain("integrations");
    expect(pageIds).not.toContain("soul");
    expect(pageIds).not.toContain("files");
  });
});

describe("safeInternalPath", () => {
  it("accepts in-app paths and rejects open redirects", () => {
    expect(safeInternalPath("/settings")).toBe("/settings");
    expect(safeInternalPath("/history?profile=p1")).toBe("/history?profile=p1");
    expect(safeInternalPath("//evil.example")).toBeNull();
    expect(safeInternalPath("https://evil.example")).toBeNull();
    expect(safeInternalPath("/login")).toBeNull();
    expect(loginPathWithReturn("/files")).toBe("/login?from=%2Ffiles");
  });
});
