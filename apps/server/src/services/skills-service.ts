import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CreateSkillRequest,
  InstallSkillRequest,
  ListSkillsResponse,
  PatchSkillRequest,
  SkillDetail,
  SkillResponse,
  SkillSummary,
  SkillUsageSummary,
  SyncSkillsResponse,
  ToolDefinition,
} from "@atlas/core";
import {
  AtlasApiError,
  assertNotBundledSkillName,
  assertValidSkillName,
  BUNDLED_SKILL_NAMES,
  composeAgentBrowserCapabilityPrompt,
  composeMatchedSkillsPrompt,
  composeSkillMarkdown,
  composeSkillsCatalog,
  createId,
  createSkillFile,
  type DiscoveredSkill,
  dedupeSkillsByName,
  deleteSkillDirectory,
  discoverSkillDirectory,
  discoverSkills,
  extractExplicitSkillName,
  fetchGitHubSkillMarkdown,
  isGlobalSkillSourcePath,
  isPathWithinProfileSkillsDir,
  loadSkillTools,
  matchSkillsForMessage,
  orgIdFromSkillSourcePath,
  parseRawProfileSkillContent,
  parseSkillMarkdown,
  patchSkillFile,
  pickPreferredSkillSourcePath,
  removeProfileSkillSupportingFile,
  resolveProfileSkillSupportingFilePath,
  SKILL_FILE_NAME,
  type SkillOutcomeSignal,
  type SkillRanker,
  writeProfileSkillSupportingFile,
  writeRawProfileSkillMarkdown,
} from "@atlas/core";
import {
  createFts5SkillRanker,
  type DatabaseAdapter,
  type SkillCreatedBy,
  type StoredSkillRecord,
  type StoredSkillUsageRecord,
} from "@atlas/db";
import {
  ProfileChangeHistoryService,
  type ProfileChangeMeta,
} from "./profile-change-history";
import { withProfileSkillMutationLock } from "./skill-mutation-lock";
import {
  type SkillUsageRecordingContext,
  SkillUsageService,
} from "./skill-usage-service";

export type { SkillUsageRecordingContext };

const bundledSkillNames = new Set<string>(BUNDLED_SKILL_NAMES);

function isSkillVisibleToOrg(skill: StoredSkillRecord, orgId: string): boolean {
  return skill.orgId == null || skill.orgId === orgId;
}

function serializeSkillFileChange(
  skillName: string,
  relativePath: string,
  content: string | null
): string {
  return JSON.stringify({ content, path: relativePath, skillName });
}

async function readOptionalFileContent(
  absolutePath: string
): Promise<string | null | undefined> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
  }
}

export class SkillsService {
  private readonly skillRanker: SkillRanker;
  private readonly skillUsageService: SkillUsageService;

  constructor(
    private readonly db: DatabaseAdapter,
    skillUsageService?: SkillUsageService,
    skillRanker?: SkillRanker
  ) {
    this.skillUsageService = skillUsageService ?? new SkillUsageService(db);
    this.skillRanker = skillRanker ?? createFts5SkillRanker();
  }

  async syncDiscoveredSkills(orgId?: string): Promise<SyncSkillsResponse> {
    const discovered = await discoverSkills();
    let created = 0;
    let updated = 0;

    for (const skill of discovered) {
      const result = await this.upsertDiscoveredSkill(skill);
      created += result.created ? 1 : 0;
      updated += result.created ? 0 : 1;
    }

    await this.consolidateDuplicateSkills(orgId);

    return {
      created,
      discovered: discovered.length,
      updated,
    };
  }

  async syncProfileSkills(orgId: string, profileId: string): Promise<void> {
    const discovered = await discoverSkills({ orgId, profileId });

    for (const skill of discovered) {
      if (isGlobalSkillSourcePath(skill.directory)) {
        continue;
      }

      await this.upsertDiscoveredSkill(skill);
    }
  }

  async listSkills(orgId?: string): Promise<ListSkillsResponse> {
    await this.syncDiscoveredSkills(orgId);

    const profiles = orgId
      ? await this.db.listProfilesForOrg(orgId)
      : await this.db.listProfiles();

    for (const profile of profiles) {
      if (!profile.orgId) {
        continue;
      }

      await this.syncProfileSkills(profile.orgId, profile.id);
    }

    const allSkills = await this.db.listSkills();
    const skills = orgId
      ? allSkills.filter((skill) => isSkillVisibleToOrg(skill, orgId))
      : allSkills;
    return { skills: skills.map((skill) => toSkillSummary(skill)) };
  }

  async createSkill(
    orgId: string,
    request: CreateSkillRequest,
    options: { allowGlobal?: boolean } = {}
  ): Promise<SkillResponse> {
    const profileId = request.profileId?.trim() || undefined;
    if (profileId) {
      return withProfileSkillMutationLock(orgId, profileId, () =>
        this.createSkillUnlocked(orgId, { ...request, profileId })
      );
    }
    if (!options.allowGlobal) {
      throw new AtlasApiError(
        "Only Superadmins can create shared global skills.",
        403
      );
    }
    return this.createSkillUnlocked(orgId, request);
  }

