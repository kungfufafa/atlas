import { describe, expect, test } from "bun:test";
import { AtlasApiError } from "@atlas/core/api-error";
import type { AuthUserResponse, UserOrgSummary } from "@atlas/core/contract";
import {
  archiveOrganizationWithRecovery,
  canArchiveOrganization,
  finalizeOrganizationArchive,
  nextOrgIdAfterArchive,
} from "./org-archive";

function organization(id: string): UserOrgSummary {
  return {
    createdAt: "2026-08-26T00:00:00.000Z",
    id,
    name: id,
    role: "admin",
    slug: id,
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

const currentUser: AuthUserResponse = {
  activeOrgId: "org_a",
  email: "admin@example.com",
  isPlatformAdmin: true,
  orgId: "org_a",
};

describe("organization archive helpers", () => {
  test("only platform admins can archive", () => {
    expect(canArchiveOrganization(true)).toBe(true);
    expect(canArchiveOrganization(false)).toBe(false);
  });

  test("picks a remaining organization", () => {
    expect(
      nextOrgIdAfterArchive([{ id: "org_a" }, { id: "org_b" }], "org_a")
    ).toBe("org_b");
  });

  test("returns null without a remaining organization", () => {
    expect(nextOrgIdAfterArchive([{ id: "org_a" }], "org_a")).toBeNull();
  });

  test("keeps an immediate local fallback when post-commit refresh fails", async () => {
    const orgUpdates: UserOrgSummary[][] = [];
    const userUpdates: Array<AuthUserResponse | null> = [];
    const clientOrgUpdates: Array<string | null> = [];
    let activeOrgCalls = 0;

    await finalizeOrganizationArchive({
      archivedOrgId: "org_a",
      currentOrgs: [organization("org_a"), organization("org_b")],
      currentUser,
      listUserOrgs: () => Promise.reject(new TypeError("Failed to fetch")),
      setActiveOrg: () => {
        activeOrgCalls += 1;
        return Promise.reject(new Error("should not run"));
      },
      setClientOrgId: (orgId) => clientOrgUpdates.push(orgId),
      updateOrgs: (orgs) => orgUpdates.push(orgs),
      updateUser: (user) => userUpdates.push(user),
    });

    expect(orgUpdates).toEqual([[organization("org_b")]]);
    expect(clientOrgUpdates).toEqual(["org_b"]);
    expect(userUpdates.at(-1)).toMatchObject({
      activeOrgId: "org_b",
      orgId: "org_b",
    });
    expect(activeOrgCalls).toBe(0);
  });

  test("does not surface a failed active-org refresh as a failed archive", async () => {
    const orgUpdates: UserOrgSummary[][] = [];
    const userUpdates: Array<AuthUserResponse | null> = [];

    await expect(
      finalizeOrganizationArchive({
        archivedOrgId: "org_a",
        currentOrgs: [organization("org_a"), organization("org_b")],
        currentUser,
        listUserOrgs: () =>
          Promise.resolve({
            orgs: [
              organization("org_a"),
              organization("org_b"),
              organization("org_c"),
            ],
          }),
        setActiveOrg: () => Promise.reject(new TypeError("Load failed")),
        setClientOrgId: () => undefined,
        updateOrgs: (orgs) => orgUpdates.push(orgs),
        updateUser: (user) => userUpdates.push(user),
      })
    ).resolves.toBeUndefined();

    expect(orgUpdates.at(-1)?.map((org) => org.id)).toEqual(["org_b", "org_c"]);
    expect(userUpdates.at(-1)).toMatchObject({
      activeOrgId: "org_b",
      orgId: "org_b",
    });
  });

  test("recovers when the archive response is lost after commit", async () => {
    const orgUpdates: UserOrgSummary[][] = [];
    let listCalls = 0;

    await archiveOrganizationWithRecovery({
      archivedOrgId: "org_a",
      archiveOrganization: () =>
        Promise.reject(new TypeError("Network connection lost")),
      currentOrgs: [organization("org_a"), organization("org_b")],
      currentUser,
      listUserOrgs: () => {
        listCalls += 1;
        return Promise.resolve({ orgs: [organization("org_b")] });
      },
      setActiveOrg: () =>
        Promise.resolve({
          ...currentUser,
          activeOrgId: "org_b",
          orgId: "org_b",
        }),
      setClientOrgId: () => undefined,
      updateOrgs: (orgs) => orgUpdates.push(orgs),
      updateUser: () => undefined,
    });

    expect(listCalls).toBe(1);
    expect(orgUpdates.at(-1)?.map((org) => org.id)).toEqual(["org_b"]);
  });

  test("treats a retry 404 as an idempotent archive result", async () => {
    const orgUpdates: UserOrgSummary[][] = [];

    await expect(
      archiveOrganizationWithRecovery({
        archivedOrgId: "org_a",
        archiveOrganization: () =>
          Promise.reject(new AtlasApiError("Not found", 404)),
        currentOrgs: [organization("org_a"), organization("org_b")],
        currentUser,
        listUserOrgs: () => Promise.reject(new TypeError("Load failed")),
        setActiveOrg: () => Promise.reject(new Error("should not run")),
        setClientOrgId: () => undefined,
        updateOrgs: (orgs) => orgUpdates.push(orgs),
        updateUser: () => undefined,
      })
    ).resolves.toBeUndefined();

    expect(orgUpdates.at(-1)?.map((org) => org.id)).toEqual(["org_b"]);
  });

  test("does not hide authorization or archive-conflict responses", async () => {
    let listCalls = 0;

    await expect(
      archiveOrganizationWithRecovery({
        archivedOrgId: "org_a",
        archiveOrganization: () =>
          Promise.reject(new AtlasApiError("Forbidden", 403)),
        currentOrgs: [organization("org_a"), organization("org_b")],
        currentUser,
        listUserOrgs: () => {
          listCalls += 1;
          return Promise.resolve({ orgs: [] });
        },
        setActiveOrg: () => Promise.reject(new Error("should not run")),
        setClientOrgId: () => undefined,
        updateOrgs: () => undefined,
        updateUser: () => undefined,
      })
    ).rejects.toMatchObject({ status: 403 });

    expect(listCalls).toBe(0);
  });

  test("reports an unknown outcome distinctly when recovery also loses network", async () => {
    await expect(
      archiveOrganizationWithRecovery({
        archivedOrgId: "org_a",
        archiveOrganization: () =>
          Promise.reject(new TypeError("Network connection lost")),
        currentOrgs: [organization("org_a"), organization("org_b")],
        currentUser,
        listUserOrgs: () => Promise.reject(new TypeError("Load failed")),
        setActiveOrg: () => Promise.reject(new Error("should not run")),
        setClientOrgId: () => undefined,
        updateOrgs: () => undefined,
        updateUser: () => undefined,
      })
    ).rejects.toThrow(/could not confirm.*Refresh before trying again/i);
  });
});
