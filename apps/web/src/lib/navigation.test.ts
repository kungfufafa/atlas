import { describe, expect, it } from "bun:test";
import { visibleNavGroups } from "./navigation";

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

  it("member sees Integrations and automations but not System or Files", () => {
    const groups = visibleNavGroups({
      isPlatformAdmin: false,
      orgRole: "member",
    });

    const pageIds = groups.flatMap((group) =>
      group.items.map((item) => item.id)
    );
    expect(pageIds).toContain("integrations");
    expect(pageIds).toContain("automations");
    expect(pageIds).not.toContain("soul");
    expect(pageIds).not.toContain("files");
  });

  it("viewer loses Integrations, System, and Files", () => {
    const groups = visibleNavGroups({
      isPlatformAdmin: false,
      orgRole: "viewer",
    });

    const pageIds = groups.flatMap((group) =>
      group.items.map((item) => item.id)
    );
    expect(pageIds).not.toContain("integrations");
    expect(pageIds).not.toContain("soul");
    expect(pageIds).not.toContain("files");
  });
});