  private async createSkillUnlocked(
    orgId: string,
    request: CreateSkillRequest
  ): Promise<SkillResponse> {
    const name = request.name.trim();

    if (!name) {
      throw new Error("Skill name is required.");
    }

    if (!request.description.trim()) {
      throw new Error("Skill description is required.");
    }

    const profileId = request.profileId?.trim() || undefined;
    const directory = await createSkillFile({
      body: request.body,
      description: request.description.trim(),
      disableModelInvocation: request.disableModelInvocation,
      name,
      orgId: profileId ? orgId : undefined,
      profileId,
    });

    const discovered = await discoverSkillDirectory(directory);

    if (!discovered) {
      throw new Error("Skill was created but could not be discovered.");
    }

    await this.upsertDiscoveredSkill(discovered);

    const record = await this.db.getSkillBySourcePath(directory);

    if (!record) {
      throw new Error("Skill was created but could not be synced.");
    }

    return this.getSkill(record.id);
  }

  async patchSkill(
    orgId: string,
    skillId: string,
    request: PatchSkillRequest,
    options?: {
      allowGlobalMutation?: boolean;
      changeMeta?: ProfileChangeMeta;
      profileId?: string;
    }
  ): Promise<SkillResponse> {
    const existing = await this.requireSkillForOrg(orgId, skillId);
    if (existing.orgId == null && !options?.allowGlobalMutation) {
      throw new AtlasApiError(
        "Only Superadmins can update shared global skills.",
        403
      );
    }
    const ownerOrgId = existing.orgId ?? orgId;
    const owningProfileId = existing.orgId
      ? await this.resolveOwningProfileId(existing.orgId, existing.sourcePath)
      : null;
    const requestedProfileId = options?.profileId?.trim() || null;
    if (requestedProfileId) {
      const requestedProfile = await this.db.getProfileForOrg(
        requestedProfileId,
        orgId
      );
      if (!requestedProfile) {
        throw new AtlasApiError("Profile not found.", 404);
      }
      if (owningProfileId && requestedProfileId !== owningProfileId) {
        throw new AtlasApiError("Skill not found.", 404);
      }
    }
    const profileId = owningProfileId ?? requestedProfileId;
    if (profileId) {
      return withProfileSkillMutationLock(ownerOrgId, profileId, () =>
        this.patchSkillUnlocked(orgId, skillId, request, {
          ...options,
          owningProfileId,
          profileId,
        })
      );
    }
    return this.patchSkillUnlocked(orgId, skillId, request, options);
  }

  private async patchSkillUnlocked(
    orgId: string,
    skillId: string,
    request: PatchSkillRequest,
    options?: {
      allowGlobalMutation?: boolean;
      changeMeta?: ProfileChangeMeta;
      owningProfileId?: string | null;
      profileId?: string;
    }
  ): Promise<SkillResponse> {
    const hasDescription = request.description !== undefined;
    const hasBody = request.body !== undefined;
    const hasDisableModelInvocation =
      request.disableModelInvocation !== undefined;

    if (!(hasDescription || hasBody || hasDisableModelInvocation)) {
      throw new Error("No skill changes provided.");
    }

    const record = await this.requireSkillForOrg(orgId, skillId);

    if (bundledSkillNames.has(record.name)) {
      throw new Error("Bundled system skills cannot be edited.");
    }

    const skillFilePath = path.join(record.sourcePath, SKILL_FILE_NAME);
    const existing = await readFile(skillFilePath, "utf8");
    const parsed = parseSkillMarkdown(existing, skillFilePath);
    const description =
      request.description === undefined
        ? parsed.frontmatter.description
        : request.description.trim();

    if (!description) {
      throw new Error("Skill description is required.");
    }

    const body = request.body === undefined ? parsed.body : request.body;
    const disableModelInvocation =
      request.disableModelInvocation === undefined
        ? parsed.frontmatter.disableModelInvocation
        : request.disableModelInvocation;

    const content = composeSkillMarkdown({
      body,
      description,
      disableModelInvocation,
      name: parsed.frontmatter.name,
    });

    parseSkillMarkdown(content, skillFilePath);
    await writeFile(skillFilePath, content, "utf8");

    const synced = await this.syncSkillRecordFromDirectory(
      record.sourcePath,
      parsed.frontmatter.name,
      "patched"
    );

    const profileId = options?.profileId?.trim();
    if (profileId) {
      await this.skillUsageService.recordPatch(orgId, profileId, synced.id);
    }

    if (options?.changeMeta && options.owningProfileId) {
      await this.recordSkillFileChange(
        orgId,
        options.owningProfileId,
        record.name,
        SKILL_FILE_NAME,
        existing,
        skillFilePath,
        options.changeMeta
      );
    }

    return this.getSkill(synced.id);
  }

