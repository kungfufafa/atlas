import { describe, expect, it } from "bun:test";
import { visibleNavGroups } from "./navigation";

describe("visibleNavGroups", () => {
  it("platform admin sees all groups and items including System, Profiles, Files", () => {
    const groups = visibleNavGroups({
      isPlatformAdmin: true,
      orgRole: "admin",
    });

    const pageIds = groups.flatMap((group) =>
      group.items.map((item) => item.id)
    );
    expect(pageIds).toEqual([
      "chat",
      "history",
      "files",
      "profiles",
      "automations",
      "integrations",
      "soul",
      "settings",
    ]);
  });

  it("org admin sees System and Integrations, but not platform-admin-only pages", () => {
    const groups = visibleNavGroups({
      isPlatformAdmin: false,
      orgRole: "admin",
    });

    const pageIds = groups.flatMap((group) =>
      group.items.map((item) => item.id)
    );
    expect(pageIds).toContain("soul");
    expect(pageIds).toContain("integrations");
    expect(pageIds).not.toContain("files");
  });

  it("member sees Integrations and automations but not System", () => {
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

  it("viewer loses Integrations and System", () => {
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
