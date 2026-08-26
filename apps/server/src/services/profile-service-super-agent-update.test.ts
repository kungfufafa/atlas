import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseAdapter, StoredOrganizationRecord } from "@atlas/db";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ProfileService } from "./profile-service";

const originalConfigDir = process.env.ATLAS_CONFIG_DIR;
const ORG_ID = "org_profile_update";
const OTHER_ORG_ID = "org_other";
const USER_ID = "user_admin";

async function seedDatabase(options?: {
  adapter?: DatabaseAdapter;
  platformAdmin?: boolean;
  role?: "admin" | "member" | "viewer";
}) {
  const db = options?.adapter ?? createInMemoryDatabaseAdapter();
  const now = "2026-08-26T00:00:00.000Z";
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Profile Update",
    slug: "profile-update",
    updatedAt: now,
  });
  await db.upsertOrganization({
    createdAt: now,
    id: OTHER_ORG_ID,
    name: "Other",
    slug: "other",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "admin@example.test",
    id: USER_ID,
    isPlatformAdmin: options?.platformAdmin ?? false,
    passwordHash: "test",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: options?.role ?? "admin",
    userId: USER_ID,
  });
  return db;
}

describe("ProfileService Super Agent update", () => {
  let configDir = "";

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = originalConfigDir;
    }
    if (configDir) {
      await rm(configDir, { force: true, recursive: true });
      configDir = "";
    }
  });

  async function createFixture(options?: Parameters<typeof seedDatabase>[0]) {
    configDir = await mkdtemp(join(tmpdir(), "atlas-profile-update-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
    const db = await seedDatabase(options);
    const service = new ProfileService(db);
    const created = await service.createProfile(ORG_ID, {
      model: "openai:gpt-5",
      name: "Support",
      soulFiles: {
        "INSTRUCTIONS.md": "Original instructions",
        "MEMORY.md": "Original memory",
        "SOUL.md": "Original soul",
        "STYLE.md": "Original style",
      },
      systemPrompt: "Original prompt",
    });
    return { db, profileId: created.profile.id, service };
  }

  test("updates partial profile and soul state without elevating immutable flags", async () => {
    const { db, profileId, service } = await createFixture();

    const result = await service.updateProfileAsActor(
      ORG_ID,
      profileId,
      {
        model: null,
        name: "Customer Support",
        skillsPostTurnReview: true,
        skillsWriteApproval: null,
        soulFiles: { "SOUL.md": "Updated soul" },
        systemPrompt: " Updated prompt ",
      },
      { userId: USER_ID }
    );

    expect(result.profile).toMatchObject({
      id: profileId,
      isDefault: false,
      isSuper: false,
      model: null,
      name: "Customer Support",
      skillsPostTurnReview: true,
      skillsWriteApproval: null,
      systemPrompt: "Updated prompt",
    });
    const stored = await db.getProfileForOrg(profileId, ORG_ID);
    expect(stored?.isDefault).toBe(false);
    expect(stored?.isSuper).toBe(false);

    const soulDir = join(configDir, "orgs", ORG_ID, "profiles", profileId);
    expect(await readFile(join(soulDir, "SOUL.md"), "utf8")).toBe(
      "Updated soul"
    );
    expect(await readFile(join(soulDir, "STYLE.md"), "utf8")).toBe(
      "Original style"
    );
    expect((await lstat(soulDir)).mode % 0o1000).toBe(0o700);
    expect((await lstat(join(soulDir, "SOUL.md"))).mode % 0o1000).toBe(0o600);
  });

  test("preserves omitted write-approval governance", async () => {
    const { profileId, service } = await createFixture();
    await service.updateProfile(ORG_ID, profileId, {
      skillsPostTurnReview: false,
      skillsWriteApproval: true,
    });

    const result = await service.updateProfileAsActor(
      ORG_ID,
      profileId,
      { name: "Renamed only" },
      { userId: USER_ID }
    );

    expect(result.profile.skillsPostTurnReview).toBe(false);
    expect(result.profile.skillsWriteApproval).toBe(true);
  });

  test("denies cross-org targets and non-admin actors", async () => {
    const memberFixture = await createFixture({ role: "member" });
    await expect(
      memberFixture.service.updateProfileAsActor(
        ORG_ID,
        memberFixture.profileId,
        { name: "Denied" },
        { userId: USER_ID }
      )
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      memberFixture.service.updateProfileAsActor(
        OTHER_ORG_ID,
        memberFixture.profileId,
        { name: "Moved" },
        { userId: USER_ID }
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await memberFixture.db.getProfileForOrg(memberFixture.profileId, ORG_ID))
        ?.name
    ).toBe("Support");
  });

  test("allows a platform admin while still requiring an active org", async () => {
    const { db, profileId, service } = await createFixture({
      platformAdmin: true,
      role: "viewer",
    });
    await expect(
      service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { name: "Platform Managed" },
        { userId: USER_ID }
      )
    ).resolves.toMatchObject({ profile: { name: "Platform Managed" } });

    const org = await db.getOrganizationById(ORG_ID);
    await db.upsertOrganization({
      ...org!,
      archivedAt: "2026-08-26T01:00:00.000Z",
    });
    await expect(
      service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { name: "Archived Write" },
        { userId: USER_ID }
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  test("rolls back published soul files when the org archives before DB commit", async () => {
    const base = createInMemoryDatabaseAdapter();
    let organizationReads = 0;
    const adapter = {
      ...base,
      async getOrganizationById(
        orgId: string
      ): Promise<StoredOrganizationRecord | null> {
        const organization = await base.getOrganizationById(orgId);
        organizationReads += 1;
        if (organization && organizationReads >= 3) {
          return {
            ...organization,
            archivedAt: "2026-08-26T01:00:00.000Z",
          };
        }
        return organization;
      },
    } satisfies DatabaseAdapter;
    const { db, profileId, service } = await createFixture({ adapter });
    const soulPath = join(
      configDir,
      "orgs",
      ORG_ID,
      "profiles",
      profileId,
      "SOUL.md"
    );

    await expect(
      service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { name: "Should Roll Back", soulFiles: { "SOUL.md": "New soul" } },
        { userId: USER_ID }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(soulPath, "utf8")).toBe("Original soul");
    expect((await db.getProfileForOrg(profileId, ORG_ID))?.name).toBe(
      "Support"
    );
  });

  test("rolls back when the actor loses admin permission during the update", async () => {
    const base = createInMemoryDatabaseAdapter();
    let membershipReads = 0;
    const adapter = {
      ...base,
      async getOrgMember(orgId: string, userId: string) {
        const member = await base.getOrgMember(orgId, userId);
        membershipReads += 1;
        return member && membershipReads >= 3
          ? { ...member, role: "member" as const }
          : member;
      },
    } satisfies DatabaseAdapter;
    const { db, profileId, service } = await createFixture({ adapter });
    const stylePath = join(
      configDir,
      "orgs",
      ORG_ID,
      "profiles",
      profileId,
      "STYLE.md"
    );

    await expect(
      service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { name: "Denied", soulFiles: { "STYLE.md": "New style" } },
        { userId: USER_ID }
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(await readFile(stylePath, "utf8")).toBe("Original style");
    expect((await db.getProfileForOrg(profileId, ORG_ID))?.name).toBe(
      "Support"
    );
  });

  test("rolls back soul files when the database commit fails", async () => {
    const base = createInMemoryDatabaseAdapter();
    let rejectUpdates = false;
    const adapter = {
      ...base,
      async upsertProfile(
        record: Parameters<DatabaseAdapter["upsertProfile"]>[0]
      ) {
        if (rejectUpdates && record.name === "Rejected") {
          throw new Error("database unavailable");
        }
        return base.upsertProfile(record);
      },
    } satisfies DatabaseAdapter;
    const { db, profileId, service } = await createFixture({ adapter });
    rejectUpdates = true;
    const soulPath = join(
      configDir,
      "orgs",
      ORG_ID,
      "profiles",
      profileId,
      "SOUL.md"
    );

    await expect(
      service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { name: "Rejected", soulFiles: { "SOUL.md": "New soul" } },
        { userId: USER_ID }
      )
    ).rejects.toThrow("database unavailable");
    expect(await readFile(soulPath, "utf8")).toBe("Original soul");
    expect((await db.getProfileForOrg(profileId, ORG_ID))?.name).toBe(
      "Support"
    );
  });

  test("serializes soul updates across ProfileService instances", async () => {
    const base = createInMemoryDatabaseAdapter();
    let blockFirstUpdate = false;
    let releaseFirstUpdate: (() => void) | undefined;
    let signalFirstUpdate: (() => void) | undefined;
    const firstUpdateReachedDatabase = new Promise<void>((resolve) => {
      signalFirstUpdate = resolve;
    });
    const firstUpdateGate = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const adapter = {
      ...base,
      async upsertProfile(
        record: Parameters<DatabaseAdapter["upsertProfile"]>[0]
      ) {
        if (blockFirstUpdate && record.name === "First update") {
          signalFirstUpdate?.();
          await firstUpdateGate;
        }
        return base.upsertProfile(record);
      },
    } satisfies DatabaseAdapter;
    const { db, profileId, service } = await createFixture({ adapter });
    const secondService = new ProfileService(adapter);
    blockFirstUpdate = true;

    const first = service.updateProfile(ORG_ID, profileId, {
      name: "First update",
      soulFiles: { "SOUL.md": "First soul" },
    });
    await firstUpdateReachedDatabase;

    let secondFinished = false;
    const second = secondService
      .updateProfile(ORG_ID, profileId, {
        name: "Second update",
        soulFiles: { "SOUL.md": "Second soul" },
      })
      .then((result) => {
        secondFinished = true;
        return result;
      });
    await Promise.resolve();
    expect(secondFinished).toBe(false);

    releaseFirstUpdate?.();
    await Promise.all([first, second]);
    expect((await db.getProfileForOrg(profileId, ORG_ID))?.name).toBe(
      "Second update"
    );
    expect(
      await readFile(
        join(configDir, "orgs", ORG_ID, "profiles", profileId, "SOUL.md"),
        "utf8"
      )
    ).toBe("Second soul");
  });

  test("CAS rollback preserves a newer out-of-band soul write", async () => {
    const base = createInMemoryDatabaseAdapter();
    let concurrentSoulPath = "";
    let rejectUpdate = false;
    const adapter = {
      ...base,
      async upsertProfile(
        record: Parameters<DatabaseAdapter["upsertProfile"]>[0]
      ) {
        if (rejectUpdate && record.name === "Rejected") {
          await writeFile(concurrentSoulPath, "Newer external soul", "utf8");
          throw new Error("database unavailable");
        }
        return base.upsertProfile(record);
      },
    } satisfies DatabaseAdapter;
    const { db, profileId, service } = await createFixture({ adapter });
    concurrentSoulPath = join(
      configDir,
      "orgs",
      ORG_ID,
      "profiles",
      profileId,
      "SOUL.md"
    );
    rejectUpdate = true;

    let failure: unknown;
    try {
      await service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { name: "Rejected", soulFiles: { "SOUL.md": "Staged soul" } },
        { userId: USER_ID }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(await readFile(concurrentSoulPath, "utf8")).toBe(
      "Newer external soul"
    );
    expect((await db.getProfileForOrg(profileId, ORG_ID))?.name).toBe(
      "Support"
    );
  });

  test("rejects symlink targets, oversized content, and hidden fields", async () => {
    const { db, profileId, service } = await createFixture();
    const soulDir = join(configDir, "orgs", ORG_ID, "profiles", profileId);
    const outside = join(configDir, "outside.md");
    await writeFile(outside, "outside", "utf8");
    await rm(join(soulDir, "SOUL.md"));
    await symlink(outside, join(soulDir, "SOUL.md"));

    await expect(
      service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { soulFiles: { "SOUL.md": "attack" } },
        { userId: USER_ID }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(outside, "utf8")).toBe("outside");

    const outsideDir = join(configDir, "outside-profile");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "STYLE.md"), "outside style", "utf8");
    await rm(soulDir, { force: true, recursive: true });
    await symlink(outsideDir, soulDir);
    await expect(
      service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { soulFiles: { "STYLE.md": "attack" } },
        { userId: USER_ID }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(outsideDir, "STYLE.md"), "utf8")).toBe(
      "outside style"
    );

    await expect(
      service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { systemPrompt: "x".repeat(1024 * 1024 + 1) },
        { userId: USER_ID }
      )
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      service.updateProfileAsActor(
        ORG_ID,
        profileId,
        { isSuper: true } as never,
        { userId: USER_ID }
      )
    ).rejects.toMatchObject({ status: 400 });
    expect((await db.getProfileForOrg(profileId, ORG_ID))?.isSuper).toBe(false);
  });
});