  async createAndAssignSkillToProfile(
    orgId: string,
    profileId: string,
    request: Omit<CreateSkillRequest, "profileId">
  ): Promise<SkillResponse> {
    return withProfileSkillMutationLock(orgId, profileId, async () => {
      const created = await this.createSkillUnlocked(orgId, {
        ...request,
        profileId,
      });

      await this.db.assignSkillToProfile(profileId, created.skill.id);

      return created;
    });
  }

  async installSkillFromGitHub(
    orgId: string,
    request: InstallSkillRequest,
    changeMeta?: ProfileChangeMeta
  ): Promise<SkillResponse> {
    const profileId = request.profileId?.trim() ?? "";
    const url = request.url?.trim() ?? "";

    if (!profileId) {
      throw new AtlasApiError("profileId is required.", 400);
    }

    if (!url) {
      throw new AtlasApiError("url is required.", 400);
    }

    const profile = await this.db.getProfileForOrg(profileId, orgId);
    if (!profile) {
      throw new AtlasApiError("Profile not found.", 404);
    }

    const content = await fetchGitHubSkillMarkdown(url);

    try {
      parseSkillMarkdown(content, url);
    } catch (error) {
      throw new AtlasApiError(
        error instanceof Error
          ? error.message
          : "Skill file is missing or has invalid frontmatter.",
        400
      );
    }

    try {
      const installed = await this.createAndAssignRawSkillToProfile(
        orgId,
        profileId,
        content,
        { changeMeta, createdBy: "human" }
      );
      return { skill: installed.skill };
    } catch (error) {
      if (error instanceof AtlasApiError) {
        throw error;
      }

      const message =
        error instanceof Error ? error.message : "Failed to install skill.";

      if (
        /already exists|already assigned|cannot be attached|bundled/i.test(
          message
        )
      ) {
        throw new AtlasApiError(message, 409);
      }

      throw new AtlasApiError(message, 400);
    }
  }

  /**
   * Single-write create/adopt path for agents: write raw SKILL.md under the profile
   * skills dir, upsert discovered metadata, and assign. Does not call createSkill
   * then createAndAssign (which would double-write).
   */
  async createAndAssignRawSkillToProfile(
    orgId: string,
    profileId: string,
    content: string,
    options?: {
      changeMeta?: ProfileChangeMeta;
      createdBy?: SkillCreatedBy;
    }
  ): Promise<SkillResponse & { created: boolean }> {
    const mutate = () =>
      withProfileSkillMutationLock(orgId, profileId, () =>
        this.createAndAssignRawSkillToProfileUnlocked(
          orgId,
          profileId,
          content,
          options
        )
      );

    if (options?.changeMeta) {
      return new ProfileChangeHistoryService(this.db).withAssignmentChange(
        {
          field: "skills",
          meta: options.changeMeta,
          orgId,
          profileId,
        },
        mutate
      );
    }

    return mutate();
  }

  private async createAndAssignRawSkillToProfileUnlocked(
    orgId: string,
    profileId: string,
    content: string,
    options?: { createdBy?: SkillCreatedBy }
  ): Promise<SkillResponse & { created: boolean }> {
    const { name } = parseRawProfileSkillContent(content, orgId, profileId);
    const createdBy = options?.createdBy ?? "agent";

    const existingByName = await this.db.getSkillByName(name, orgId);
    if (
      existingByName &&
      !isPathWithinProfileSkillsDir(orgId, profileId, existingByName.sourcePath)
    ) {
      throw new Error(
        `Skill "${name}" already exists at a different source path and cannot be attached to this profile.`
      );
    }

    if (
      existingByName &&
      isPathWithinProfileSkillsDir(orgId, profileId, existingByName.sourcePath)
    ) {
      const assigned = await this.db.listSkillsForProfile(profileId);
      if (assigned.some((skill) => skill.id === existingByName.id)) {
        const skillFile = path.join(existingByName.sourcePath, SKILL_FILE_NAME);
        const existingContent = await readFile(skillFile, "utf8");
        const nextContent = content.endsWith("\n") ? content : `${content}\n`;
        const normalizedExisting = existingContent.endsWith("\n")
          ? existingContent
          : `${existingContent}\n`;
        if (normalizedExisting !== nextContent) {
          throw new Error(
            `Skill "${name}" is already assigned to this profile. Use action patch or edit to update it.`
          );
        }
      }
    }

    const written = await writeRawProfileSkillMarkdown({
      allowExisting: true,
      content,
      orgId,
      profileId,
    });

    const record = await this.syncSkillRecordFromDirectory(
      written.directory,
      written.name,
      "written",
      createdBy
    );

    if (!isPathWithinProfileSkillsDir(orgId, profileId, record.sourcePath)) {
      throw new Error(
        `Skill "${written.name}" resolved outside this profile skills directory.`
      );
    }

    await this.db.assignSkillToProfile(profileId, record.id);
    const response = await this.getSkill(record.id);
    return { ...response, created: written.created };
  }

  async editAssignedProfileSkill(
    orgId: string,
    profileId: string,
    name: string,
    content: string,
    changeMeta?: ProfileChangeMeta
  ): Promise<SkillResponse> {
    return withProfileSkillMutationLock(orgId, profileId, () =>
      this.editAssignedProfileSkillUnlocked(
        orgId,
        profileId,
        name,
        content,
        changeMeta
      )
    );
  }

