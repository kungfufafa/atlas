import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getProfileSkillsDir, SKILL_CURATOR_INTERVAL_MS } from "@atlas/core";
import { SYNTHETIC_SECRET_FIXTURES } from "@atlas/core/testing/synthetic-secret-fixtures";
import {
  createInMemoryDatabaseAdapter,
  type DatabaseAdapter,
  type StoredSkillProposal,
  seedOrgDefaultProfile,
} from "@atlas/db";
import { SkillCuratorService } from "./skill-curator-service";
import { SkillProposalService } from "./skill-proposal-service";
import { SkillsService } from "./skills-service";

const ORG_ID = "org_curator";
const NOW = new Date("2026-08-26T00:00:00.000Z");

describe("SkillCuratorService", () => {
  let configDir: string;
  let db: DatabaseAdapter;
  let profileId: string;
  let proposals: SkillProposalService;
  let skills: SkillsService;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "atlas-curator-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
    db = createInMemoryDatabaseAdapter();
    await db.upsertOrganization({
      createdAt: "2026-01-01T00:00:00.000Z",
      id: ORG_ID,
      name: "Curator",
      skillsCuratorConsolidation: true,
      slug: "curator",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    profileId = (await seedOrgDefaultProfile(db, ORG_ID)).id;
    skills = new SkillsService(db);
    proposals = new SkillProposalService(db, skills);
  });

  afterEach(async () => {
    delete process.env.ATLAS_CONFIG_DIR;
    await rm(configDir, { force: true, recursive: true });
  });

  async function addSkill(input: {
    createdBy?: "agent" | "human" | "bundled";
    body?: string;
    description: string;
    name: string;
    useCount?: number;
  }): Promise<string> {
    const id = `skill_${input.name}`;
    const directory = path.join(
      getProfileSkillsDir(ORG_ID, profileId),
      input.name
    );
    const content = `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n# ${input.name}\n\n${input.body ?? "Keep this distinct procedure."}\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), content, "utf8");
    await db.upsertSkill({
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: input.createdBy ?? "agent",
      description: input.description,
      disableModelInvocation: false,
      enabled: true,
      hasTool: false,
      id,
      name: input.name,
      orgId: ORG_ID,
      sourcePath: directory,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await db.assignSkillToProfile(profileId, id);
    if (input.useCount) {
      await db.incrementSkillUsage({
        orgId: ORG_ID,
        profileId,
        skillId: id,
        useDelta: input.useCount,
        usedAt: "2026-01-01T00:00:00.000Z",
      });
    }
    return id;
  }

  async function addCluster(): Promise<{ loserId: string; winnerId: string }> {
    const winnerId = await addSkill({
      description: "deploy production release checklist helper",
      name: "deploy-helper",
      useCount: 2,
    });
    const loserId = await addSkill({
      description: "deploy production release checklist assistant",
      name: "deploy-assistant",
      useCount: 1,
    });
    return { loserId, winnerId };
  }

  const generated =
    "---\nname: deploy-helper\ndescription: Consolidated production release checklist.\n---\n\n# Release\n\nPreserve both procedures.\n";

  test("manual run always stages a bounded consolidation proposal", async () => {
    const { loserId, winnerId } = await addCluster();
    const generate = mock(async () => generated);
    const curator = new SkillCuratorService(db, proposals, generate);

    const result = await curator.run(ORG_ID, {
      now: NOW,
      proposedByUserId: "admin_1",
      trigger: "manual",
    });

    expect(result.staged).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    const stored = await db.listSkillProposals(ORG_ID, { status: "pending" });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      action: "consolidate",
      content: generated,
      proposedByUserId: "admin_1",
      skillName: "deploy-helper",
    });
    expect(stored[0]?.consolidation?.winner.id).toBe(winnerId);
    expect(stored[0]?.consolidation?.losers[0]?.id).toBe(loserId);
    expect(await db.listSkillsForProfile(profileId)).toHaveLength(2);
  });

  test("scheduled run persists an idempotent due clock", async () => {
    await addCluster();
    const generate = mock(async () => generated);
    const curator = new SkillCuratorService(db, proposals, generate);

    const first = await curator.runDue(ORG_ID, { now: NOW });
    expect(first?.status).toBe("completed");
    expect(first?.trigger).toBe("scheduled");
    expect(generate).toHaveBeenCalledTimes(1);

    const organization = await db.getOrganizationById(ORG_ID);
    expect(organization?.skillsCuratorLastRunAt).toBe(first?.finishedAt);
    await expect(curator.runDue(ORG_ID, { now: NOW })).resolves.toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);

    const nextDue = new Date(
      Date.parse(first!.finishedAt) + SKILL_CURATOR_INTERVAL_MS
    );
    const second = await curator.runDue(ORG_ID, { now: nextDue });
    expect(second?.status).toBe("completed");
  });

  test("concurrent due checks collapse behind the in-flight guard", async () => {
    await addCluster();
    let releaseGeneration!: () => void;
    let signalGeneration!: () => void;
    const generationEntered = new Promise<void>((resolve) => {
      signalGeneration = resolve;
    });
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const curator = new SkillCuratorService(db, proposals, async () => {
      signalGeneration();
      await generationGate;
      return generated;
    });

    const first = curator.runDue(ORG_ID, { now: NOW });
    await generationEntered;
    await expect(curator.runDue(ORG_ID, { now: NOW })).resolves.toBeNull();
    releaseGeneration();
    expect((await first)?.status).toBe("completed");
  });

  test("scheduled run skips disabled workspaces and rejects archived ones", async () => {
    const curator = new SkillCuratorService(
      db,
      proposals,
      async () => generated
    );
    const organization = await db.getOrganizationById(ORG_ID);
    await db.upsertOrganization({
      ...organization!,
      skillsCuratorConsolidation: false,
    });
    await expect(curator.runDue(ORG_ID, { now: NOW })).resolves.toBeNull();

    await db.upsertOrganization({
      ...organization!,
      archivedAt: NOW.toISOString(),
      skillsCuratorConsolidation: true,
    });
    await expect(curator.runDue(ORG_ID, { now: NOW })).rejects.toMatchObject({
      status: 404,
    });
  });

  test("scheduled failure leaves the due clock retryable", async () => {
    const original = db.listProfilesForOrg.bind(db);
    db.listProfilesForOrg = async () => {
      throw new Error("database unavailable");
    };
    const curator = new SkillCuratorService(
      db,
      proposals,
      async () => generated
    );

    await expect(curator.runDue(ORG_ID, { now: NOW })).rejects.toThrow(
      "database unavailable"
    );
    expect((await db.getOrganizationById(ORG_ID))?.skillsCuratorLastRunAt).toBe(
      undefined
    );
    db.listProfilesForOrg = original;
  });

  test("redacts candidate and generated secrets before LLM or proposal persistence", async () => {
    const sourceSecret = SYNTHETIC_SECRET_FIXTURES.openAiApiKey;
    const generatedBearer = SYNTHETIC_SECRET_FIXTURES.bearerToken;
    await addSkill({
      body: `Use api_key=${sourceSecret}`,
      description: "deploy production release checklist helper",
      name: "deploy-helper",
      useCount: 2,
    });
    await addSkill({
      description: "deploy production release checklist assistant",
      name: "deploy-assistant",
      useCount: 1,
    });
    const generate = mock(async (input) => {
      expect(JSON.stringify(input)).not.toContain(sourceSecret);
      return `${generated}\n${generatedBearer}\n${SYNTHETIC_SECRET_FIXTURES.privateKey}\n`;
    });
    const curator = new SkillCuratorService(db, proposals, generate);

    await curator.run(ORG_ID, { now: NOW, trigger: "manual" });
    const proposal = (await db.listSkillProposals(ORG_ID))[0];
    expect(proposal?.content).toContain("[REDACTED]");
    expect(proposal?.content).not.toContain(sourceSecret);
    expect(proposal?.content).not.toContain(generatedBearer);
    expect(proposal?.content).not.toContain("BEGIN PRIVATE KEY");
  });

  test("pending proposal and active automation exclude candidates", async () => {
    await addCluster();
    const now = NOW.toISOString();
    const pending: StoredSkillProposal = {
      action: "edit",
      content: generated,
      createdAt: now,
      id: "skprop_pending",
      orgId: ORG_ID,
      patchNewString: null,
      patchOldString: null,
      profileId,
      proposedByUserId: null,
      relativePath: null,
      reviewedAt: null,
      reviewerUserId: null,
      sessionId: null,
      skillName: "deploy-helper",
      status: "pending",
    };
    await db.createSkillProposal(pending);
    const generate = mock(async () => generated);
    const curator = new SkillCuratorService(db, proposals, generate);
    expect(
      (
        await curator.run(ORG_ID, {
          now: NOW,
          trigger: "manual",
        })
      ).staged
    ).toBe(0);

    await db.upsertAutomation({
      createdAt: now,
      definition: {},
      enabled: true,
      id: "automation_1",
      name: "Release",
      orgId: ORG_ID,
      profileId,
      updatedAt: now,
      version: 1,
    });
    const activeResult = await curator.run(ORG_ID, {
      now: NOW,
      trigger: "manual",
    });
    expect(activeResult.skippedAutomationOrTask).toBe(1);
    expect(generate).not.toHaveBeenCalled();
  });

  test("approval updates the winner and archives and unassigns losers", async () => {
    const { loserId } = await addCluster();
    const curator = new SkillCuratorService(
      db,
      proposals,
      async () => generated
    );
    await curator.run(ORG_ID, { now: NOW, trigger: "manual" });
    const proposal = (await db.listSkillProposals(ORG_ID))[0];
    expect(proposal).toBeTruthy();

    const approved = await proposals.approveProposal(
      ORG_ID,
      proposal!.id,
      "admin_1"
    );

    expect(approved.status).toBe("approved");
    expect(
      await readFile(
        path.join(
          getProfileSkillsDir(ORG_ID, profileId),
          "deploy-helper",
          "SKILL.md"
        ),
        "utf8"
      )
    ).toBe(generated);
    const assigned = await db.listSkillsForProfile(profileId);
    expect(assigned.map((skill) => skill.name)).toEqual(["deploy-helper"]);
    const loser = await db.getSkill(loserId);
    expect(loser?.enabled).toBe(false);
    expect(loser?.sourcePath).toContain(".atlas-archive/consolidated/");
  });

  test("stale hash and replay fail closed", async () => {
    await addCluster();
    const curator = new SkillCuratorService(
      db,
      proposals,
      async () => generated
    );
    await curator.run(ORG_ID, { now: NOW, trigger: "manual" });
    const proposal = (await db.listSkillProposals(ORG_ID))[0]!;
    const winnerFile = path.join(
      getProfileSkillsDir(ORG_ID, profileId),
      "deploy-helper",
      "SKILL.md"
    );
    await writeFile(winnerFile, `${await readFile(winnerFile, "utf8")}changed`);
    await expect(
      proposals.approveProposal(ORG_ID, proposal.id, "admin_1")
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.listSkillsForProfile(profileId)).toHaveLength(2);

    await writeFile(
      winnerFile,
      "---\nname: deploy-helper\ndescription: deploy production release checklist helper\n---\n\n# deploy-helper\n\nKeep this distinct procedure.\n"
    );
    await proposals.approveProposal(ORG_ID, proposal.id, "admin_1");
    await expect(
      proposals.approveProposal(ORG_ID, proposal.id, "admin_1")
    ).rejects.toMatchObject({ status: 400 });
  });

  test("profile edit and consolidation approval serialize on one mutation lock", async () => {
    await addCluster();
    const curator = new SkillCuratorService(
      db,
      proposals,
      async () => generated
    );
    await curator.run(ORG_ID, { now: NOW, trigger: "manual" });
    const proposal = (await db.listSkillProposals(ORG_ID))[0]!;
    const originalGetSkillByName = db.getSkillByName.bind(db);
    let releaseEdit!: () => void;
    let signalEditEntered!: () => void;
    const editEntered = new Promise<void>((resolve) => {
      signalEditEntered = resolve;
    });
    const editGate = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    db.getSkillByName = async (name, orgId) => {
      if (name === "deploy-helper" && orgId === ORG_ID) {
        signalEditEntered();
        await editGate;
      }
      return originalGetSkillByName(name, orgId);
    };

    const edited =
      "---\nname: deploy-helper\ndescription: deploy production release checklist helper\n---\n\n# Edited while approval waited\n";
    try {
      const edit = skills.editAssignedProfileSkill(
        ORG_ID,
        profileId,
        "deploy-helper",
        edited
      );
      await editEntered;

      let approvalSettled = false;
      const approval = proposals
        .approveProposal(ORG_ID, proposal.id, "admin_1")
        .then(
          (value) => ({ error: null, value }),
          (error: unknown) => ({ error, value: null })
        )
        .finally(() => {
          approvalSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(approvalSettled).toBe(false);

      releaseEdit();
      await edit;
      const outcome = await approval;
      expect(outcome.value).toBeNull();
      expect(outcome.error).toMatchObject({ status: 409 });
      expect(
        await readFile(
          path.join(
            getProfileSkillsDir(ORG_ID, profileId),
            "deploy-helper",
            "SKILL.md"
          ),
          "utf8"
        )
      ).toBe(edited);
      expect(await db.listSkillsForProfile(profileId)).toHaveLength(2);
    } finally {
      releaseEdit();
      db.getSkillByName = originalGetSkillByName;
    }
  });

  test("cross-org references and an archive race fail closed", async () => {
    await addCluster();
    const otherOrgId = "org_other";
    await db.upsertOrganization({
      createdAt: NOW.toISOString(),
      id: otherOrgId,
      name: "Other",
      slug: "other",
      updatedAt: NOW.toISOString(),
    });
    const otherProfile = await seedOrgDefaultProfile(db, otherOrgId);
    const otherDirectory = path.join(
      getProfileSkillsDir(otherOrgId, otherProfile.id),
      "deploy-copy"
    );
    const otherContent =
      "---\nname: deploy-copy\ndescription: deploy production release checklist copy\n---\n\nOther org.\n";
    await mkdir(otherDirectory, { recursive: true });
    await writeFile(path.join(otherDirectory, "SKILL.md"), otherContent);
    await db.upsertSkill({
      createdAt: NOW.toISOString(),
      createdBy: "agent",
      description: "deploy production release checklist copy",
      disableModelInvocation: false,
      enabled: true,
      hasTool: false,
      id: "skill_other",
      name: "deploy-copy",
      orgId: otherOrgId,
      sourcePath: otherDirectory,
      updatedAt: NOW.toISOString(),
    });
    await db.assignSkillToProfile(otherProfile.id, "skill_other");
    const winnerFile = path.join(
      getProfileSkillsDir(ORG_ID, profileId),
      "deploy-helper",
      "SKILL.md"
    );
    const winnerRaw = await readFile(winnerFile, "utf8");
    await expect(
      proposals.stageProposal({
        action: "consolidate",
        consolidation: {
          losers: [
            {
              id: "skill_other",
              name: "deploy-copy",
              sha256: createHash("sha256").update(otherContent).digest("hex"),
            },
          ],
          winner: {
            id: "skill_deploy-helper",
            name: "deploy-helper",
            sha256: createHash("sha256").update(winnerRaw).digest("hex"),
          },
        },
        content: generated,
        orgId: ORG_ID,
        profileId,
        skillName: "deploy-helper",
      })
    ).rejects.toMatchObject({ status: 409 });

    const curator = new SkillCuratorService(
      db,
      proposals,
      async () => generated
    );
    await curator.run(ORG_ID, { now: NOW, trigger: "manual" });
    const proposal = (await db.listSkillProposals(ORG_ID))[0]!;
    const organization = await db.getOrganizationById(ORG_ID);
    await db.upsertOrganization({
      ...organization!,
      archivedAt: NOW.toISOString(),
    });
    await expect(
      proposals.approveProposal(ORG_ID, proposal.id, "admin_1")
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(winnerFile, "utf8")).toBe(winnerRaw);
    expect(await db.listSkillsForProfile(profileId)).toHaveLength(2);
  });

  test("restores every live file when the DB transaction refuses publication", async () => {
    await addCluster();
    const curator = new SkillCuratorService(
      db,
      proposals,
      async () => generated
    );
    await curator.run(ORG_ID, { now: NOW, trigger: "manual" });
    const proposal = (await db.listSkillProposals(ORG_ID))[0]!;
    const winnerFile = path.join(
      getProfileSkillsDir(ORG_ID, profileId),
      "deploy-helper",
      "SKILL.md"
    );
    const loserFile = path.join(
      getProfileSkillsDir(ORG_ID, profileId),
      "deploy-assistant",
      "SKILL.md"
    );
    const before = await readFile(winnerFile, "utf8");
    db.applySkillConsolidation = async () => false;

    await expect(
      proposals.approveProposal(ORG_ID, proposal.id, "admin_1")
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(winnerFile, "utf8")).toBe(before);
    expect(await readFile(loserFile, "utf8")).toContain("deploy-assistant");
    expect((await db.getSkillProposal(ORG_ID, proposal.id))?.status).toBe(
      "pending"
    );
  });
});
