import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  AtlasApiError,
  applyRedactionBoundary,
  detectOrgMemoryInjectionWarnings,
  discoverSkillDirectory,
  getProfileSkillsDir,
  isGlobalSkillSourcePath,
  isPathWithinProfileSkillsDir,
  parseRawProfileSkillContent,
  resolveProfileSkillSupportingFilePath,
  resolveSkillWriteApprovalRequired,
} from "@atlas/core";
import type { SkillProposal } from "@atlas/core/contract";
import {
  assertNotBundledSkillName,
  assertValidSkillName,
} from "@atlas/core/skills/write";
import type {
  DatabaseAdapter,
  SkillProposalAction,
  StoredSkillConsolidationPayload,
  StoredSkillProposal,
  StoredSkillRecord,
} from "@atlas/db";
import { withProfileSkillMutationLock } from "./skill-mutation-lock";
import type { SkillsService } from "./skills-service";

export function toSkillProposal(
  record: StoredSkillProposal & { warnings?: string[] }
): SkillProposal {
  const { warnings, ...proposal } = record;
  return warnings?.length ? { ...proposal, warnings } : proposal;
}

export const MAX_SKILL_PATCH_FIELD_LENGTH = 500;
export const MAX_SKILL_PROPOSAL_CONTENT_BYTES = 64 * 1024;

export type StageSkillProposalOutcome = "created" | "already_pending";

export interface StageSkillProposalInput {
  action: SkillProposalAction;
  consolidation?: StoredSkillConsolidationPayload;
  content?: string;
  newString?: string;
  oldString?: string;
  orgId: string;
  profileId: string;
  proposedByUserId?: string | null;
  relativePath?: string;
  sessionId?: string | null;
  skillName?: string;
}

export interface StageSkillProposalResult {
  message: string;
  outcome: StageSkillProposalOutcome;
  proposalId?: string;
  /** Present for supporting-file proposals (including already_pending echoes). */
  relativePath?: string;
  warnings?: string[];
}

interface SkillFileSnapshot {
  content: string;
  directoryDevice: number;
  directoryInode: number;
  fileDevice: number;
  fileInode: number;
  modifiedAtMs: number;
  sha256: string;
  size: number;
}

interface ValidatedConsolidation {
  losers: StoredSkillRecord[];
  snapshots: Map<string, SkillFileSnapshot>;
  winner: StoredSkillRecord;
}