  private async editAssignedProfileSkillUnlocked(
    orgId: string,
    profileId: string,
    name: string,
    content: string,
    changeMeta?: ProfileChangeMeta
  ): Promise<SkillResponse> {
    const skillName = assertValidSkillName(name);
    const { name: parsedName } = parseRawProfileSkillContent(
      content,
      orgId,
      profileId
    );

    if (parsedName !== skillName) {
      throw new Error(
        `Frontmatter name "${parsedName}" must match skill name "${skillName}".`
      );
    }

    const ownedSkill = await this.assertProfileOwnedSkill(
      orgId,
      profileId,
      skillName
    );
    const beforeValue = changeMeta
      ? await readFile(
          path.join(ownedSkill.sourcePath, SKILL_FILE_NAME),
          "utf8"
        )
      : null;

    const written = await writeRawProfileSkillMarkdown({
      allowExisting: true,
      content,
      orgId,
      profileId,
    });

    if (written.created) {
      throw new Error(
        `Skill "${skillName}" was not found on disk; use action create instead of edit.`
      );
    }

    const record = await this.syncSkillRecordFromDirectory(
      written.directory,
      written.name,
      "patched"
    );

    await this.skillUsageService.recordPatch(orgId, profileId, record.id);

    if (changeMeta && beforeValue !== null) {
      await this.recordSkillContentChange(
        orgId,
        profileId,
        record.name,
        record.sourcePath,
        beforeValue,
        changeMeta
      );
    }

    return this.getSkill(record.id);
  }

  async writeAssignedProfileSkillSupportingFile(
    orgId: string,
    profileId: string,
    name: string,
    relativePath: string,
    content: string,
    changeMeta?: ProfileChangeMeta
  ): Promise<{ skillName: string; relativePath: string }> {
    return withProfileSkillMutationLock(orgId, profileId, () =>
      this.writeAssignedProfileSkillSupportingFileUnlocked(
        orgId,
        profileId,
        name,
        relativePath,
        content,
        changeMeta
      )
    );
  }

  private async writeAssignedProfileSkillSupportingFileUnlocked(
    orgId: string,
    profileId: string,
    name: string,
    relativePath: string,
    content: string,
    changeMeta?: ProfileChangeMeta
  ): Promise<{ skillName: string; relativePath: string }> {
    const skillName = assertValidSkillName(name);
    await this.assertProfileOwnedSkill(orgId, profileId, skillName);
    const target = resolveProfileSkillSupportingFilePath(
      orgId,
      profileId,
      skillName,
      relativePath
    );
    const beforeContent = changeMeta
      ? await readOptionalFileContent(target.absolutePath)
      : undefined;

    const written = await writeProfileSkillSupportingFile({
      content,
      name: skillName,
      orgId,
      profileId,
      relativePath,
    });

    if (changeMeta && beforeContent !== undefined) {
      await this.recordSkillFileChange(
        orgId,
        profileId,
        skillName,
        written.relativePath,
        beforeContent,
        written.absolutePath,
        changeMeta
      );
    }

    return { relativePath: written.relativePath, skillName };
  }

  async removeAssignedProfileSkillSupportingFile(
    orgId: string,
    profileId: string,
    name: string,
    relativePath: string,
    changeMeta?: ProfileChangeMeta
  ): Promise<{ skillName: string; relativePath: string }> {
    return withProfileSkillMutationLock(orgId, profileId, () =>
      this.removeAssignedProfileSkillSupportingFileUnlocked(
        orgId,
        profileId,
        name,
        relativePath,
        changeMeta
      )
    );
  }

  private async removeAssignedProfileSkillSupportingFileUnlocked(
    orgId: string,
    profileId: string,
    name: string,
    relativePath: string,
    changeMeta?: ProfileChangeMeta
  ): Promise<{ skillName: string; relativePath: string }> {
    const skillName = assertValidSkillName(name);
    await this.assertProfileOwnedSkill(orgId, profileId, skillName);
    const target = resolveProfileSkillSupportingFilePath(
      orgId,
      profileId,
      skillName,
      relativePath
    );
    const beforeContent = changeMeta
      ? await readOptionalFileContent(target.absolutePath)
      : undefined;

    const removed = await removeProfileSkillSupportingFile({
      name: skillName,
      orgId,
      profileId,
      relativePath,
    });

    if (changeMeta && beforeContent !== undefined) {
      await new ProfileChangeHistoryService(this.db).recordBestEffort({
        actorUserId: changeMeta.actorUserId,
        afterValue: serializeSkillFileChange(
          skillName,
          removed.relativePath,
          null
        ),
        beforeValue: serializeSkillFileChange(
          skillName,
          removed.relativePath,
          beforeContent
        ),
        field: "skills",
        orgId,
        profileId,
        source: changeMeta.source,
      });
    }

    return { relativePath: removed.relativePath, skillName };
  }

