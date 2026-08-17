import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBundledSkillFiles } from "@atlas/core";
import {
  createSqliteDatabase,
  type DatabaseAdapter,
  ensureProfileDefaultBundledSkills,
} from "@atlas/db";
import { SkillProposalService } from "./skill-proposal-service";
import { SkillSuggestionService } from "./skill-suggestion-service";
import { SkillsService } from "./skills-service";

function markdown(name: string, description: string, body: string): string {
  return `---
name: ${name}
description: ${description}
---

${body}
`;
}

const ORG_A_SKILL = markdown(
  "deploy-notes",
  "Deploy notes for org A. Use when deploying.",
  "Org A steps."
);
const ORG_B_SKILL = markdown(
  "deploy-notes",
  "Deploy notes for org B. Use when deploying.",
  "Org B steps."
);

async function seedTenant(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string
): Promise<void> {
  const now = new Date().toISOString();

  await db.upsertOrganization({
    createdAt: now,
    id: orgId,
    name: orgId,
    slug: orgId.replace("_", "-"),
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: profileId,
    isSuper: false,
    model: null,
    name: profileId,
    orgId,
    systemPrompt: "",
    updatedAt: now,
  });
}

describe("skills are scoped per org", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-skill-org-scope-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    delete process.env.ATLAS_CONFIG_DIR;
  });

  async function openDb(): Promise<DatabaseAdapter> {
    const database = await createSqliteDatabase(
      `file:${join(configDir, "atlas.db")}`
    );
    const db = database.adapter;

    await seedTenant(db, "org_a", "profile_a");
    await seedTenant(db, "org_b", "profile_b");

    return db;
  }

  function profileSkillDir(orgId: string, profileId: string, name: string) {
    return join(
      configDir,
      "orgs",
      orgId,
      "profiles",
      profileId,
      "skills",
      name
    );
  }

  test("two orgs can each create a skill with the same name", async () => {
    const db = await openDb();
    const service = new SkillsService(db);

    await service.createAndAssignRawSkillToProfile(
      "org_a",
      "profile_a",
      ORG_A_SKILL
    );
    await service.createAndAssignRawSkillToProfile(
      "org_b",
      "profile_b",
      ORG_B_SKILL
    );

    const orgA = await db.getSkillByName("deploy-notes", "org_a");
    const orgB = await db.getSkillByName("deploy-notes", "org_b");

    expect(orgA?.id).not.toBe(orgB?.id);
    expect(orgA?.description).toContain("org A");
    expect(orgB?.description).toContain("org B");
    expect(orgA?.sourcePath).toContain(join("orgs", "org_a"));
    expect(orgB?.sourcePath).toContain(join("orgs", "org_b"));
  });

  test("org B's disk sync leaves org A's skill record alone", async () => {
    const db = await openDb();
    const service = new SkillsService(db);

    await service.createAndAssignRawSkillToProfile(
      "org_a",
      "profile_a",
      ORG_A_SKILL
    );
    const orgARow = await db.getSkillByName("deploy-notes", "org_a");

    const orgBDir = profileSkillDir("org_b", "profile_b", "deploy-notes");
    await mkdir(orgBDir, { recursive: true });
    await writeFile(join(orgBDir, "SKILL.md"), ORG_B_SKILL);

    await service.syncProfileSkills("org_b", "profile_b");

    expect(
      (await db.listSkills()).filter((row) => row.name === "deploy-notes")
    ).toHaveLength(2);
    expect((await db.getSkill(orgARow?.id ?? ""))?.description).toContain(
      "org A"
    );
    expect((await db.getSkillByName("deploy-notes", "org_b"))?.id).not.toBe(
      orgARow?.id
    );
  });

  test("org B can delete its own skill", async () => {
    const db = await openDb();
    const service = new SkillsService(db);

    await service.createAndAssignRawSkillToProfile(
      "org_a",
      "profile_a",
      ORG_A_SKILL
    );
    await service.createAndAssignRawSkillToProfile(
      "org_b",
      "profile_b",
      ORG_B_SKILL
    );

    await service.deleteAssignedProfileSkill(
      "org_b",
      "profile_b",
      "deploy-notes"
    );

    expect(await db.getSkillByName("deploy-notes", "org_b")).toBeNull();
    expect(await db.getSkillByName("deploy-notes", "org_a")).not.toBeNull();
  });

  test("org B patches its own copy of a shared name", async () => {
    const db = await openDb();
    const service = new SkillsService(db);

    await service.createAndAssignRawSkillToProfile(
      "org_a",
      "profile_a",
      ORG_A_SKILL
    );
    await service.createAndAssignRawSkillToProfile(
      "org_b",
      "profile_b",
      ORG_B_SKILL
    );

    await service.patchAssignedProfileSkill(
      "org_b",
      "profile_b",
      "deploy-notes",
      "Org B steps.",
      "Org B steps, revised."
    );

    const orgA = await service.getSkill(
      (await db.getSkillByName("deploy-notes", "org_a"))?.id ?? ""
    );
    const orgB = await service.getSkill(
      (await db.getSkillByName("deploy-notes", "org_b"))?.id ?? ""
    );

    expect(orgB.skill.body).toContain("Org B steps, revised.");
    expect(orgA.skill.body).toContain("Org A steps.");
  });

  test("a proposal stages against the caller's own org", async () => {
    const db = await openDb();
    const service = new SkillsService(db);
    const proposals = new SkillProposalService(db, service);

    await service.createAndAssignRawSkillToProfile(
      "org_a",
      "profile_a",
      ORG_A_SKILL
    );

    const staged = await proposals.stageProposal({
      action: "create",
      content: ORG_B_SKILL,
      orgId: "org_b",
      profileId: "profile_b",
    });

    expect(staged.outcome).toBe("created");
  });

  test("an applied suggestion patches the caller's own skill", async () => {
    const db = await openDb();
    const service = new SkillsService(db);
    const suggestions = new SkillSuggestionService(db, service);

    await service.createAndAssignRawSkillToProfile(
      "org_a",
      "profile_a",
      ORG_A_SKILL
    );
    await service.createAndAssignRawSkillToProfile(
      "org_b",
      "profile_b",
      ORG_B_SKILL
    );

    const suggestion = await suggestions.createSuggestion({
      orgId: "org_b",
      outcome: {
        action: "patch",
        name: "deploy-notes",
        newString: "Org B steps, suggested.",
        oldString: "Org B steps.",
      },
      profileId: "profile_b",
    });

    const applied = await suggestions.applySuggestion(
      "org_b",
      suggestion.id,
      "user_b"
    );

    expect(applied.outcome).toBe("applied");

    const orgB = await service.getSkill(
      (await db.getSkillByName("deploy-notes", "org_b"))?.id ?? ""
    );
    const orgA = await service.getSkill(
      (await db.getSkillByName("deploy-notes", "org_a"))?.id ?? ""
    );

    expect(orgB.skill.body).toContain("Org B steps, suggested.");
    expect(orgA.skill.body).toContain("Org A steps.");
  });

  test("a new org still gets the bundled skills", async () => {
    const db = await openDb();
    const service = new SkillsService(db);

    await ensureBundledSkillFiles();
    await service.syncDiscoveredSkills();
    await ensureProfileDefaultBundledSkills(db, "profile_b");

    const assigned = await db.listSkillsForProfile("profile_b");

    expect(assigned.length).toBeGreaterThan(0);
    expect(assigned.every((skill) => skill.orgId === null)).toBe(true);
  });

  test("startup sync does not collapse same-named skills across orgs", async () => {
    const db = await openDb();
    const service = new SkillsService(db);

    await service.createAndAssignRawSkillToProfile(
      "org_a",
      "profile_a",
      ORG_A_SKILL
    );
    await service.createAndAssignRawSkillToProfile(
      "org_b",
      "profile_b",
      ORG_B_SKILL
    );

    await service.syncDiscoveredSkills();

    const orgA = await db.getSkillByName("deploy-notes", "org_a");
    const orgB = await db.getSkillByName("deploy-notes", "org_b");

    expect(orgA?.id).not.toBe(orgB?.id);
    expect(orgA?.description).toContain("org A");
    expect(orgB?.description).toContain("org B");
    expect(
      (await db.listSkillsForProfile("profile_a")).some(
        (skill) => skill.id === orgA?.id
      )
    ).toBe(true);
    expect(
      (await db.listSkillsForProfile("profile_b")).some(
        (skill) => skill.id === orgB?.id
      )
    ).toBe(true);
  });

  test("startup sync still collapses duplicate rows inside one org", async () => {
    const db = await openDb();
    const service = new SkillsService(db);
    const now = new Date().toISOString();
    const sourcePath = profileSkillDir("org_a", "profile_a", "deploy-notes");

    await db.upsertSkill({
      createdAt: now,
      createdBy: "human",
      description: "first copy",
      disableModelInvocation: false,
      enabled: true,
      hasTool: false,
      id: "skill_dup_a",
      name: "deploy-notes",
      orgId: "org_a",
      sourcePath,
      updatedAt: now,
    });
    await db.upsertSkill({
      createdAt: now,
      createdBy: "human",
      description: "second copy",
      disableModelInvocation: false,
      enabled: true,
      hasTool: false,
      id: "skill_dup_b",
      name: "deploy-notes",
      orgId: "org_a",
      sourcePath: `${sourcePath}-copy`,
      updatedAt: now,
    });
    await db.assignSkillToProfile("profile_a", "skill_dup_b");

    await service.syncDiscoveredSkills();

    const remaining = (await db.listSkills()).filter(
      (row) => row.name === "deploy-notes" && row.orgId === "org_a"
    );
    expect(remaining).toHaveLength(1);
    expect((await db.listSkillsForProfile("profile_a"))[0]?.id).toBe(
      remaining[0]?.id
    );
  });

  test("global skills stay visible to every org", async () => {
    const db = await openDb();
    const service = new SkillsService(db);

    const globalDir = join(configDir, "agent", "skills", "weather");
    await mkdir(globalDir, { recursive: true });
    await writeFile(
      join(globalDir, "SKILL.md"),
      markdown("weather", "Get weather forecasts. Use for weather.", "Ask.")
    );

    await service.syncDiscoveredSkills();

    const global = await db.getSkillByName("weather");
    expect(global?.orgId).toBeNull();
    expect((await db.getSkillByName("weather", "org_a"))?.id).toBe(
      global?.id ?? ""
    );
    expect((await db.getSkillByName("weather", "org_b"))?.id).toBe(
      global?.id ?? ""
    );
  });
});