export class SkillProposalService {
  private readonly stageLocks = new Map<string, Promise<unknown>>();
  private readonly reviewLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: DatabaseAdapter | null = null,
    private readonly skillsService: SkillsService | null = null
  ) {}

  private runSerializedStage<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.stageLocks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.stageLocks.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  private runSerializedReview<T>(
    key: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.reviewLocks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.reviewLocks.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  async isWriteApprovalRequired(
    orgId: string,
    profileId: string
  ): Promise<boolean> {
    const db = this.requireDatabase();
    const org = await db.getOrganizationById(orgId);
    if (!org) {
      throw new AtlasApiError("Organization not found.", 404);
    }
    const profile = await db.getProfileForOrg(profileId, orgId);
    if (!profile) {
      throw new AtlasApiError("Profile not found.", 404);
    }
    return resolveSkillWriteApprovalRequired({
      orgSkillsWriteApproval: org.skillsWriteApproval ?? false,
      profileSkillsWriteApproval: profile.skillsWriteApproval ?? null,
    });
  }

  async stageProposal(
    input: StageSkillProposalInput
  ): Promise<StageSkillProposalResult> {
    const db = this.requireDatabase();
    const profile = await db.getProfileForOrg(input.profileId, input.orgId);
    if (!profile) {
      throw new AtlasApiError("Profile not found.", 404);
    }

    if (input.action === "create") {
      return this.stageCreate(input);
    }
    if (input.action === "patch") {
      return this.stagePatch(input);
    }
    if (input.action === "edit") {
      return this.stageEdit(input);
    }
    if (input.action === "write_file") {
      return this.stageWriteFile(input);
    }
    if (input.action === "remove_file") {
      return this.stageRemoveFile(input);
    }
    if (input.action === "consolidate") {
      return this.stageConsolidation(input);
    }
    return this.stageDelete(input);
  }

  async listProposals(
    orgId: string,
    options: {
      status?: StoredSkillProposal["status"];
      profileId?: string;
      sessionId?: string;
    } = {}
  ): Promise<{ proposals: StoredSkillProposal[]; pendingCount: number }> {
    const db = this.requireDatabase();
    const proposals = await db.listSkillProposals(orgId, options);
    const pendingCount = options.sessionId
      ? proposals.filter((proposal) => proposal.status === "pending").length
      : await db.countPendingSkillProposals(orgId, options.profileId);
    return {
      pendingCount,
      proposals: proposals.map((proposal) => this.withWarnings(proposal)),
    };
  }

  async approveProposal(
    orgId: string,
    proposalId: string,
    reviewerUserId: string
  ): Promise<StoredSkillProposal> {
    return this.runSerializedReview(`${orgId}:${proposalId}`, () =>
      this.approveProposalLocked(orgId, proposalId, reviewerUserId)
    );
  }

  private async approveProposalLocked(
    orgId: string,
    proposalId: string,
    reviewerUserId: string
  ): Promise<StoredSkillProposal> {
    const db = this.requireDatabase();
    const skills = this.requireSkillsService();
    const proposal = await this.getProposal(orgId, proposalId);

    if (proposal.status === "approved" && proposal.action !== "consolidate") {
      return proposal;
    }
    if (proposal.status !== "pending") {
      throw new AtlasApiError("Only pending proposals can be approved.", 400);
    }

    if (proposal.action === "consolidate") {
      return this.approveConsolidation(proposal, reviewerUserId);
    }

    const changeMeta = {
      actorUserId: reviewerUserId,
      source: "skill_manage" as const,
    };

    if (proposal.action === "create") {
      const storedContent = proposal.content;
      if (!storedContent?.trim()) {
        throw new AtlasApiError("Create proposal is missing content.", 400);
      }
      const content = this.sanitizeSkillText(storedContent);
      this.assertStoredSkillTextSafe(storedContent, content);
      parseRawProfileSkillContent(content, orgId, proposal.profileId);
      await skills.createAndAssignRawSkillToProfile(
        orgId,
        proposal.profileId,
        content,
        { changeMeta }
      );
    } else if (proposal.action === "patch") {
      const storedOldString = proposal.patchOldString;
      const storedNewString = proposal.patchNewString;
      if (
        storedOldString === null ||
        storedOldString === "" ||
        storedNewString === null
      ) {
        throw new AtlasApiError("Patch proposal is missing patch fields.", 400);
      }
      const oldString = this.sanitizeSkillText(storedOldString);
      if (oldString !== storedOldString) {
        throw new AtlasApiError(
          "Patch proposal contains sensitive match content.",
          409
        );
      }
      const newString = this.sanitizeSkillText(storedNewString);
      this.assertStoredSkillTextSafe(storedNewString, newString);
      await skills.patchAssignedProfileSkill(
        orgId,
        proposal.profileId,
        proposal.skillName,
        oldString,
        newString,
        changeMeta
      );
    } else if (proposal.action === "edit") {
      const storedContent = proposal.content;
      if (!storedContent?.trim()) {
        throw new AtlasApiError("Edit proposal is missing content.", 400);
      }
      const content = this.sanitizeSkillText(storedContent);
      this.assertStoredSkillTextSafe(storedContent, content);
      await skills.editAssignedProfileSkill(
        orgId,
        proposal.profileId,
        proposal.skillName,
        content,
        changeMeta
      );
    } else if (proposal.action === "write_file") {
      const storedContent = proposal.content;
      const relativePath = proposal.relativePath;
      if (storedContent === null || !relativePath?.trim()) {
        throw new AtlasApiError(
          "Write-file proposal is missing path or content.",
          400
        );
      }
      const content = this.sanitizeSkillText(storedContent);
      this.assertStoredSkillTextSafe(storedContent, content);
      await skills.writeAssignedProfileSkillSupportingFile(
        orgId,
        proposal.profileId,
        proposal.skillName,
        relativePath,
        content,
        changeMeta
      );
    } else if (proposal.action === "remove_file") {
      const relativePath = proposal.relativePath;
      if (!relativePath?.trim()) {
        throw new AtlasApiError("Remove-file proposal is missing path.", 400);
      }
      await skills.removeAssignedProfileSkillSupportingFile(
        orgId,
        proposal.profileId,
        proposal.skillName,
        relativePath,
        changeMeta
      );
    } else {
      await skills.deleteAssignedProfileSkill(
        orgId,
        proposal.profileId,
        proposal.skillName,
        changeMeta
      );
    }

    const reviewedAt = new Date().toISOString();
    await db.updateSkillProposalStatus(orgId, proposalId, {
      reviewedAt,
      reviewerUserId,
      status: "approved",
    });

    return {
      ...proposal,
      reviewedAt,
      reviewerUserId,
      status: "approved",
    };
  }

  async rejectProposal(
    orgId: string,
    proposalId: string,
    reviewerUserId: string
  ): Promise<StoredSkillProposal> {
    const db = this.requireDatabase();
    const proposal = await this.getProposal(orgId, proposalId);

    if (proposal.status === "rejected") {
      return proposal;
    }
    if (proposal.status !== "pending") {
      throw new AtlasApiError("Only pending proposals can be rejected.", 400);
    }

    const reviewedAt = new Date().toISOString();
    await db.updateSkillProposalStatus(orgId, proposalId, {
      reviewedAt,
      reviewerUserId,
      status: "rejected",
    });

    return {
      ...proposal,
      reviewedAt,
      reviewerUserId,
      status: "rejected",
    };
  }

  async countPending(orgId: string, profileId?: string): Promise<number> {
    return this.requireDatabase().countPendingSkillProposals(orgId, profileId);
  }

  private async stageCreate(
    input: StageSkillProposalInput
  ): Promise<StageSkillProposalResult> {
    const rawContent = input.content;
    if (!rawContent?.trim()) {
      throw new AtlasApiError("content is required for create.", 400);
    }
    const content = this.sanitizeSkillText(rawContent);
    this.assertContentSize(content);

    const { name } = parseRawProfileSkillContent(
      content,
      input.orgId,
      input.profileId
    );
    assertNotBundledSkillName(name);

    const db = this.requireDatabase();
    const existingByName = await db.getSkillByName(name, input.orgId);
    if (
      existingByName &&
      !isPathWithinProfileSkillsDir(
        input.orgId,
        input.profileId,
        existingByName.sourcePath
      )
    ) {
      throw new AtlasApiError(
        `Skill "${name}" already exists globally or in another profile and cannot be created here.`,
        400
      );
    }

    const lockKey = `${input.orgId}:${input.profileId}:${name}:create`;
    return this.runSerializedStage(lockKey, async () => {
      const pending = await db.getPendingSkillProposalForSkill(
        input.orgId,
        input.profileId,
        name
      );
      if (pending) {
        return {
          message: `A pending proposal already exists for skill "${name}".`,
          outcome: "already_pending",
          proposalId: pending.id,
          warnings: this.warningsForContent(content),
        };
      }

      const proposal = await this.insertProposal({
        ...input,
        action: "create",
        content,
        patchNewString: null,
        patchOldString: null,
        relativePath: null,
        skillName: name,
      });

      return {
        message: `Staged create for skill "${name}" (proposal ${proposal.id}). A Workspace Admin must approve before it goes live.`,
        outcome: "created",
        proposalId: proposal.id,
        warnings: this.warningsForContent(content),
      };
    });
  }

  private async stagePatch(
    input: StageSkillProposalInput
  ): Promise<StageSkillProposalResult> {
    const name = this.readSkillName(input);
    assertNotBundledSkillName(name);
    await this.assertProfileOwnedSkill(input.orgId, input.profileId, name);

    const rawOldString = input.oldString;
    const rawNewString = input.newString;
    if (rawOldString === undefined || rawOldString === "") {
      throw new AtlasApiError("old_string is required for patch.", 400);
    }
    if (rawNewString === undefined) {
      throw new AtlasApiError("new_string is required for patch.", 400);
    }
    const oldString = this.sanitizeSkillText(rawOldString);
    if (oldString !== rawOldString) {
      throw new AtlasApiError(
        "old_string contains sensitive data and cannot be stored in a proposal.",
        400
      );
    }
    const newString = this.sanitizeSkillText(rawNewString);
    this.assertPatchFieldSize(oldString);
    this.assertPatchFieldSize(newString);

    const db = this.requireDatabase();
    const pending = await db.getPendingSkillProposalForPatch(
      input.orgId,
      input.profileId,
      name,
      oldString,
      newString
    );
    if (pending) {
      return {
        message: `An identical patch proposal for "${name}" is already pending.`,
        outcome: "already_pending",
        proposalId: pending.id,
      };
    }

    const conflicting = await db.getPendingSkillProposalForSkill(
      input.orgId,
      input.profileId,
      name
    );
    if (conflicting) {
      return {
        message: `A pending proposal already exists for skill "${name}".`,
        outcome: "already_pending",
        proposalId: conflicting.id,
      };
    }

    const proposal = await this.insertProposal({
      ...input,
      action: "patch",
      content: null,
      patchNewString: newString,
      patchOldString: oldString,
      relativePath: null,
      skillName: name,
    });

    return {
      message: `Staged patch for skill "${name}" (proposal ${proposal.id}). A Workspace Admin must approve before it goes live.`,
      outcome: "created",
      proposalId: proposal.id,
      warnings: this.warningsForPatch(oldString, newString),
    };
  }

  private async stageDelete(
    input: StageSkillProposalInput
  ): Promise<StageSkillProposalResult> {
    const name = this.readSkillName(input);
    assertNotBundledSkillName(name);
    await this.assertProfileOwnedSkill(input.orgId, input.profileId, name);

    const db = this.requireDatabase();
    const pending = await db.getPendingSkillProposalForSkill(
      input.orgId,
      input.profileId,
      name
    );
    if (pending) {
      return {
        message: `A pending proposal already exists for skill "${name}".`,
        outcome: "already_pending",
        proposalId: pending.id,
      };
    }

    const proposal = await this.insertProposal({
      ...input,
      action: "delete",
      content: null,
      patchNewString: null,
      patchOldString: null,
      relativePath: null,
      skillName: name,
    });

    return {
      message: `Staged delete for skill "${name}" (proposal ${proposal.id}). A Workspace Admin must approve before it is removed.`,
      outcome: "created",
      proposalId: proposal.id,
    };
  }

  private async stageEdit(
    input: StageSkillProposalInput
  ): Promise<StageSkillProposalResult> {
    const name = this.readSkillName(input);
    assertNotBundledSkillName(name);
    await this.assertProfileOwnedSkill(input.orgId, input.profileId, name);

    const rawContent = input.content;
    if (!rawContent?.trim()) {
      throw new AtlasApiError("content is required for edit.", 400);
    }
    const content = this.sanitizeSkillText(rawContent);
    this.assertContentSize(content);

    const { name: parsedName } = parseRawProfileSkillContent(
      content,
      input.orgId,
      input.profileId
    );
    if (parsedName !== name) {
      throw new AtlasApiError(
        `Frontmatter name "${parsedName}" must match skill name "${name}".`,
        400
      );
    }

    const pending = await this.pendingForSkillOrAlready(input, name, content);
    if (pending) {
      return pending;
    }

    const proposal = await this.insertProposal({
      ...input,
      action: "edit",
      content,
      patchNewString: null,
      patchOldString: null,
      relativePath: null,
      skillName: name,
    });

    return {
      message: `Staged edit for skill "${name}" (proposal ${proposal.id}). A Workspace Admin must approve before it goes live.`,
      outcome: "created",
      proposalId: proposal.id,
      warnings: this.warningsForContent(content),
    };
  }

  private async stageWriteFile(
    input: StageSkillProposalInput
  ): Promise<StageSkillProposalResult> {
    const name = this.readSkillName(input);
    assertNotBundledSkillName(name);
    await this.assertProfileOwnedSkill(input.orgId, input.profileId, name);

    const relativePath = input.relativePath?.trim();
    if (!relativePath) {
      throw new AtlasApiError("path is required for write_file.", 400);
    }
    const rawContent = input.content;
    if (rawContent === undefined) {
      throw new AtlasApiError("content is required for write_file.", 400);
    }
    const content = this.sanitizeSkillText(rawContent);
    this.assertContentSize(content);

    // Validate path containment / basename before staging.
    resolveProfileSkillSupportingFilePath(
      input.orgId,
      input.profileId,
      name,
      relativePath
    );

    const pending = await this.pendingForSkillOrAlready(input, name);
    if (pending) {
      return pending;
    }

    const proposal = await this.insertProposal({
      ...input,
      action: "write_file",
      content,
      patchNewString: null,
      patchOldString: null,
      relativePath,
      skillName: name,
    });

    return {
      message: `Staged write_file for skill "${name}" path "${relativePath}" (proposal ${proposal.id}). A Workspace Admin must approve before it goes live.`,
      outcome: "created",
      proposalId: proposal.id,
      relativePath,
      warnings: this.warningsForContent(content),
    };
  }

  private async stageRemoveFile(
    input: StageSkillProposalInput
  ): Promise<StageSkillProposalResult> {
    const name = this.readSkillName(input);
    assertNotBundledSkillName(name);
    await this.assertProfileOwnedSkill(input.orgId, input.profileId, name);

    const relativePath = input.relativePath?.trim();
    if (!relativePath) {
      throw new AtlasApiError("path is required for remove_file.", 400);
    }

    resolveProfileSkillSupportingFilePath(
      input.orgId,
      input.profileId,
      name,
      relativePath
    );

    const pending = await this.pendingForSkillOrAlready(input, name);
    if (pending) {
      return pending;
    }

    const proposal = await this.insertProposal({
      ...input,
      action: "remove_file",
      content: null,
      patchNewString: null,
      patchOldString: null,
      relativePath,
      skillName: name,
    });

    return {
      message: `Staged remove_file for skill "${name}" path "${relativePath}" (proposal ${proposal.id}). A Workspace Admin must approve before it is removed.`,
      outcome: "created",
      proposalId: proposal.id,
      relativePath,
    };
  }

  private async stageConsolidation(
    input: StageSkillProposalInput
  ): Promise<StageSkillProposalResult> {
    const content =
      input.content === undefined
        ? undefined
        : this.sanitizeSkillText(input.content);
    const consolidation = input.consolidation;
    if (!(content?.trim() && consolidation)) {
      throw new AtlasApiError(
        "Consolidation proposal is missing content or references.",
        400
      );
    }
    this.assertContentSize(content);
    const { name } = parseRawProfileSkillContent(
      content,
      input.orgId,
      input.profileId
    );
    if (name !== consolidation.winner.name || name !== input.skillName) {
      throw new AtlasApiError(
        "Consolidation winner must match the SKILL.md frontmatter name.",
        400
      );
    }
    this.assertConsolidationShape(consolidation);
    const lockKey = `${input.orgId}:${input.profileId}:consolidate:${[
      consolidation.winner.id,
      ...consolidation.losers.map((loser) => loser.id),
    ]
      .sort()
      .join(",")}`;

    return this.runSerializedStage(lockKey, async () => {
      await this.loadAndValidateConsolidation(
        input.orgId,
        input.profileId,
        consolidation
      );
      const db = this.requireDatabase();
      for (const reference of [consolidation.winner, ...consolidation.losers]) {
        const pending = await db.getPendingSkillProposalForSkill(
          input.orgId,
          input.profileId,
          reference.name
        );
        if (pending) {
          return {
            message: `A pending proposal already exists for skill "${reference.name}".`,
            outcome: "already_pending" as const,
            proposalId: pending.id,
          };
        }
      }

      const proposal = await this.insertProposal({
        ...input,
        action: "consolidate",
        consolidation,
        content,
        patchNewString: null,
        patchOldString: null,
        relativePath: null,
        skillName: name,
      });
      return {
        message: `Staged consolidation for "${name}" (proposal ${proposal.id}). A Workspace Admin must approve before any live skill changes.`,
        outcome: "created" as const,
        proposalId: proposal.id,
        warnings: this.warningsForContent(content),
      };
    });
  }

  private async approveConsolidation(
    proposal: StoredSkillProposal,
    reviewerUserId: string
  ): Promise<StoredSkillProposal> {
    return withProfileSkillMutationLock(
      proposal.orgId,
      proposal.profileId,
      () => this.approveConsolidationLocked(proposal, reviewerUserId)
    );
  }

  private async approveConsolidationLocked(
    proposal: StoredSkillProposal,
    reviewerUserId: string
  ): Promise<StoredSkillProposal> {
    if (proposal.status !== "pending") {
      throw new AtlasApiError(
        "This consolidation proposal has already been reviewed.",
        409
      );
    }
    const consolidation = proposal.consolidation;
    const storedContent = proposal.content;
    if (!(consolidation && storedContent?.trim())) {
      throw new AtlasApiError("Consolidation proposal is malformed.", 400);
    }
    const content = this.sanitizeSkillText(storedContent);
    this.assertStoredSkillTextSafe(storedContent, content);
    this.assertConsolidationShape(consolidation);
    this.assertContentSize(content);
    const parsed = parseRawProfileSkillContent(
      content,
      proposal.orgId,
      proposal.profileId
    );
    if (parsed.name !== consolidation.winner.name) {
      throw new AtlasApiError("Consolidation winner name changed.", 409);
    }

    const records = await this.loadAndValidateConsolidation(
      proposal.orgId,
      proposal.profileId,
      consolidation
    );
    const winnerFile = path.join(records.winner.sourcePath, "SKILL.md");
    const winnerSnapshot = records.snapshots.get(records.winner.id);
    if (!winnerSnapshot) {
      throw new AtlasApiError("Consolidation winner snapshot is missing.", 409);
    }
    const originalWinner = winnerSnapshot.content;
    const tempWinner = `${winnerFile}.curator-${crypto.randomUUID()}.tmp`;
    const archiveRoot = path.join(
      getProfileSkillsDir(proposal.orgId, proposal.profileId),
      ".atlas-archive",
      "consolidated",
      proposal.id
    );
    const moved: Array<{ archivedPath: string; livePath: string }> = [];
    let winnerReplaced = false;

    try {
      await mkdir(archiveRoot, { mode: 0o700, recursive: true });
      await writeFile(
        tempWinner,
        content.endsWith("\n") ? content : `${content}\n`,
        {
          flag: "wx",
          mode: 0o600,
        }
      );
      await this.assertSkillSnapshotUnchanged(records.winner, winnerSnapshot);
      await rename(tempWinner, winnerFile);
      winnerReplaced = true;

      for (const loser of records.losers) {
        const loserSnapshot = records.snapshots.get(loser.id);
        if (!loserSnapshot) {
          throw new AtlasApiError(
            "Consolidation loser snapshot is missing.",
            409
          );
        }
        await this.assertSkillSnapshotUnchanged(loser, loserSnapshot);
        const archivedPath = path.join(archiveRoot, loser.name);
        try {
          await lstat(archivedPath);
          throw new AtlasApiError(
            "Consolidation archive destination already exists.",
            409
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        await rename(loser.sourcePath, archivedPath);
        moved.push({ archivedPath, livePath: loser.sourcePath });
      }

      const discovered = await discoverSkillDirectory(
        records.winner.sourcePath
      );
      if (!discovered || discovered.name !== records.winner.name) {
        throw new AtlasApiError(
          "Consolidated SKILL.md could not be validated after staging.",
          409
        );
      }
      const reviewedAt = new Date().toISOString();
      const winner: StoredSkillRecord = {
        ...records.winner,
        description: discovered.description,
        disableModelInvocation: discovered.disableModelInvocation,
        hasTool: discovered.hasTool,
        updatedAt: reviewedAt,
      };
      const applied = await this.requireDatabase().applySkillConsolidation({
        archivedLosers: records.losers.map((loser) => ({
          archivedSourcePath: path.join(archiveRoot, loser.name),
          id: loser.id,
          name: loser.name,
        })),
        expectedConsolidation: consolidation,
        orgId: proposal.orgId,
        profileId: proposal.profileId,
        proposalId: proposal.id,
        reviewedAt,
        reviewerUserId,
        winner,
      });
      if (!applied) {
        throw new AtlasApiError(
          "Skills or workspace state changed before approval. Review a fresh proposal.",
          409
        );
      }
      return {
        ...proposal,
        reviewedAt,
        reviewerUserId,
        status: "approved",
      };
    } catch (error) {
      const restored = await this.rollbackConsolidation({
        moved,
        originalWinner,
        tempWinner,
        winnerFile,
        winnerReplaced,
      });
      if (!restored) {
        throw new AtlasApiError(
          "Consolidation failed and filesystem recovery needs operator attention.",
          500
        );
      }
      throw error;
    }
  }

  private async rollbackConsolidation(input: {
    moved: Array<{ archivedPath: string; livePath: string }>;
    originalWinner: string;
    tempWinner: string;
    winnerFile: string;
    winnerReplaced: boolean;
  }): Promise<boolean> {
    try {
      for (const moved of [...input.moved].reverse()) {
        await rename(moved.archivedPath, moved.livePath);
      }
      if (input.winnerReplaced) {
        const restoreTemp = `${input.winnerFile}.restore-${crypto.randomUUID()}`;
        await writeFile(restoreTemp, input.originalWinner, {
          flag: "wx",
          mode: 0o600,
        });
        await rename(restoreTemp, input.winnerFile);
      }
      await rm(input.tempWinner, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private assertConsolidationShape(
    consolidation: StoredSkillConsolidationPayload
  ): void {
    if (consolidation.losers.length < 1 || consolidation.losers.length > 3) {
      throw new AtlasApiError(
        "Consolidation must contain one to three loser skills.",
        400
      );
    }
    const references = [consolidation.winner, ...consolidation.losers];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const reference of references) {
      assertValidSkillName(reference.name);
      assertNotBundledSkillName(reference.name);
      if (!/^[a-f0-9]{64}$/.test(reference.sha256)) {
        throw new AtlasApiError("Consolidation hash is invalid.", 400);
      }
      if (ids.has(reference.id) || names.has(reference.name)) {
        throw new AtlasApiError(
          "Consolidation skill references must be unique.",
          400
        );
      }
      ids.add(reference.id);
      names.add(reference.name);
    }
  }

  private async loadAndValidateConsolidation(
    orgId: string,
    profileId: string,
    consolidation: StoredSkillConsolidationPayload
  ): Promise<ValidatedConsolidation> {
    const db = this.requireDatabase();
    const [organization, profile, assigned] = await Promise.all([
      db.getOrganizationById(orgId),
      db.getProfileForOrg(profileId, orgId),
      db.listSkillsForProfile(profileId),
    ]);
    if (!organization || organization.archivedAt) {
      throw new AtlasApiError("Workspace is inactive.", 409);
    }
    if (!profile) {
      throw new AtlasApiError("Profile not found.", 404);
    }
    const assignedIds = new Set(assigned.map((skill) => skill.id));
    const records: StoredSkillRecord[] = [];
    const snapshots = new Map<string, SkillFileSnapshot>();
    for (const reference of [consolidation.winner, ...consolidation.losers]) {
      const record = await db.getSkill(reference.id);
      if (
        !record ||
        record.orgId !== orgId ||
        record.name !== reference.name ||
        !record.enabled ||
        record.createdBy === "bundled" ||
        !assignedIds.has(record.id) ||
        isGlobalSkillSourcePath(record.sourcePath) ||
        !isPathWithinProfileSkillsDir(orgId, profileId, record.sourcePath)
      ) {
        throw new AtlasApiError(
          "Consolidation skill ownership or assignment changed.",
          409
        );
      }
      snapshots.set(
        record.id,
        await this.readSkillFileSnapshot(record, reference.sha256)
      );
      records.push(record);
    }
    const [winner, ...losers] = records;
    if (!winner) {
      throw new AtlasApiError("Consolidation winner is missing.", 400);
    }
    return { losers, snapshots, winner };
  }

  private async assertSkillSnapshotUnchanged(
    record: StoredSkillRecord,
    expected: SkillFileSnapshot
  ): Promise<void> {
    const current = await this.readSkillFileSnapshot(record, expected.sha256);
    if (
      current.directoryDevice !== expected.directoryDevice ||
      current.directoryInode !== expected.directoryInode ||
      current.fileDevice !== expected.fileDevice ||
      current.fileInode !== expected.fileInode ||
      current.modifiedAtMs !== expected.modifiedAtMs ||
      current.size !== expected.size
    ) {
      throw new AtlasApiError(
        `Skill "${record.name}" changed during consolidation approval.`,
        409
      );
    }
  }

  private async readSkillFileSnapshot(
    record: StoredSkillRecord,
    expectedSha256: string
  ): Promise<SkillFileSnapshot> {
    const skillFile = path.join(record.sourcePath, "SKILL.md");
    const directoryStats = await lstat(record.sourcePath);
    const before = await lstat(skillFile);
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      !before.isFile() ||
      before.isSymbolicLink()
    ) {
      throw new AtlasApiError(
        "Consolidation does not allow symbolic-link skill paths.",
        409
      );
    }
    const body = await readFile(skillFile);
    const after = await lstat(skillFile);
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size ||
      sha256 !== expectedSha256
    ) {
      throw new AtlasApiError(
        `Skill "${record.name}" changed after proposal creation.`,
        409
      );
    }
    return {
      content: body.toString("utf8"),
      directoryDevice: directoryStats.dev,
      directoryInode: directoryStats.ino,
      fileDevice: after.dev,
      fileInode: after.ino,
      modifiedAtMs: after.mtimeMs,
      sha256,
      size: after.size,
    };
  }

  private async pendingForSkillOrAlready(
    input: StageSkillProposalInput,
    name: string,
    contentForWarnings?: string
  ): Promise<StageSkillProposalResult | null> {
    const db = this.requireDatabase();
    const pending = await db.getPendingSkillProposalForSkill(
      input.orgId,
      input.profileId,
      name
    );
    if (!pending) {
      return null;
    }
    return {
      message: `A pending proposal already exists for skill "${name}".`,
      outcome: "already_pending",
      proposalId: pending.id,
      relativePath: pending.relativePath ?? undefined,
      ...(contentForWarnings
        ? { warnings: this.warningsForContent(contentForWarnings) }
        : {}),
    };
  }

  private async insertProposal(
    input: Omit<StageSkillProposalInput, "relativePath" | "content"> & {
      skillName: string;
      content: string | null;
      patchOldString: string | null;
      patchNewString: string | null;
      relativePath: string | null;
    }
  ): Promise<StoredSkillProposal> {
    const db = this.requireDatabase();
    const now = new Date().toISOString();
    const proposal: StoredSkillProposal = {
      action: input.action,
      consolidation: input.consolidation ?? null,
      content: input.content,
      createdAt: now,
      id: `skprop_${crypto.randomUUID().replace(/-/g, "")}`,
      orgId: input.orgId,
      patchNewString: input.patchNewString,
      patchOldString: input.patchOldString,
      profileId: input.profileId,
      proposedByUserId: input.proposedByUserId ?? null,
      relativePath: input.relativePath,
      reviewedAt: null,
      reviewerUserId: null,
      sessionId: input.sessionId ?? null,
      skillName: input.skillName,
      status: "pending",
    };
    await db.createSkillProposal(proposal);
    return proposal;
  }

  private async getProposal(
    orgId: string,
    proposalId: string
  ): Promise<StoredSkillProposal> {
    const db = this.requireDatabase();
    const proposal = await db.getSkillProposal(orgId, proposalId);
    if (!proposal) {
      throw new AtlasApiError("Skill proposal not found.", 404);
    }
    return proposal;
  }

  private async assertProfileOwnedSkill(
    orgId: string,
    profileId: string,
    name: string
  ): Promise<void> {
    const db = this.requireDatabase();
    const skillName = assertValidSkillName(name);
    const record = await db.getSkillByName(skillName, orgId);
    if (!record) {
      throw new AtlasApiError(`Skill "${skillName}" not found.`, 404);
    }
    if (isGlobalSkillSourcePath(record.sourcePath)) {
      throw new AtlasApiError(
        "Global skills cannot be modified by agents.",
        403
      );
    }
    if (!isPathWithinProfileSkillsDir(orgId, profileId, record.sourcePath)) {
      throw new AtlasApiError(
        `Skill "${skillName}" is not owned by this profile.`,
        403
      );
    }
  }

  private readSkillName(input: StageSkillProposalInput): string {
    const name = input.skillName?.trim();
    if (!name) {
      throw new AtlasApiError("name is required.", 400);
    }
    return assertValidSkillName(name);
  }

  private assertContentSize(content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_PROPOSAL_CONTENT_BYTES) {
      throw new AtlasApiError(
        "SKILL.md content exceeds the proposal size limit.",
        400
      );
    }
  }

  private sanitizeSkillText(content: string): string {
    try {
      return applyRedactionBoundary(content, "learning");
    } catch {
      throw new AtlasApiError(
        "Skill content could not pass the sensitive-data boundary.",
        400
      );
    }
  }

  private assertStoredSkillTextSafe(original: string, safe: string): void {
    if (original !== safe) {
      throw new AtlasApiError(
        "Stored proposal contains sensitive data and must be rejected.",
        409
      );
    }
  }

  private assertPatchFieldSize(value: string): void {
    if (Buffer.byteLength(value, "utf8") > MAX_SKILL_PATCH_FIELD_LENGTH) {
      throw new AtlasApiError("Patch field exceeds the size limit.", 400);
    }
  }

  private warningsForContent(content: string): string[] | undefined {
    const warnings = detectOrgMemoryInjectionWarnings(content);
    return warnings.length > 0 ? warnings : undefined;
  }

  private warningsForPatch(
    oldString: string,
    newString: string
  ): string[] | undefined {
    const warnings = [
      ...detectOrgMemoryInjectionWarnings(oldString),
      ...detectOrgMemoryInjectionWarnings(newString),
    ];
    return warnings.length > 0 ? [...new Set(warnings)] : undefined;
  }

  private withWarnings(proposal: StoredSkillProposal): StoredSkillProposal & {
    warnings?: string[];
  } {
    if (
      (proposal.action === "create" ||
        proposal.action === "edit" ||
        proposal.action === "write_file" ||
        proposal.action === "consolidate") &&
      proposal.content
    ) {
      const warnings = this.warningsForContent(proposal.content);
      return warnings ? { ...proposal, warnings } : proposal;
    }
    if (
      proposal.action === "patch" &&
      proposal.patchOldString !== null &&
      proposal.patchNewString !== null
    ) {
      const warnings = this.warningsForPatch(
        proposal.patchOldString,
        proposal.patchNewString
      );
      return warnings ? { ...proposal, warnings } : proposal;
    }
    return proposal;
  }

  private requireDatabase(): DatabaseAdapter {
    if (!this.database) {
      throw new AtlasApiError("Database not configured.", 500);
    }
    return this.database;
  }

  private requireSkillsService(): SkillsService {
    if (!this.skillsService) {
      throw new AtlasApiError("Skills service not configured.", 500);
    }
    return this.skillsService;
  }
}
