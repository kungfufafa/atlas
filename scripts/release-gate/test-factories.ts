import type { DatabaseAdapter } from "@atlas/db";
import type { AuthService } from "../../apps/server/src/services/auth-service";
import type { OrgService } from "../../apps/server/src/services/org-service";

export interface TestTenantData {
  adminEmail: string;
  adminId: string;
  adminPassword: string;
  orgId: string;
  orgName: string;
  slug: string;
}

export interface TestUserData {
  email: string;
  name: string;
  orgId: string;
  password: string;
  role: "admin" | "member" | "viewer";
  userId: string;
}

export class TestTenantFactory {
  constructor(
    private readonly orgService: OrgService,
    private readonly authService: AuthService,
    private readonly db: DatabaseAdapter
  ) {}

  async createTenant(options: {
    adminEmail?: string;
    adminName?: string;
    adminPassword?: string;
    name: string;
    slug?: string;
  }): Promise<TestTenantData> {
    const orgName = options.name;
    const slug =
      options.slug ??
      orgName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
    const adminEmail = options.adminEmail ?? `admin-${slug}@test.local`;
    const adminName = options.adminName ?? `${orgName} Admin`;
    const adminPassword = options.adminPassword ?? "Password123!";

    const userCount = await this.db.countHumanUsers();

    if (userCount === 0) {
      // First boot bootstrap
      const res = await this.orgService.bootstrapInitialSetup({
        admin: {
          email: adminEmail,
          name: adminName,
          passwordHash: await this.authService.hashPassword(adminPassword),
          phone: "",
        },
        organization: {
          name: orgName,
          slug,
        },
      });

      return {
        adminEmail: res.user.email,
        adminId: res.user.id,
        adminPassword,
        orgId: res.organization.id,
        orgName: res.organization.name,
        slug: res.organization.slug,
      };
    }

    // Subsequent orgs
    const res = await this.orgService.createOrganization({
      admin: {
        email: adminEmail,
        name: adminName,
        phone: "",
      },
      name: orgName,
      slug,
    });
    if (!res.adminMember) {
      throw new Error("Tenant fixture did not create its administrator.");
    }
    await this.db.updateUserPassword(
      res.adminMember.member.userId,
      await this.authService.hashPassword(adminPassword),
      new Date().toISOString()
    );

    return {
      adminEmail: res.adminMember?.member.email ?? adminEmail,
      adminId: res.adminMember?.member.userId ?? "",
      adminPassword,
      orgId: res.organization.id,
      orgName: res.organization.name,
      slug: res.organization.slug,
    };
  }

  async createUser(
    orgId: string,
    options: {
      email: string;
      name: string;
      password?: string;
      role?: "admin" | "member" | "viewer";
    }
  ): Promise<TestUserData> {
    const password = options.password ?? "Password123!";
    const role = options.role ?? "member";

    const res = await this.orgService.addMember({
      email: options.email,
      name: options.name,
      orgId,
      phone: "",
      role,
    });
    await this.db.updateUserPassword(
      res.member.userId,
      await this.authService.hashPassword(password),
      new Date().toISOString()
    );

    return {
      email: res.member.email,
      name: res.member.name ?? options.name,
      orgId,
      password,
      role,
      userId: res.member.userId,
    };
  }
}
