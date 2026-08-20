import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AtlasApiError, getProfileSoulDir } from "@atlas/core";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core/local-auth";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AuthService } from "./auth-service";
import { OrgService } from "./org-service";

setupTestConfigDir("atlas-org-service-test-");

function createOrgService() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  return {
    authService,
    databaseAdapter,
    orgService: new OrgService(databaseAdapter, authService),
  };
}

describe("OrgService", () => {
  test("bootstrapInitialSetup creates org and admin membership", async () => {
    const { orgService, authService, databaseAdapter } = createOrgService();

    const bootstrapped = await orgService.bootstrapInitialSetup({
      admin: {
        email: "admin@acme.com",
        name: "Acme Admin",
        passwordHash: await authService.hashPassword("password123"),
        phone: "+628123456789",
      },
      organization: { name: "Acme", slug: "acme" },
    });

    expect(bootstrapped.organization.slug).toBe("acme");
    expect(bootstrapped.user.email).toBe("admin@acme.com");

    const members = await orgService.listMembers(bootstrapped.organization.id);
    expect(members.members).toHaveLength(1);
    expect(members.members.map((member) => member.email).sort()).toEqual([
      "admin@acme.com",
    ]);

    const profiles = await databaseAdapter.listProfilesForOrg(
      bootstrapped.organization.id
    );
    expect(profiles.some((profile) => profile.isDefault)).toBe(true);
    expect(profiles.some((profile) => profile.isSuper)).toBe(true);

    const defaultProfile = profiles.find((profile) => profile.isDefault);
    expect(defaultProfile).toBeTruthy();
    const soulPath = join(
      getProfileSoulDir(bootstrapped.organization.id, defaultProfile!.id),
      "SOUL.md"
    );
    const soulContent = await readFile(soulPath, "utf8");
    expect(soulContent).not.toContain("# Your Name");
  });

  test("bootstrapInitialSetup rejects invalid phone before creating an org", async () => {
    const { orgService, authService, databaseAdapter } = createOrgService();

    await expect(
      orgService.bootstrapInitialSetup({
        admin: {
          email: "admin@acme.com",
          name: "Acme Admin",
          passwordHash: await authService.hashPassword("password123"),
          phone: "not-a-phone",
        },
        organization: { name: "Acme", slug: "acme-invalid-phone" },
      })
    ).rejects.toMatchObject({
      message: "Enter a valid phone number.",
      status: 400,
    });

    expect(await databaseAdapter.listOrganizations()).toEqual([]);
    expect(await databaseAdapter.countHumanUsers()).toBe(0);
  });

  test("bootstrapInitialSetup reuses an orphan org from a failed first attempt", async () => {
    const { orgService, authService, databaseAdapter } = createOrgService();
    const now = new Date().toISOString();

    await databaseAdapter.upsertOrganization({
      createdAt: now,
      id: "org_orphan",
      name: "Acme",
      slug: "acme-retry",
      updatedAt: now,
    });

    const bootstrapped = await orgService.bootstrapInitialSetup({
      admin: {
        email: "admin@acme.com",
        name: "Acme Admin",
        passwordHash: await authService.hashPassword("password123"),
        phone: "",
      },
      organization: { name: "Acme", slug: "acme-retry" },
    });

    expect(bootstrapped.organization.id).toBe("org_orphan");
    expect(await databaseAdapter.listOrganizations()).toHaveLength(1);
    expect(await databaseAdapter.countHumanUsers()).toBe(1);
  });

  test("bootstrapInitialSetup allows admin without phone", async () => {
    const { orgService, authService } = createOrgService();

    const bootstrapped = await orgService.bootstrapInitialSetup({
      admin: {
        email: "admin-no-phone@acme.com",
        name: "Acme Admin",
        passwordHash: await authService.hashPassword("password123"),
        phone: "",
      },
      organization: { name: "Acme", slug: "acme-no-phone" },
    });

    expect(bootstrapped.user.phone).toBeNull();
    expect(bootstrapped.user.isPlatformAdmin).toBe(true);
  });

  test("lists and switches active orgs for a user", async () => {
    const { orgService, authService } = createOrgService();

    const bootstrapped = await orgService.bootstrapInitialSetup({
      admin: {
        email: "admin@acme.com",
        name: "Acme Admin",
        passwordHash: await authService.hashPassword("password123"),
        phone: "",
      },
      organization: { name: "Acme", slug: "acme-switch" },
    });

    const second = await orgService.createOrganization(
      { name: "Beta", slug: "beta-switch" },
      bootstrapped.user.id
    );

    const orgs = await orgService.listUserOrgs(bootstrapped.user.id);
    expect(orgs.orgs.map((org) => org.slug)).toEqual([
      "acme-switch",
      "beta-switch",
    ]);

    const switched = await orgService.setActiveOrg({
      orgId: second.organization.id,
      userId: bootstrapped.user.id,
    });
    expect(switched.slug).toBe("beta-switch");
  });

  test("updates organization name", async () => {
    const { orgService } = createOrgService();

    const created = await orgService.createOrganization({
      name: "Acme Corp",
      slug: "acme-corp",
    });

    const updated = await orgService.updateOrganization(
      created.organization.id,
      {
        name: "Acme Incorporated",
      }
    );

    expect(updated.name).toBe("Acme Incorporated");
    expect(updated.slug).toBe("acme-corp");
  });

  test("creates and lists organizations", async () => {
    const { orgService, databaseAdapter } = createOrgService();

    const created = await orgService.createOrganization({
      name: "Acme Corp",
      slug: "acme-corp",
    });

    expect(created.organization.name).toBe("Acme Corp");
    expect(created.organization.slug).toBe("acme-corp");
    expect(created.organization.id).toStartWith("org_");
    expect(created.adminMember).toBeUndefined();

    const organizations = await orgService.listOrganizations();
    expect(organizations).toEqual([created.organization]);

    const members = await orgService.listMembers(created.organization.id);
    expect(members.members).toHaveLength(0);

    const profiles = await databaseAdapter.listProfilesForOrg(
      created.organization.id
    );
    expect(
      profiles.some(
        (profile) => profile.isSuper && profile.name === "Super Agent"
      )
    ).toBe(true);
  });

  test("provisions a first admin when admin details are provided", async () => {
    const { orgService } = createOrgService();

    const created = await orgService.createOrganization({
      admin: {
        email: "admin@acme.com",
        name: "Acme Admin",
        phone: "+628123456789",
      },
      name: "Acme Corp",
      slug: "acme-corp",
    });

    expect(created.adminMember?.member.email).toBe("admin@acme.com");
    expect(created.adminMember?.member.name).toBe("Acme Admin");
    expect(created.adminMember?.member.phone).toBe("+628123456789");
    expect(created.adminMember?.member.role).toBe("admin");
    expect(created.adminMember?.temporaryPassword).toHaveLength(12);
  });

  test("adds a member with a generated temporary password", async () => {
    const { orgService } = createOrgService();
    const created = await orgService.createOrganization({
      name: "Acme",
      slug: "acme",
    });

    const added = await orgService.addMember({
      email: "member@acme.com",
      name: "Member One",
      orgId: created.organization.id,
      phone: "+628987654321",
      role: "member",
    });

    expect(added.member.email).toBe("member@acme.com");
    expect(added.temporaryPassword).toHaveLength(12);
  });

  test("adds a member without phone", async () => {
    const { orgService } = createOrgService();
    const created = await orgService.createOrganization({
      name: "Acme",
      slug: "acme-no-member-phone",
    });

    const added = await orgService.addMember({
      email: "member-no-phone@acme.com",
      name: "Member Two",
      orgId: created.organization.id,
      phone: "",
      role: "member",
    });

    expect(added.member.email).toBe("member-no-phone@acme.com");
    expect(added.member.phone).toBeNull();
    expect(added.temporaryPassword).toHaveLength(12);
  });

  test("allows changing password after provisioning", async () => {
    const { orgService } = createOrgService();
    const created = await orgService.createOrganization({
      admin: {
        email: "admin@acme.com",
        name: "Acme Admin",
        phone: "+628123456789",
      },
      name: "Acme",
      slug: "acme",
    });

    const tempPassword = created.adminMember!.temporaryPassword!;
    const userId = created.adminMember!.member.userId;

    await orgService.changePassword({
      currentPassword: tempPassword,
      newPassword: "new-password-123",
      userId,
    });

    await expect(
      orgService.changePassword({
        currentPassword: tempPassword,
        newPassword: "another-password-123",
        userId,
      })
    ).rejects.toMatchObject({
      message: "Current password is incorrect.",
      status: 401,
    });
  });

  test("updates own profile email phone and name", async () => {
    const { orgService } = createOrgService();
    const created = await orgService.createOrganization({
      admin: {
        email: "admin@acme.com",
        name: "Acme Admin",
        phone: "+628123456789",
      },
      name: "Acme",
      slug: "acme-profile",
    });

    const userId = created.adminMember!.member.userId;
    const updated = await orgService.updateOwnProfile(userId, {
      email: "updated@acme.com",
      name: "Updated Admin",
      phone: "",
    });

    expect(updated.name).toBe("Updated Admin");
    expect(updated.email).toBe("updated@acme.com");
    expect(updated.phone).toBeNull();
  });

  test("rejects duplicate slugs", async () => {
    const { orgService } = createOrgService();

    await orgService.createOrganization({ name: "Acme", slug: "acme" });

    await expect(
      orgService.createOrganization({ name: "Acme 2", slug: "acme" })
    ).rejects.toMatchObject({
      message: "Organization slug already exists.",
      status: 409,
    });
  });

  test("rejects invalid slugs", async () => {
    const { orgService } = createOrgService();

    await expect(
      orgService.createOrganization({ name: "Acme", slug: "Acme Corp" })
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  test("accepts an invite for a new user", async () => {
    const { orgService } = createOrgService();

    const created = await orgService.createOrganization({
      name: "Acme",
      slug: "acme",
    });
    const invite = await orgService.createInvite({
      email: "legacy@acme.com",
      invitedByUserId: "user_platform",
      orgId: created.organization.id,
      role: "member",
    });

    const accepted = await orgService.acceptInvite({
      password: "secret123",
      token: invite.token,
    });

    expect(accepted.user.email).toBe("legacy@acme.com");
    expect(accepted.orgId).toBe(created.organization.id);
    expect(accepted.role).toBe("member");
  });

  test("previews a pending invite", async () => {
    const { orgService } = createOrgService();

    const created = await orgService.createOrganization({
      name: "Acme",
      slug: "acme-preview",
    });
    const invite = await orgService.createInvite({
      email: "member@acme.com",
      invitedByUserId: "user_platform",
      orgId: created.organization.id,
      role: "viewer",
    });

    await expect(orgService.previewInvite(invite.token)).resolves.toEqual({
      email: "member@acme.com",
      expiresAt: invite.invite.expiresAt,
      orgName: "Acme",
      role: "viewer",
    });
  });

  test("preview rejects unknown invite tokens", async () => {
    const { orgService } = createOrgService();

    await expect(orgService.previewInvite("missing")).rejects.toMatchObject({
      message: "Not found",
      status: 404,
    });
  });

  test("rejects expired invites", async () => {
    const { orgService, databaseAdapter } = createOrgService();
    const authService = new AuthService();
    const token = "tc_invite_expired";
    const now = new Date().toISOString();

    await databaseAdapter.upsertOrganization({
      createdAt: now,
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      updatedAt: now,
    });
    await databaseAdapter.createOrgInvite({
      acceptedAt: null,
      createdAt: now,
      email: "admin@acme.com",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      id: "invite_expired",
      invitedByUserId: "user_platform",
      orgId: "org_acme",
      revokedAt: null,
      role: "admin",
      tokenHash: authService.hashToken(token),
    });

    await expect(
      orgService.acceptInvite({ password: "secret123", token })
    ).rejects.toMatchObject({
      message: "Invite has expired.",
      status: 400,
    });
  });

  test("rejects empty names", async () => {
    const { orgService } = createOrgService();

    await expect(
      orgService.createOrganization({ name: "   ", slug: "acme" })
    ).rejects.toBeInstanceOf(AtlasApiError);
  });

  test("lists, updates, and removes members", async () => {
    const { orgService } = createOrgService();
    const created = await orgService.createOrganization({
      admin: {
        email: "admin@acme.com",
        name: "Acme Admin",
        phone: "+628123456789",
      },
      name: "Acme",
      slug: "acme",
    });

    const added = await orgService.addMember({
      email: "viewer@acme.com",
      name: "Viewer One",
      orgId: created.organization.id,
      phone: "+628111111111",
      role: "viewer",
    });

    const listed = await orgService.listMembers(created.organization.id);
    expect(listed.members).toHaveLength(2);
    expect(listed.members.map((member) => member.email).sort()).toEqual([
      "admin@acme.com",
      "viewer@acme.com",
    ]);

    const updated = await orgService.updateMember(
      created.organization.id,
      added.member.userId,
      {
        name: "Viewer Prime",
        phone: "+628222333444",
        role: "member",
      }
    );
    expect(updated.member.name).toBe("Viewer Prime");
    expect(updated.member.phone).toBe("+628222333444");
    expect(updated.member.role).toBe("member");

    await orgService.removeMember(created.organization.id, added.member.userId);
    const afterRemoval = await orgService.listMembers(created.organization.id);
    expect(afterRemoval.members).toHaveLength(1);
    expect(afterRemoval.members.map((member) => member.email).sort()).toEqual([
      "admin@acme.com",
    ]);
  });

  test("protects the last org admin from removal or demotion", async () => {
    const { orgService } = createOrgService();
    const created = await orgService.createOrganization({
      admin: {
        email: "admin@acme.com",
        name: "Acme Admin",
        phone: "+628123456789",
      },
      name: "Acme",
      slug: "acme",
    });

    const adminUserId = created.adminMember!.member.userId;

    await expect(
      orgService.removeMember(created.organization.id, adminUserId)
    ).rejects.toMatchObject({
      message: "Cannot remove the last Workspace Admin.",
      status: 409,
    });

    await expect(
      orgService.updateMember(created.organization.id, adminUserId, {
        role: "member",
      })
    ).rejects.toMatchObject({
      message: "Cannot change the role of the last Workspace Admin.",
      status: 409,
    });
  });

  test("serializes concurrent last-admin demotions so one remains admin", async () => {
    const { orgService, databaseAdapter } = createOrgService();
    const created = await orgService.createOrganization({
      admin: {
        email: "admin@acme.com",
        name: "Acme Admin",
        phone: "+628123456789",
      },
      name: "Acme",
      slug: "acme",
    });
    const firstAdminId = created.adminMember!.member.userId;
    const second = await orgService.addMember({
      email: "second@acme.com",
      name: "Second Admin",
      orgId: created.organization.id,
      phone: "+628123456780",
      role: "admin",
    });

    await databaseAdapter.deleteOrgMember(
      created.organization.id,
      LOCAL_CLIENT_USER_ID
    );

    const results = await Promise.allSettled([
      orgService.updateMember(created.organization.id, firstAdminId, {
        role: "member",
      }),
      orgService.updateMember(created.organization.id, second.member.userId, {
        role: "member",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
    });

    const remaining = await databaseAdapter.listOrgMembers(
      created.organization.id
    );
    expect(remaining.filter((member) => member.role === "admin")).toHaveLength(
      1
    );
  });
});