  async patchAssignedProfileSkill(
    orgId: string,
    profileId: string,
    name: string,
    oldString: string,
    newString: string,
    changeMeta?: ProfileChangeMeta
  ): Promise<SkillResponse> {
    return withProfileSkillMutationLock(orgId, profileId, () =>
      this.patchAssignedProfileSkillUnlocked(
        orgId,
        profileId,
        name,
        oldString,
        newString,
        changeMeta
      )
    );
  }

  private async patchAssignedProfileSkillUnlocked(
    orgId: string,
    profileId: string,
    name: string,
    oldString: string,
    newString: string,
    changeMeta?: ProfileChangeMeta
  ): Promise<SkillResponse> {
    const ownedSkill = changeMeta
      ? await this.assertProfileOwnedSkill(orgId, profileId, name)
      : null;
    const beforeValue = ownedSkill
      ? await readFile(
          path.join(ownedSkill.sourcePath, SKILL_FILE_NAME),
          "utf8"
        )
      : null;
    const patched = await patchSkillFile({
      name,
      newString,
      oldString,
      orgId,
      profileId,
    });

    const record = await this.syncSkillRecordFromDirectory(
      patched.directory,
      patched.name,
      "patched"
    );

    await this.skillUsageService.recordPatch(orgId, profileId, record.id);

    if (changeMeta && beforeValue !== null) {
      await this.recordSkillContentChange(
        orgId,
        profileId,
        record.name,
        record.sourcePath,
        beforeValue,
        changeMeta
      );
    }

    return this.getSkill(record.id);
  }

  async deleteAssignedProfileSkill(
    orgId: string,
    profileId: string,
    name: string,
    changeMeta?: ProfileChangeMeta
  ): Promise<void> {
    const mutate = () =>
      withProfileSkillMutationLock(orgId, profileId, () =>
        this.deleteAssignedProfileSkillUnlocked(orgId, profileId, name)
      );

    if (changeMeta) {
      return new ProfileChangeHistoryService(this.db).withAssignmentChange(
        { field: "skills", meta: changeMeta, orgId, profileId },
        mutate
      );
    }

    return mutate();
  }

  private async deleteAssignedProfileSkillUnlocked(
    orgId: string,
    profileId: string,
    name: string
  ): Promise<void> {
    const skillName = assertValidSkillName(name);
    assertNotBundledSkillName(skillName);

    const record = await this.db.getSkillByName(skillName, orgId);
    if (!record) {
      throw new Error(`Skill "${skillName}" not found.`);
    }

    if (isGlobalSkillSourcePath(record.sourcePath)) {
      throw new Error("Global skills cannot be deleted by agents.");
    }

    if (!isPathWithinProfileSkillsDir(orgId, profileId, record.sourcePath)) {
      throw new Error(
        `Skill "${skillName}" is not owned by this profile and cannot be deleted.`
      );
    }

    await this.db.unassignSkillFromProfile(profileId, record.id);
    const deleted = await this.db.deleteSkill(record.id);

    if (!deleted) {
      throw new Error("Skill not found.");
    }

    await deleteSkillDirectory(record.sourcePath);
  }

  async deleteSkill(
    orgId: string,
    skillId: string,
    options: { allowGlobalMutation?: boolean } = {}
  ): Promise<void> {
    const record = await this.requireSkillForOrg(orgId, skillId);
    if (record.orgId == null && !options.allowGlobalMutation) {
      throw new AtlasApiError(
        "Only Superadmins can delete shared global skills.",
        403
      );
    }

    if (record.orgId) {
      const profileId = await this.resolveOwningProfileId(
        record.orgId,
        record.sourcePath
      );
      if (profileId) {
        return withProfileSkillMutationLock(record.orgId, profileId, () =>
          this.deleteSkillUnlocked(orgId, skillId, options)
        );
      }
    }

    return this.deleteSkillUnlocked(orgId, skillId, options);
  }

  private async deleteSkillUnlocked(
    orgId: string,
    skillId: string,
    options: { allowGlobalMutation?: boolean }
  ): Promise<void> {
    const record = await this.requireSkillForOrg(orgId, skillId);
    if (record.orgId == null && !options.allowGlobalMutation) {
      throw new AtlasApiError(
        "Only Superadmins can delete shared global skills.",
        403
      );
    }

    if (bundledSkillNames.has(record.name)) {
      throw new Error("Bundled system skills cannot be deleted.");
    }

    if (record.sourcePath) {
      await deleteSkillDirectory(record.sourcePath);
    }

    const deleted = await this.db.deleteSkill(skillId);

    if (!deleted) {
      throw new Error("Skill not found.");
    }
  }

  private async resolveOwningProfileId(
    orgId: string,
    sourcePath: string
  ): Promise<string | null> {
    const profiles = await this.db.listProfilesForOrg(orgId);
    return (
      profiles.find((profile) =>
        isPathWithinProfileSkillsDir(orgId, profile.id, sourcePath)
      )?.id ?? null
    );
  }

