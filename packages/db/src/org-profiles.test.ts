import { describe, expect, test } from "bun:test";
import {
  BASH_TOOL_ID,
  BUILTIN_TOOL_IDS,
  GENERATE_IMAGE_TOOL_ID,
} from "@atlas/core/tools/protected";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import {
  ensureBundledSkillsAssigned,
  ensureOrgSuperAgentProfiles,
  seedOrgDefaultProfile,
  seedOrgSuperAgentProfile,
} from "./org-profiles";
import { ensureBuiltinToolDefinitions } from "./seed";

async function upsertSkill(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>,
  name: string
) {
  const now = new Date().toISOString();
  await db.upsertSkill({
    body: "test skill body",
    createdAt: now,
    description: "test skill description",
    id: `skill_${name}`,
    name,
    updatedAt: now,
  });
}

describe("seedOrgDefaultProfile", () => {
  test("creates one default profile per org", async () => {
    const db = createInMemoryDatabaseAdapter();

    const orgADefault = await seedOrgDefaultProfile(db, "org_a");
    const orgBDefault = await seedOrgDefaultProfile(db, "org_b");

    expect(orgADefault.orgId).toBe("org_a");
    expect(orgBDefault.orgId).toBe("org_b");
    expect(orgADefault.id).not.toBe(orgBDefault.id);
    expect(orgADefault.isDefault).toBe(true);
    expect(orgADefault.isSuper).toBe(false);
    expect(orgADefault.name).toBe("Default Agent");

    const orgAList = await db.listProfilesForOrg("org_a");
    expect(orgAList).toHaveLength(1);
    expect(orgAList[0]?.id).toBe(orgADefault.id);
  });

  test("seeds empty systemPrompt so soul stack defines identity", async () => {
    const db = createInMemoryDatabaseAdapter();

    const seeded = await seedOrgDefaultProfile(db, "org_a");

    expect(seeded.systemPrompt).toBe("");
  });

  test("is idempotent for the same org", async () => {
    const db = createInMemoryDatabaseAdapter();
    const first = await seedOrgDefaultProfile(db, "org_a");
    const second = await seedOrgDefaultProfile(db, "org_a");

    expect(second.id).toBe(first.id);
    expect(await db.listProfilesForOrg("org_a")).toHaveLength(1);
  });

  test("assigns the Default Agent toolkit without Super Agent extras", async () => {
    const db = createInMemoryDatabaseAdapter();
    await ensureBuiltinToolDefinitions(db);

    const profile = await seedOrgDefaultProfile(db, "org_a");
    const toolIds = (await db.listToolsForProfile(profile.id)).map(
      (tool) => tool.id
    );

    expect(toolIds).toContain(BUILTIN_TOOL_IDS.web_search);
    expect(toolIds).toContain(BUILTIN_TOOL_IDS.deep_research);
    expect(toolIds).toContain(BUILTIN_TOOL_IDS.write_pptx);
    expect(toolIds).toContain(BUILTIN_TOOL_IDS.browser);
    expect(toolIds).not.toContain(BASH_TOOL_ID);
    expect(toolIds).not.toContain(GENERATE_IMAGE_TOOL_ID);
  });

  test("does not rewrite tools on an existing Default Agent", async () => {
    const db = createInMemoryDatabaseAdapter();
    await ensureBuiltinToolDefinitions(db);

    const first = await seedOrgDefaultProfile(db, "org_a");
    await db.unassignToolFromProfile(first.id, BUILTIN_TOOL_IDS.web_search);

    const second = await seedOrgDefaultProfile(db, "org_a");
    const toolIds = (await db.listToolsForProfile(second.id)).map(
      (tool) => tool.id
    );

    expect(second.id).toBe(first.id);
    expect(toolIds).not.toContain(BUILTIN_TOOL_IDS.web_search);
  });

  test("assigns default bundled skills but not super agent skills", async () => {
    const db = createInMemoryDatabaseAdapter();
    await upsertSkill(db, "create-automation");
    await upsertSkill(db, "manage-skills");
    await upsertSkill(db, "update-profile-memory");
    await upsertSkill(db, "archive-profile-memory");
    await upsertSkill(db, "save-artifact");
    await upsertSkill(db, "create-profile");

    const profile = await seedOrgDefaultProfile(db, "org_a");
    const skillNames = (await db.listSkillsForProfile(profile.id)).map(
      (skill) => skill.name
    );

    expect(skillNames).toContain("create-automation");
    expect(skillNames).toContain("manage-skills");
    expect(skillNames).toContain("update-profile-memory");
    expect(skillNames).toContain("archive-profile-memory");
    expect(skillNames).toContain("save-artifact");
    expect(skillNames).not.toContain("create-profile");
  });
});

