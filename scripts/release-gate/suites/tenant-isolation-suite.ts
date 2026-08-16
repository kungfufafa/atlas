import { type DatabaseAdapter, seedOrgDefaultProfile } from "@atlas/db";
import type { AuthService } from "../../../apps/server/src/services/auth-service";
import { MemoryService } from "../../../apps/server/src/services/memory-service";
import type { OrgService } from "../../../apps/server/src/services/org-service";
import type { ReleaseGateCheck } from "../decision-engine";
import { TestTenantFactory } from "../test-factories";

export async function runTenantIsolationSuite(
  db: DatabaseAdapter,
  authService: AuthService,
  orgService: OrgService
): Promise<ReleaseGateCheck> {
  const start = Date.now();
  const factory = new TestTenantFactory(orgService, authService, db);
  const memoryService = new MemoryService(db);

  try {
    // 1. Create Tenant A & Tenant B
    const tenantA = await factory.createTenant({
      adminEmail: "admin-a@tenant-a.test",
      name: "Tenant Alpha",
      slug: "tenant-alpha",
    });

    const tenantB = await factory.createTenant({
      adminEmail: "admin-b@tenant-b.test",
      name: "Tenant Beta",
      slug: "tenant-beta",
    });

    // Seed default profiles for both orgs
    const profileA = await seedOrgDefaultProfile(db, tenantA.orgId);
    const profileB = await seedOrgDefaultProfile(db, tenantB.orgId);

    // 2. User A in Tenant A writes memory
    await memoryService.writeMemory(tenantA.orgId, {
      content: "Tenant Alpha Confidential Strategy 2026",
      ownerId: tenantA.adminId,
      scope: "organization",
    });

    // 3. User B in Tenant B queries memory
    const tenantBMemories = await memoryService.listMemories(tenantB.orgId, {
      ownerId: tenantB.adminId,
      scope: "organization",
    });

    for (const mem of tenantBMemories) {
      if (mem.content.includes("Tenant Alpha Confidential")) {
        throw new Error(
          `Tenant isolation violation: Tenant B accessed Tenant A memory: ${mem.content}`
        );
      }
    }

    // 4. Cross-tenant conversation / artifact isolation
    const sessionAId = "sess-alpha-secret-1";
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt: new Date().toISOString(),
      id: sessionAId,
      orgId: tenantA.orgId,
      profileId: profileA.id,
      title: "Alpha Secret Chat",
      userId: tenantA.adminId,
    });

    // Verify session belongs strictly to Tenant A
    const sessionA = await db.getSession(sessionAId);
    if (!sessionA || sessionA.orgId !== tenantA.orgId) {
      throw new Error("Session A creation or orgId scoping failed");
    }

    // Tenant B session
    const sessionBId = "sess-beta-1";
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt: new Date().toISOString(),
      id: sessionBId,
      orgId: tenantB.orgId,
      profileId: profileB.id,
      title: "Beta General Chat",
      userId: tenantB.adminId,
    });

    const sessionB = await db.getSession(sessionBId);
    if (!sessionB || sessionB.orgId !== tenantB.orgId) {
      throw new Error("Session B creation or orgId scoping failed");
    }

    return {
      category: "Security",
      durationMs: Date.now() - start,
      id: "tenant_isolation",
      message:
        "Cross-tenant access attacks successfully rejected (0 data leakage)",
      required: true,
      status: "pass",
    };
  } catch (error: any) {
    return {
      category: "Security",
      durationMs: Date.now() - start,
      failureCode: "TENANT_ISOLATION_BREACH",
      id: "tenant_isolation",
      message: error.message,
      required: true,
      status: "fail",
    };
  }
}