  async getSkill(skillId: string): Promise<SkillResponse> {
    const record = await this.requireSkill(skillId);
    const discovered = await discoverSkillDirectory(record.sourcePath);
    const body = discovered?.body ?? (await readSkillBody(record));

    return {
      skill: {
        ...toSkillSummary(record),
        body,
      },
    };
  }

  async getSkillForOrg(orgId: string, skillId: string): Promise<SkillResponse> {
    await this.requireSkillForOrg(orgId, skillId);
    return this.getSkill(skillId);
  }

  async composeCatalogForProfile(
    orgId: string,
    profileId: string,
    usageContext?: SkillUsageRecordingContext
  ): Promise<string> {
    const assigned = await this.getAssignedDiscoveredSkills(orgId, profileId);
    const assignedRecords = await this.db.listSkillsForProfile(profileId);
    const skillIds = assigned
      .map(
        (skill) =>
          assignedRecords.find((record) => record.name === skill.name)?.id
      )
      .filter((skillId): skillId is string => Boolean(skillId));

    void this.skillUsageService.recordCatalogViews(
      orgId,
      profileId,
      skillIds,
      usageContext
    );

    return composeSkillsCatalog(assigned);
  }

  async composeAgentBrowserCapabilityForProfile(
    orgId: string,
    profileId: string
  ): Promise<string> {
    const assigned = await this.getAssignedDiscoveredSkills(orgId, profileId);
    return composeAgentBrowserCapabilityPrompt(assigned);
  }

  async formatMatchedSkillsForPrompt(
    orgId: string,
    profileId: string,
    userMessage: string,
    options: {
      appendContext?: (matched: DiscoveredSkill[]) => string | Promise<string>;
      usageContext?: SkillUsageRecordingContext;
    } = {}
  ): Promise<string> {
    const assigned = await this.getAssignedDiscoveredSkills(orgId, profileId);
    const assignedRecords = await this.db.listSkillsForProfile(profileId);
    const usage = await this.skillUsageService.listForProfile(profileId);
    const outcomes = await this.loadSkillOutcomeSignals(
      orgId,
      assignedRecords,
      usage
    );
    const matched = matchSkillsForMessage(assigned, userMessage, {
      outcomes,
      ranker: this.skillRanker,
    });
    const explicitSkillName = extractExplicitSkillName(userMessage);

    if (matched.length > 0) {
      const matchedSkillIds = matched
        .map(
          (skill) =>
            assignedRecords.find((record) => record.name === skill.name)?.id
        )
        .filter((skillId): skillId is string => Boolean(skillId));

      void this.skillUsageService.recordMatches(
        orgId,
        profileId,
        matchedSkillIds
      );
    }

    const prompt = composeMatchedSkillsPrompt(matched, {
      explicitInvocation: explicitSkillName !== null,
    });
    const extraContext =
      matched.length > 0 ? await options.appendContext?.(matched) : "";

    return [prompt, extraContext?.trim()].filter(Boolean).join("\n\n");
  }

  async listSkillSummariesForProfile(
    orgId: string,
    profileId: string
  ): Promise<SkillSummary[]> {
    const records = await this.db.listSkillsForProfile(profileId);
    const usage = await this.skillUsageService.listForProfile(profileId);
    return toSkillSummaries(records, usage);
  }

  async loadToolsForProfile(
    orgId: string,
    profileId: string
  ): Promise<ToolDefinition[]> {
    const assigned = await this.getAssignedDiscoveredSkills(orgId, profileId);
    return loadSkillTools(assigned.filter((skill) => skill.hasTool));
  }

  async listSkillsForProfile(profileId: string): Promise<SkillSummary[]> {
    const skills = await this.db.listSkillsForProfile(profileId);
    return skills.map((record) => toSkillSummary(record));
  }

  getSkillUsageService(): SkillUsageService {
    return this.skillUsageService;
  }

  private async loadSkillOutcomeSignals(
    orgId: string,
    assignedRecords: Array<{ id: string; name: string }>,
    usage: Array<{ skillId: string; useCount: number }>
  ): Promise<SkillOutcomeSignal[]> {
    const nameById = new Map(
      assignedRecords.map((record) => [record.id, record.name])
    );
    const useCountByName = new Map<string, number>();
    for (const entry of usage) {
      const skillName = nameById.get(entry.skillId);
      if (skillName) {
        useCountByName.set(skillName, entry.useCount);
      }
    }
    const helpfulByName = new Map<string, boolean | null>();
    const commits = await this.db.listLearningCommits(orgId);
    for (const commit of commits) {
      if (!commit.skillId) {
        continue;
      }
      const skillName = nameById.get(commit.skillId);
      if (!skillName) {
        continue;
      }
      const rows = await this.db.listLearningOutcomesForCommit(commit.id);
      for (const row of rows) {
        if (row.helpful === false) {
          helpfulByName.set(skillName, false);
          break;
        }
        if (row.helpful === true && helpfulByName.get(skillName) !== false) {
          helpfulByName.set(skillName, true);
        }
      }
    }
    const names = new Set([...useCountByName.keys(), ...helpfulByName.keys()]);
    return [...names].map((skillName) => ({
      helpful: helpfulByName.get(skillName) ?? null,
      skillName,
      useCount: useCountByName.get(skillName) ?? 0,
    }));
  }