describe("seedOrgSuperAgentProfile", () => {
  test("creates one super agent per org", async () => {
    const db = createInMemoryDatabaseAdapter();

    const orgASuperAgent = await seedOrgSuperAgentProfile(db, "org_a");
    const orgBSuperAgent = await seedOrgSuperAgentProfile(db, "org_b");

    expect(orgASuperAgent.orgId).toBe("org_a");
    expect(orgBSuperAgent.orgId).toBe("org_b");
    expect(orgASuperAgent.id).not.toBe(orgBSuperAgent.id);
    expect(orgASuperAgent.isSuper).toBe(true);
    expect(orgASuperAgent.isDefault).toBe(false);
    expect(orgASuperAgent.name).toBe("Super Agent");

    const orgAList = await db.listProfilesForOrg("org_a");
    expect(orgAList).toHaveLength(1);
    expect(orgAList[0]?.id).toBe(orgASuperAgent.id);
  });

  test("assigns builtins and bash", async () => {
    const db = createInMemoryDatabaseAdapter();
    await ensureBuiltinToolDefinitions(db);
    const profile = await seedOrgSuperAgentProfile(db, "org_a");
    const toolIds = (await db.listToolsForProfile(profile.id)).map(
      (tool) => tool.id
    );

    for (const toolId of Object.values(BUILTIN_TOOL_IDS)) {
      expect(toolIds).toContain(toolId);
    }

    expect(toolIds).toContain(BASH_TOOL_ID);
    expect(toolIds).not.toContain(GENERATE_IMAGE_TOOL_ID);
  });

  test("assigns super agent bundled skills", async () => {
    const db = createInMemoryDatabaseAdapter();
    await upsertSkill(db, "create-automation");
    await upsertSkill(db, "create-profile");
    await upsertSkill(db, "coding-agent");
    await upsertSkill(db, "agent-browser");

    const profile = await seedOrgSuperAgentProfile(db, "org_a");
    const skillNames = (await db.listSkillsForProfile(profile.id)).map(
      (skill) => skill.name
    );

    expect(skillNames).toContain("create-automation");
    expect(skillNames).toContain("create-profile");
    expect(skillNames).toContain("coding-agent");
    expect(skillNames).not.toContain("agent-browser");
  });

  test("is idempotent for the same org", async () => {
    const db = createInMemoryDatabaseAdapter();
    const first = await seedOrgSuperAgentProfile(db, "org_a");
    const second = await seedOrgSuperAgentProfile(db, "org_a");

    expect(second.id).toBe(first.id);
    expect(await db.listProfilesForOrg("org_a")).toHaveLength(1);
  });

  test("backfills newly added bundled skills on existing super agent", async () => {
    const db = createInMemoryDatabaseAdapter();

    const profile = await seedOrgSuperAgentProfile(db, "org_a");
    await upsertSkill(db, "update-profile-memory");
    await upsertSkill(db, "archive-profile-memory");
    await upsertSkill(db, "save-artifact");

    await seedOrgSuperAgentProfile(db, "org_a");

    const skillNames = (await db.listSkillsForProfile(profile.id)).map(
      (skill) => skill.name
    );
    expect(skillNames).toContain("update-profile-memory");
    expect(skillNames).toContain("archive-profile-memory");
    expect(skillNames).toContain("save-artifact");
  });

  test("backfills super agent bundled skills on existing super agent", async () => {
    const db = createInMemoryDatabaseAdapter();

    const profile = await seedOrgSuperAgentProfile(db, "org_a");
    await upsertSkill(db, "create-profile");

    await seedOrgSuperAgentProfile(db, "org_a");

    const skillNames = (await db.listSkillsForProfile(profile.id)).map(
      (skill) => skill.name
    );
    expect(skillNames).toContain("create-profile");
  });
});

describe("ensureBundledSkillsAssigned", () => {
  test("does not assign super agent-only skills to ordinary profiles", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_a",
      name: "Org A",
      slug: "org-a",
      updatedAt: now,
    });

    const defaultProfile = await seedOrgDefaultProfile(db, "org_a");
    await upsertSkill(db, "create-profile");

    await ensureBundledSkillsAssigned(db);

    const defaultSkills = (
      await db.listSkillsForProfile(defaultProfile.id)
    ).map((skill) => skill.name);
    expect(defaultSkills).not.toContain("create-profile");
  });
});

describe("ensureOrgSuperAgentProfiles", () => {
  test("backfills super agent for existing orgs", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_legacy",
      name: "Legacy Org",
      slug: "legacy-org",
      updatedAt: now,
    });
    await seedOrgDefaultProfile(db, "org_legacy");

    expect(
      (await db.listProfilesForOrg("org_legacy")).some(
        (profile) => profile.isSuper
      )
    ).toBe(false);

    await ensureOrgSuperAgentProfiles(db);

    const profiles = await db.listProfilesForOrg("org_legacy");
    expect(profiles).toHaveLength(2);
    expect(profiles.some((profile) => profile.isSuper)).toBe(true);
  });
});
