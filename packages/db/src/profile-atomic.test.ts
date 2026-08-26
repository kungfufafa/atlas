import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter, createSqliteDatabase } from "./index";
import type {
  DatabaseAdapter,
  ProfileImportPublication,
  StoredProfileRecord,
} from "./types";

const NOW = "2026-08-26T00:00:00.000Z";

function profile(orgId: string): StoredProfileRecord {
  return {
    createdAt: NOW,
    id: "shared-profile-id",
    isDefault: false,
    isSuper: false,
    model: null,
    name: orgId,
    orgId,
    systemPrompt: orgId,
    updatedAt: NOW,
  };
}

describe("SQLite atomic profile creation", () => {
  test("does not overwrite or cross-delete a profile owned by another org", async () => {
    const database = await createSqliteDatabase(":memory:");
    const db = database.adapter;

    try {
      for (const orgId of ["org_a", "org_b"]) {
        await db.upsertOrganization({
          createdAt: NOW,
          id: orgId,
          name: orgId,
          slug: orgId.replace("_", "-"),
          updatedAt: NOW,
        });
      }

      expect(await db.createProfileIfAbsent(profile("org_a"))).toBe(true);
      expect(await db.createProfileIfAbsent(profile("org_b"))).toBe(false);
      expect(await db.getProfile("shared-profile-id")).toMatchObject({
        orgId: "org_a",
        systemPrompt: "org_a",
      });
      expect(await db.deleteProfileForOrg("shared-profile-id", "org_b")).toBe(
        false
      );
      expect(await db.getProfile("shared-profile-id")).not.toBeNull();
      expect(await db.deleteProfileForOrg("shared-profile-id", "org_a")).toBe(
        true
      );
    } finally {
      database.close();
    }
  });
});

async function withDatabaseVariants(
  run: (db: DatabaseAdapter, kind: "memory" | "sqlite") => Promise<void>
): Promise<void> {
  await run(createInMemoryDatabaseAdapter(), "memory");
  const database = await createSqliteDatabase(":memory:");
  try {
    await run(database.adapter, "sqlite");
  } finally {
    database.close();
  }
}

async function seedImportOrganization(db: DatabaseAdapter): Promise<void> {
  await db.upsertOrganization({
    createdAt: NOW,
    id: "org_import",
    name: "Import",
    slug: "import",
    updatedAt: NOW,
  });
}

function emptyPublication(): ProfileImportPublication {
  return {
    composioAssignments: [],
    expectedTools: [],
    mcpServerIds: [],
    newSkills: [],
    newTools: [],
    orgId: "org_import",
    profileId: "reserved",
    skillIds: [],
    toolIds: [],
  };
}