  private async getAssignedDiscoveredSkills(
    orgId: string,
    profileId: string
  ): Promise<DiscoveredSkill[]> {
    const assigned = await this.db.listSkillsForProfile(profileId);
    const discovered = await discoverSkills({ orgId, profileId });
    const bySourcePath = new Map(
      discovered.map((skill) => [skill.directory, skill])
    );
    const byName = new Map(discovered.map((skill) => [skill.name, skill]));

    return assigned
      .map(
        (record) =>
          bySourcePath.get(record.sourcePath) ?? byName.get(record.name) ?? null
      )
      .filter((skill): skill is DiscoveredSkill => skill !== null);
  }

  private async syncSkillRecordFromDirectory(
    directory: string,
    name: string,
    verb: "written" | "patched",
    createdBy?: SkillCreatedBy
  ): Promise<StoredSkillRecord> {
    const discovered = await discoverSkillDirectory(directory);
    if (!discovered) {
      throw new Error(`Skill was ${verb} but could not be discovered.`);
    }

    await this.upsertDiscoveredSkill(discovered, createdBy);

    const record =
      (await this.db.getSkillBySourcePath(directory)) ??
      (await this.db.getSkillByName(name, orgIdFromSkillSourcePath(directory)));

    if (!record) {
      throw new Error(`Skill was ${verb} but could not be synced.`);
    }

    if (createdBy && record.createdBy !== createdBy) {
      const now = new Date().toISOString();
      const updated = { ...record, createdBy, updatedAt: now };
      await this.db.upsertSkill(updated);
      return updated;
    }

    return record;
  }

  private async upsertDiscoveredSkill(
    skill: DiscoveredSkill,
    createdByOverride?: SkillCreatedBy
  ): Promise<{ created: boolean }> {
    const existingByPath = await this.db.getSkillBySourcePath(skill.directory);
    const existing =
      existingByPath ??
      (await this.db.getSkillByName(
        skill.name,
        orgIdFromSkillSourcePath(skill.directory)
      )) ??
      null;
    const now = new Date().toISOString();
    const defaultCreatedBy: SkillCreatedBy = isGlobalSkillSourcePath(
      skill.directory
    )
      ? "bundled"
      : "human";
    const sourcePath = existing
      ? pickPreferredSkillSourcePath(existing.sourcePath, skill.directory)
      : skill.directory;
    const record: StoredSkillRecord = {
      createdAt: existing?.createdAt ?? now,
      createdBy: existing?.createdBy ?? createdByOverride ?? defaultCreatedBy,
      description: skill.description,
      disableModelInvocation: skill.disableModelInvocation,
      enabled: existing?.enabled ?? true,
      hasTool: skill.hasTool,
      id: existing?.id ?? createId("skill"),
      name: skill.name,
      // Ownership always follows the winning path, so org_id cannot drift from it.
      orgId: orgIdFromSkillSourcePath(sourcePath),
      sourcePath,
      updatedAt: now,
    };

    await this.db.upsertSkill(record);

    return { created: existing === null };
  }

  private async requireSkill(skillId: string): Promise<StoredSkillRecord> {
    const skill = await this.db.getSkill(skillId);

    if (!skill) {
      throw new Error("Skill not found.");
    }

    return skill;
  }

  private async requireSkillForOrg(
    orgId: string,
    skillId: string
  ): Promise<StoredSkillRecord> {
    const skill = await this.db.getSkill(skillId);

    if (!(skill && isSkillVisibleToOrg(skill, orgId))) {
      throw new AtlasApiError("Skill not found.", 404);
    }

    return skill;
  }

  private async assertProfileOwnedSkill(
    orgId: string,
    profileId: string,
    name: string
  ): Promise<StoredSkillRecord> {
    assertNotBundledSkillName(name);

    const record = await this.db.getSkillByName(name, orgId);
    if (!record) {
      throw new Error(`Skill "${name}" not found.`);
    }

    if (isGlobalSkillSourcePath(record.sourcePath)) {
      throw new Error("Global skills cannot be modified by agents.");
    }

    if (!isPathWithinProfileSkillsDir(orgId, profileId, record.sourcePath)) {
      throw new Error(`Skill "${name}" is not owned by this profile.`);
    }

    const skillFile = path.join(record.sourcePath, SKILL_FILE_NAME);
    try {
      await readFile(skillFile, "utf8");
    } catch {
      throw new Error(`Skill "${name}" is missing SKILL.md on disk.`);
    }

    return record;
  }

  private async recordSkillContentChange(
    orgId: string,
    profileId: string,
    skillName: string,
    sourcePath: string,
    beforeValue: string,
    changeMeta: ProfileChangeMeta
  ): Promise<void> {
    let afterValue: string;
    try {
      afterValue = await readFile(
        path.join(sourcePath, SKILL_FILE_NAME),
        "utf8"
      );
    } catch {
      return;
    }

    await new ProfileChangeHistoryService(this.db).recordBestEffort({
      actorUserId: changeMeta.actorUserId,
      afterValue: serializeSkillFileChange(
        skillName,
        SKILL_FILE_NAME,
        afterValue
      ),
      beforeValue: serializeSkillFileChange(
        skillName,
        SKILL_FILE_NAME,
        beforeValue
      ),
      field: "skills",
      orgId,
      profileId,
      source: changeMeta.source,
    });
  }

  private async recordSkillFileChange(
    orgId: string,
    profileId: string,
    skillName: string,
    relativePath: string,
    beforeContent: string | null,
    absolutePath: string,
    changeMeta: ProfileChangeMeta
  ): Promise<void> {
    const afterContent = await readOptionalFileContent(absolutePath);
    if (afterContent === undefined) {
      return;
    }

    await new ProfileChangeHistoryService(this.db).recordBestEffort({
      actorUserId: changeMeta.actorUserId,
      afterValue: serializeSkillFileChange(
        skillName,
        relativePath,
        afterContent
      ),
      beforeValue: serializeSkillFileChange(
        skillName,
        relativePath,
        beforeContent
      ),
      field: "skills",
      orgId,
      profileId,
      source: changeMeta.source,
    });
  }

  private async consolidateDuplicateSkills(orgId?: string): Promise<void> {
    const allSkills = await this.db.listSkills();
    const skills = orgId
      ? allSkills.filter((skill) => skill.orgId === orgId)
      : allSkills;
    const grouped = new Map<string, StoredSkillRecord[]>();

    for (const skill of skills) {
      // Same name in two orgs is legitimate. Only collapse copies that share
      // both a name and an owning org (or both are global).
      const key = `${skill.orgId ?? ""}:${skill.name}`;
      const group = grouped.get(key) ?? [];
      group.push(skill);
      grouped.set(key, group);
    }

    const profiles = orgId
      ? await this.db.listProfilesForOrg(orgId)
      : await this.db.listProfiles();

    for (const group of grouped.values()) {
      if (group.length <= 1) {
        continue;
      }

      const canonical = dedupeSkillsByName(group)[0];
      if (!canonical) {
        continue;
      }

      const duplicates = group.filter((skill) => skill.id !== canonical.id);
      const scopeOrgId = canonical.orgId ?? null;
      const scopedProfiles = profiles.filter((profile) =>
        scopeOrgId === null ? true : profile.orgId === scopeOrgId
      );

      for (const profile of scopedProfiles) {
        const assigned = await this.db.listSkillsForProfile(profile.id);

        for (const assignedSkill of assigned) {
          if (
            !duplicates.some((duplicate) => duplicate.id === assignedSkill.id)
          ) {
            continue;
          }

          await this.db.assignSkillToProfile(profile.id, canonical.id);
          await this.db.unassignSkillFromProfile(profile.id, assignedSkill.id);
        }
      }

      for (const duplicate of duplicates) {
        await this.db.deleteSkill(duplicate.id);
      }
    }
  }
}

function toSkillSummary(
  record: StoredSkillRecord,
  usage?: StoredSkillUsageRecord | null
): SkillSummary {
  return {
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    description: record.description,
    disableModelInvocation: record.disableModelInvocation,
    enabled: record.enabled,
    hasTool: record.hasTool,
    id: record.id,
    name: record.name,
    sourcePath: record.sourcePath,
    updatedAt: record.updatedAt,
    usage: usage ? toSkillUsageSummary(usage) : undefined,
  };
}

function toSkillUsageSummary(
  record: StoredSkillUsageRecord | null | undefined
): SkillUsageSummary {
  if (!record) {
    return {
      lastPatchedAt: null,
      lastUsedAt: null,
      lastViewedAt: null,
      patchCount: 0,
      useCount: 0,
      viewCount: 0,
    };
  }

  return {
    lastPatchedAt: record.lastPatchedAt,
    lastUsedAt: record.lastUsedAt,
    lastViewedAt: record.lastViewedAt,
    patchCount: record.patchCount,
    useCount: record.useCount,
    viewCount: record.viewCount,
  };
}

async function readSkillBody(record: StoredSkillRecord): Promise<string> {
  try {
    const content = await readFile(`${record.sourcePath}/SKILL.md`, "utf8");
    const bodyMatch = content.match(
      /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/
    );
    return bodyMatch?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export function toSkillSummaries(
  records: StoredSkillRecord[],
  usageRecords: StoredSkillUsageRecord[] = []
): SkillSummary[] {
  const usageBySkillId = new Map(
    usageRecords.map((usage) => [usage.skillId, usage])
  );
  return records.map((record) => ({
    ...toSkillSummary(record, usageBySkillId.get(record.id) ?? null),
    usage: toSkillUsageSummary(usageBySkillId.get(record.id)),
  }));
}

export function toSkillDetail(
  record: StoredSkillRecord,
  body = ""
): SkillDetail {
  return {
    ...toSkillSummary(record),
    body,
  };
}