describe("profile import publication", () => {
  test("keeps reservations hidden and prevents normal writers from publishing them", async () => {
    await withDatabaseVariants(async (db) => {
      await seedImportOrganization(db);
      expect(
        await db.reserveProfileImport({
          ...profile("org_import"),
          id: "reserved",
          isImporting: true,
        })
      ).toBe("reserved");
      await db.upsertProfile({
        ...profile("org_import"),
        id: "reserved",
        isImporting: false,
        systemPrompt: "must not overwrite",
      });
      await db.assignToolToProfile("reserved", "missing-tool");
      expect(await db.getProfile("reserved")).toBeNull();
      expect(await db.listProfilesForOrg("org_import")).toEqual([]);
      expect(await db.listToolsForProfile("reserved")).toEqual([]);

      expect(await db.publishProfileImport(emptyPublication())).toBe(
        "published"
      );
      expect(await db.getProfile("reserved")).toMatchObject({
        isImporting: false,
        systemPrompt: "org_import",
      });

      await db.upsertProfile({
        ...profile("org_import"),
        id: "normal-create",
        isImporting: true,
      });
      expect(await db.getProfile("normal-create")).not.toBeNull();
      expect(
        await db.createProfileIfAbsent({
          ...profile("org_import"),
          id: "normal-create-if-absent",
          isImporting: true,
        })
      ).toBe(true);
      expect(await db.getProfile("normal-create-if-absent")).not.toBeNull();
    });
  });

  test("rejects malformed publication graphs without exposing partial state", async () => {
    await withDatabaseVariants(async (db, kind) => {
      await seedImportOrganization(db);
      expect(
        await db.reserveProfileImport({
          ...profile("org_import"),
          id: "reserved",
        })
      ).toBe("reserved");
      await db.upsertTool({
        createdAt: NOW,
        description: "Existing",
        handlerConfig: {},
        handlerType: "builtin",
        id: "existing-tool",
        name: `existing-${kind}`,
        orgId: "org_import",
        updatedAt: NOW,
      });

      const existingWithoutExpectation: ProfileImportPublication = {
        ...emptyPublication(),
        toolIds: ["existing-tool"],
      };
      expect(await db.publishProfileImport(existingWithoutExpectation)).toBe(
        "conflict"
      );

      const orphanTool: ProfileImportPublication = {
        ...emptyPublication(),
        newTools: [
          {
            createdAt: NOW,
            description: "Orphan",
            handlerConfig: {},
            handlerType: "javascript",
            id: "orphan-tool",
            name: `orphan-${kind}`,
            orgId: "org_import",
            updatedAt: NOW,
          },
        ],
      };
      expect(await db.publishProfileImport(orphanTool)).toBe("conflict");

      const duplicateNames: ProfileImportPublication = {
        ...emptyPublication(),
        newTools: [
          { ...orphanTool.newTools[0]!, id: "new-a", name: "duplicate" },
          { ...orphanTool.newTools[0]!, id: "new-b", name: "duplicate" },
        ],
        toolIds: ["new-a", "new-b"],
      };
      expect(await db.publishProfileImport(duplicateNames)).toBe("conflict");

      const duplicateToolIds: ProfileImportPublication = {
        ...emptyPublication(),
        newTools: [
          { ...orphanTool.newTools[0]!, id: "duplicate-id", name: "first" },
          { ...orphanTool.newTools[0]!, id: "duplicate-id", name: "second" },
        ],
        toolIds: ["duplicate-id"],
      };
      expect(await db.publishProfileImport(duplicateToolIds)).toBe("conflict");

      const expectationForNewTool: ProfileImportPublication = {
        ...emptyPublication(),
        expectedTools: [
          {
            description: "Orphan",
            handlerConfig: {},
            handlerType: "javascript",
            id: "new-with-expectation",
            name: "new-with-expectation",
            orgId: "org_import",
          },
        ],
        newTools: [
          {
            ...orphanTool.newTools[0]!,
            id: "new-with-expectation",
            name: "new-with-expectation",
          },
        ],
        toolIds: ["new-with-expectation"],
      };
      expect(await db.publishProfileImport(expectationForNewTool)).toBe(
        "conflict"
      );

      const skillTemplate = {
        createdAt: NOW,
        createdBy: "human" as const,
        description: "Imported skill",
        disableModelInvocation: false,
        enabled: true,
        hasTool: false,
        id: "skill-a",
        name: "duplicate-skill",
        orgId: "org_import",
        sourcePath: `/tmp/${kind}/skill-a`,
        updatedAt: NOW,
      };
      const duplicateSkillNames: ProfileImportPublication = {
        ...emptyPublication(),
        newSkills: [
          skillTemplate,
          {
            ...skillTemplate,
            id: "skill-b",
            sourcePath: `/tmp/${kind}/skill-b`,
          },
        ],
        skillIds: ["skill-a", "skill-b"],
      };
      expect(await db.publishProfileImport(duplicateSkillNames)).toBe(
        "conflict"
      );

      const duplicateSkillIds: ProfileImportPublication = {
        ...emptyPublication(),
        newSkills: [
          skillTemplate,
          {
            ...skillTemplate,
            name: "second-skill",
            sourcePath: `/tmp/${kind}/skill-b`,
          },
        ],
        skillIds: ["skill-a"],
      };
      expect(await db.publishProfileImport(duplicateSkillIds)).toBe("conflict");

      const orphanSkill: ProfileImportPublication = {
        ...emptyPublication(),
        newSkills: [skillTemplate],
      };
      expect(await db.publishProfileImport(orphanSkill)).toBe("conflict");

      const duplicateComposio: ProfileImportPublication = {
        ...emptyPublication(),
        composioAssignments: [
          {
            allowedActions: ["read"],
            profileId: "reserved",
            toolkitId: "duplicate-toolkit",
          },
          {
            allowedActions: ["write"],
            profileId: "reserved",
            toolkitId: "duplicate-toolkit",
          },
        ],
      };
      expect(await db.publishProfileImport(duplicateComposio)).toBe("conflict");

      const duplicateExpectations: ProfileImportPublication = {
        ...emptyPublication(),
        expectedTools: [
          {
            description: "Existing",
            handlerConfig: {},
            handlerType: "builtin",
            id: "existing-tool",
            name: `existing-${kind}`,
            orgId: "org_import",
          },
          {
            description: "Existing",
            handlerConfig: {},
            handlerType: "builtin",
            id: "existing-tool",
            name: `existing-${kind}`,
            orgId: "org_import",
          },
        ],
        toolIds: ["existing-tool"],
      };
      expect(await db.publishProfileImport(duplicateExpectations)).toBe(
        "conflict"
      );

      const extraExpectation: ProfileImportPublication = {
        ...emptyPublication(),
        expectedTools: [duplicateExpectations.expectedTools[0]!],
      };
      expect(await db.publishProfileImport(extraExpectation)).toBe("conflict");

      expect(await db.getProfile("reserved")).toBeNull();
      expect(await db.getTool("orphan-tool")).toBeNull();
      expect(await db.getTool("new-a")).toBeNull();
    });
  });
});
