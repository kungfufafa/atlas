import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createInflateRaw } from "node:zlib";
import {
  ATLAS_API_VERSION,
  AtlasApiError,
  createId,
  discoverSkillDirectory,
  getCustomToolsDir,
  getProfileSoulDir,
  initSoulDirectory,
  isGlobalSkillSourcePath,
  type JsonSchema,
  type ProfilePackComposioToolkitAssignment,
  type ProfilePackCustomTool,
  type ProfilePackManifest,
  type ProfilePackMeta,
  type ProfilePackPreviewResponse,
  type ProfilePackSkippedItem,
  parseSkillMarkdown,
  pathExists,
  slugifyProfileName,
  writePrivateBytesFile,
} from "@atlas/core";
import type {
  DatabaseAdapter,
  ProfileImportPublication,
  StoredProfileComposioToolkitRecord,
  StoredProfileRecord,
  StoredSkillRecord,
  StoredToolRecord,
} from "@atlas/db";
import { zipSync } from "fflate";
import { validateDecodedImageAttachments } from "./image-decoder-validation";
import { resolveJavascriptModulePath } from "./javascript-tool-loader";
import { ProfileChangeHistoryService } from "./profile-change-history";

export const PROFILE_PACK_KIND = "atlas-profile-export" as const;
export const PROFILE_PACK_MANIFEST_FILENAME = "atlas-profile-export.json";
const LEGACY_PROFILE_PACK_KIND = "nakama-profile-export";
const LEGACY_PROFILE_PACK_MANIFEST_FILENAME = "nakama-profile-export.json";
const LEGACY_PROFILE_PACK_FORMAT_VERSION = 1;
const PROFILE_PACK_FORMAT_VERSION = 2;
const CUSTOM_TOOLS_ARCHIVE_DIR = "custom-tools";
const IMPORTED_TOOLS_DIR = "profile-packs";
const IMPORT_STAGING_PREFIX = ".profile-pack-stage-";
const PROFILE_ID_ATTEMPTS = 50;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_PATH_LENGTH = 512;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CUSTOM_TOOL_SCHEMA_BYTES = 256 * 1024;
const MAX_CUSTOM_TOOL_SCHEMA_DEPTH = 32;
const MAX_CUSTOM_TOOL_SCHEMA_NODES = 10_000;
const MAX_ENCODED_ARCHIVE_CHARS = Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 + 4;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/g;
const MAX_CONCURRENT_PROFILE_PACK_OPERATIONS = 4;
const activeProfilePackOrganizations = new Set<string>();
let activeProfilePackOperations = 0;

const ROOT_ALLOWED_FILES = new Set([
  "SOUL.md",
  "STYLE.md",
  "INSTRUCTIONS.md",
  "MEMORY.md",
]);
const ALLOWED_ROOT_SUBDIRS = new Set(["examples", "knowledge-base", "skills"]);
const AVATAR_BASENAME_PATTERN = /^avatar\.[a-z0-9]+$/i;
const AVATAR_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const NOT_ALLOWLISTED_REASON =
  "Not part of the profile pack allowlist; secrets and generated data are excluded.";

interface ProfilePackFile {
  absolutePath: string;
  relativePath: string;
}

interface ProfilePackZipEntry {
  data: Buffer;
  name: string;
}

interface ProfilePackZipMetadata {
  compressedSize: number;
  compression: number;
  crc32: number;
  dataOffset: number;
  isDirectory: boolean;
  localHeaderOffset: number;
  name: string;
  originalSize: number;
}

interface CreatedCustomTool {
  id: string;
}

interface ExistingCustomToolExpectation {
  definition: ProfilePackCustomTool;
  source: Buffer;
  toolId: string;
}

interface ProfileImportDatabaseStage {
  adapter: DatabaseAdapter;
  publication: ProfileImportPublication;
}

interface ProfileImportStaging {
  stagedSoulDir: string;
  stagedToolsDir: string;
  toolsParentDir: string;
}

interface ValidCustomToolDefinition {
  definition: ProfilePackCustomTool;
  sourcePath: string;
}

interface PortableComposioAssignment {
  allowedActions: string[] | null | undefined;
  toolkitSlug: string;
}

export interface CreateProfilePackOptions {
  includeCustomTools?: boolean;
  now?: Date;
}

export interface CreateProfilePackResult {
  data: Buffer;
  filename: string;
  manifest: ProfilePackManifest;
}

export interface PreviewProfilePackImportOptions {
  availableModelIds?: ReadonlySet<string>;
  restoreCustomTools?: boolean;
}

export interface ImportProfilePackOptions {
  actorUserId?: string | null;
  availableModelIds?: ReadonlySet<string>;
  confirm: boolean;
  name?: string;
  now?: Date;
  restoreCustomTools?: boolean;
}

export interface ImportProfilePackResult {
  manifest: ProfilePackManifest;
  profileId: string;
  skippedAssignments: ProfilePackSkippedItem[];
}

export function createProfilePackExport(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string,
  options: CreateProfilePackOptions = {}
): Promise<CreateProfilePackResult> {
  return withProfilePackAdmission(orgId, () =>
    performProfilePackExport(db, orgId, profileId, options)
  );
}

async function performProfilePackExport(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string,
  options: CreateProfilePackOptions
): Promise<CreateProfilePackResult> {
  await requireActiveOrganization(db, orgId);
  const profile = await db.getProfileForOrg(profileId, orgId);
  if (!profile) {
    throw new AtlasApiError("Profile not found.", 404);
  }
  if (profile.isSuper) {
    throw new AtlasApiError("Super Agent cannot be exported.", 400);
  }

  const soulDir = getProfileSoulDir(orgId, profileId);
  const { avatar, files, skipped } = await inventoryProfileSoulDir(soulDir);
  const meta = await buildProfilePackMeta(db, orgId, profileId, profile);
  const createdAt = (options.now ?? new Date()).toISOString();
  const entries: Record<string, Uint8Array> = {};
  let totalBytes = 0;

  for (const file of files) {
    const bytes = await readBoundedRegularFile(
      file.absolutePath,
      file.relativePath,
      totalBytes
    );
    totalBytes += bytes.length;
    entries[file.relativePath] = bytes;
  }

  if (options.includeCustomTools === true) {
    const packedTools = await collectPackedCustomTools(
      db,
      orgId,
      profileId,
      totalBytes
    );
    meta.customTools = packedTools.tools;
    skipped.push(...packedTools.skipped);
    for (const [path, bytes] of Object.entries(packedTools.entries)) {
      entries[path] = bytes;
    }
    totalBytes = packedTools.totalBytes;
  }

  if (avatar) {
    const bytes = await readBoundedRegularFile(
      avatar.absolutePath,
      avatar.relativePath,
      totalBytes
    );
    totalBytes += bytes.length;
    entries[avatar.relativePath] = bytes;
  }

  const topLevelPaths = getTopLevelPaths(Object.keys(entries));
  const manifest: ProfilePackManifest = {
    apiVersion: ATLAS_API_VERSION,
    createdAt,
    kind: PROFILE_PACK_KIND,
    meta,
    skipped,
    sourceProfileId: profileId,
    topLevelPaths,
    version: PROFILE_PACK_FORMAT_VERSION,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new AtlasApiError("Profile pack manifest exceeds 1 MB.", 413);
  }
  totalBytes += manifestBytes.length;
  assertTotalSize(totalBytes);
  entries[PROFILE_PACK_MANIFEST_FILENAME] = manifestBytes;
  assertEntryCount(Object.keys(entries).length);

  const data = Buffer.from(zipSync(entries));
  if (data.length > MAX_ARCHIVE_BYTES) {
    throw new AtlasApiError(
      "Profile pack exceeds the 25 MB archive limit.",
      413
    );
  }

  return {
    data,
    filename: `atlas-profile-export-${slugifyProfileName(profile.name)}-${createdAt.replace(/[:.]/g, "-")}.zip`,
    manifest,
  };
}

export function previewProfilePackImport(
  db: DatabaseAdapter,
  orgId: string,
  archive: Buffer | Uint8Array | ArrayBuffer,
  options: PreviewProfilePackImportOptions = {}
): Promise<ProfilePackPreviewResponse> {
  return withProfilePackAdmission(orgId, () =>
    performProfilePackPreview(db, orgId, archive, options)
  );
}

async function performProfilePackPreview(
  db: DatabaseAdapter,
  orgId: string,
  archive: Buffer | Uint8Array | ArrayBuffer,
  options: PreviewProfilePackImportOptions
): Promise<ProfilePackPreviewResponse> {
  await requireActiveOrganization(db, orgId);
  const entries = await readProfilePackZip(archive);
  const manifest = readProfilePackManifest(entries);
  const skippedAssignments: ProfilePackSkippedItem[] = [];

  await inspectToolAssignments(
    db,
    orgId,
    manifest,
    entries,
    options.restoreCustomTools === true,
    skippedAssignments
  );
  await inspectNamedAssignments(
    db,
    orgId,
    manifest,
    entries,
    skippedAssignments
  );
  inspectModelAssignment(
    manifest.meta.model,
    options.availableModelIds,
    skippedAssignments
  );
  inspectGovernanceSettings(manifest, skippedAssignments);
  inspectPackedSkillCollisions(
    entries,
    await db.listSkills(),
    orgId,
    skippedAssignments
  );

  const restorableEntries = entries.filter(
    (entry) => !isManifestEntry(entry.name)
  );
  return {
    archiveFileCount: restorableEntries.length,
    archiveTotalBytes: restorableEntries.reduce(
      (total, entry) => total + entry.data.length,
      0
    ),
    manifest,
    plannedName: normalizeImportedName(manifest.meta.name),
    skippedAssignments,
    topLevelPaths: getTopLevelPaths(
      restorableEntries.map((entry) => entry.name)
    ),
  };
}

export function importProfilePack(
  db: DatabaseAdapter,
  orgId: string,
  archive: Buffer | Uint8Array | ArrayBuffer,
  options: ImportProfilePackOptions
): Promise<ImportProfilePackResult> {
  return withProfilePackAdmission(orgId, () =>
    performProfilePackImport(db, orgId, archive, options)
  );
}

async function withProfilePackAdmission<T>(
  orgId: string,
  operation: () => Promise<T>
): Promise<T> {
  if (
    activeProfilePackOrganizations.has(orgId) ||
    activeProfilePackOperations >= MAX_CONCURRENT_PROFILE_PACK_OPERATIONS
  ) {
    throw new AtlasApiError(
      "Another profile pack operation is already running. Try again shortly.",
      429
    );
  }
  activeProfilePackOrganizations.add(orgId);
  activeProfilePackOperations += 1;
  try {
    return await operation();
  } finally {
    activeProfilePackOrganizations.delete(orgId);
    activeProfilePackOperations -= 1;
  }
}

async function performProfilePackImport(
  db: DatabaseAdapter,
  orgId: string,
  archive: Buffer | Uint8Array | ArrayBuffer,
  options: ImportProfilePackOptions
): Promise<ImportProfilePackResult> {
  if (!options.confirm) {
    throw new AtlasApiError("Import confirmation is required.", 400);
  }

  await requireActiveOrganization(db, orgId);
  const entries = await readProfilePackZip(archive);
  const manifest = readProfilePackManifest(entries);
  const name = normalizeImportedName(options.name ?? manifest.meta.name);
  const now = (options.now ?? new Date()).toISOString();
  const skippedAssignments: ProfilePackSkippedItem[] = [];
  const model = resolveImportedModel(
    manifest.meta.model,
    options.availableModelIds,
    skippedAssignments
  );
  inspectGovernanceSettings(manifest, skippedAssignments);
  const staging = await createProfileImportStaging(orgId);
  let profileId: string | null = null;
  let finalSoulDir: string | null = null;
  let finalToolsDir: string | null = null;
  let finalToolsModuleDir: string | null = null;
  let reservationCreated = false;
  let soulMoved = false;
  let toolsMoved = false;
  const createdCustomTools: CreatedCustomTool[] = [];
  const existingCustomTools: ExistingCustomToolExpectation[] = [];

  try {
    await initSoulDirectory(staging.stagedSoulDir);
    await writePackedWorkspaceFiles(
      staging.stagedSoulDir,
      entries,
      skippedAssignments
    );
    const profile = await reserveImportedProfile(db, orgId, name, {
      createdAt: now,
      isDefault: false,
      isSuper: false,
      model,
      name,
      orgId,
      skillsPostTurnReview: null,
      skillsWriteApproval: null,
      systemPrompt: manifest.meta.systemPrompt,
      thinkingEffort: manifest.meta.thinkingEffort,
      thinkingEnabled: manifest.meta.thinkingEnabled,
      updatedAt: now,
    });
    profileId = profile.id;
    reservationCreated = true;
    finalSoulDir = getProfileSoulDir(orgId, profileId);
    const toolBundleName = `${safePathSegment(profileId)}-${createId("pack")}`;
    finalToolsDir = join(staging.toolsParentDir, toolBundleName);
    finalToolsModuleDir = `${IMPORTED_TOOLS_DIR}/${safePathSegment(orgId)}/${toolBundleName}`;
    if (await pathExists(finalToolsDir)) {
      throw new AtlasApiError("Could not reserve custom tool storage.", 409);
    }
    const databaseStage = createProfileImportDatabaseStage(
      db,
      orgId,
      profileId
    );
    await recreatePackedSkills(
      databaseStage.adapter,
      orgId,
      profileId,
      join(staging.stagedSoulDir, "skills"),
      join(finalSoulDir, "skills"),
      skippedAssignments
    );
    await restoreToolAssignments(
      databaseStage.adapter,
      orgId,
      profileId,
      manifest,
      entries,
      options.restoreCustomTools === true,
      staging.stagedToolsDir,
      finalToolsModuleDir,
      skippedAssignments,
      createdCustomTools,
      existingCustomTools
    );
    await restoreNamedAssignments(
      databaseStage.adapter,
      orgId,
      profileId,
      manifest,
      skippedAssignments
    );

    if (createdCustomTools.length === 0) {
      await rm(staging.stagedToolsDir, { force: true, recursive: true });
    }
    await rename(staging.stagedSoulDir, finalSoulDir);
    soulMoved = true;
    if (createdCustomTools.length > 0) {
      await rename(staging.stagedToolsDir, finalToolsDir);
      toolsMoved = true;
    }

    await revalidateExistingCustomTools(db, existingCustomTools);
    const publishResult = await db.publishProfileImport(
      databaseStage.publication
    );
    if (publishResult === "inactive") {
      throw new AtlasApiError("Organization not found.", 404);
    }
    if (publishResult === "conflict") {
      throw new AtlasApiError(
        "Profile import conflicted with a destination resource.",
        409
      );
    }

    await new ProfileChangeHistoryService(db).recordBestEffort({
      actorUserId: options.actorUserId,
      afterValue: JSON.stringify({ name, profileId }),
      beforeValue: null,
      createdAt: now,
      field: "pack_import",
      orgId,
      profileId,
      source: "pack_import",
    });

    return { manifest, profileId, skippedAssignments };
  } catch (error) {
    const publishedProfile = profileId
      ? await db.getProfileForOrg(profileId, orgId).catch(() => null)
      : null;
    if (publishedProfile) {
      throw error;
    }
    const cleanupFailures = await rollbackFailedImport(
      db,
      orgId,
      profileId,
      reservationCreated,
      [
        staging.stagedToolsDir,
        ...(toolsMoved && finalToolsDir ? [finalToolsDir] : []),
        staging.stagedSoulDir,
        ...(soulMoved && finalSoulDir ? [finalSoulDir] : []),
      ]
    );
    if (cleanupFailures.length > 0) {
      throw new AtlasApiError(
        `Profile import failed and rollback was incomplete: ${cleanupFailures.join(", ")}`,
        500
      );
    }
    throw error;
  }
}

async function createProfileImportStaging(
  orgId: string
): Promise<ProfileImportStaging> {
  const soulParentDir = dirname(getProfileSoulDir(orgId, "staging"));
  const toolsParentDir = resolveJavascriptModulePath(
    `${IMPORTED_TOOLS_DIR}/${safePathSegment(orgId)}`
  );
  await mkdir(soulParentDir, { mode: 0o700, recursive: true });
  await mkdir(toolsParentDir, { mode: 0o700, recursive: true });

  const stagedSoulDir = await mkdtemp(
    join(soulParentDir, IMPORT_STAGING_PREFIX)
  );
  try {
    const stagedToolsDir = await mkdtemp(
      join(toolsParentDir, IMPORT_STAGING_PREFIX)
    );
    return { stagedSoulDir, stagedToolsDir, toolsParentDir };
  } catch (error) {
    await rm(stagedSoulDir, { force: true, recursive: true });
    throw error;
  }
}

function createProfileImportDatabaseStage(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string
): ProfileImportDatabaseStage {
  const publication: ProfileImportPublication = {
    composioAssignments: [],
    expectedTools: [],
    mcpServerIds: [],
    newSkills: [],
    newTools: [],
    orgId,
    profileId,
    skillIds: [],
    toolIds: [],
  };
  const newSkillsById = new Map<string, StoredSkillRecord>();
  const newSkillsByName = new Map<string, StoredSkillRecord>();
  const newToolsById = new Map<string, StoredToolRecord>();
  const newToolsByName = new Map<string, StoredToolRecord>();
  const expectedToolIds = new Set<string>();

  const assertProfile = (candidate: string): void => {
    if (candidate !== profileId) {
      throw new AtlasApiError("Profile import assignment is invalid.", 409);
    }
  };

  const adapter: DatabaseAdapter = {
    ...db,
    async assignMcpServerToProfile(candidateProfileId, serverId) {
      assertProfile(candidateProfileId);
      addUnique(publication.mcpServerIds, serverId);
    },
    async assignSkillToProfile(candidateProfileId, skillId) {
      assertProfile(candidateProfileId);
      const skill = newSkillsById.get(skillId) ?? (await db.getSkill(skillId));
      if (!(skill && (skill.orgId == null || skill.orgId === orgId))) {
        throw new AtlasApiError("Profile import skill is unavailable.", 409);
      }
      addUnique(publication.skillIds, skillId);
    },
    async assignToolToProfile(candidateProfileId, toolId) {
      assertProfile(candidateProfileId);
      const tool = newToolsById.get(toolId) ?? (await db.getTool(toolId));
      if (!(tool && (tool.orgId == null || tool.orgId === orgId))) {
        throw new AtlasApiError("Profile import tool is unavailable.", 409);
      }
      addUnique(publication.toolIds, toolId);
      if (!(newToolsById.has(toolId) || expectedToolIds.has(toolId))) {
        expectedToolIds.add(toolId);
        publication.expectedTools.push({
          description: tool.description,
          handlerConfig: structuredClone(tool.handlerConfig),
          handlerType: tool.handlerType,
          id: tool.id,
          name: tool.name,
          orgId: tool.orgId,
        });
      }
    },
    async getSkillByName(skillName, candidateOrgId) {
      if (candidateOrgId === orgId) {
        const staged = newSkillsByName.get(skillName);
        if (staged) {
          return staged;
        }
      }
      return db.getSkillByName(skillName, candidateOrgId);
    },
    async getToolByName(toolName, candidateOrgId) {
      if (candidateOrgId === orgId) {
        const staged = newToolsByName.get(toolName);
        if (staged) {
          return staged;
        }
      }
      return db.getToolByName(toolName, candidateOrgId);
    },
    async replaceProfileComposioToolkits(candidateProfileId, assignments) {
      assertProfile(candidateProfileId);
      publication.composioAssignments = assignments.map((assignment) => ({
        ...assignment,
        profileId,
      }));
    },
    async upsertSkill(record) {
      if (
        record.orgId !== orgId ||
        newSkillsById.has(record.id) ||
        newSkillsByName.has(record.name)
      ) {
        throw new AtlasApiError("Profile import skill conflicts.", 409);
      }
      newSkillsById.set(record.id, record);
      newSkillsByName.set(record.name, record);
      publication.newSkills.push(record);
    },
    async upsertTool(record) {
      if (
        record.orgId !== orgId ||
        newToolsById.has(record.id) ||
        newToolsByName.has(record.name)
      ) {
        throw new AtlasApiError("Profile import tool conflicts.", 409);
      }
      newToolsById.set(record.id, record);
      newToolsByName.set(record.name, record);
      publication.newTools.push(record);
    },
  };

  return { adapter, publication };
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

async function inventoryProfileSoulDir(soulDir: string): Promise<{
  avatar: ProfilePackFile | null;
  files: ProfilePackFile[];
  skipped: ProfilePackSkippedItem[];
}> {
  let avatar: ProfilePackFile | null = null;
  const files: ProfilePackFile[] = [];
  const skipped: ProfilePackSkippedItem[] = [];
  if (!(await pathExists(soulDir))) {
    return { avatar, files, skipped };
  }

  const rootEntries = (await readdir(soulDir, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name)
  );
  for (const entry of rootEntries) {
    const absolutePath = join(soulDir, entry.name);
    if (AVATAR_BASENAME_PATTERN.test(entry.name)) {
      const extension = entry.name.slice(entry.name.lastIndexOf(".") + 1);
      if (
        avatar === null &&
        entry.isFile() &&
        AVATAR_EXTENSION_MEDIA_TYPES[extension.toLowerCase()]
      ) {
        avatar = { absolutePath, relativePath: entry.name };
      }
      continue;
    }
    if (entry.isFile() && ROOT_ALLOWED_FILES.has(entry.name)) {
      files.push({ absolutePath, relativePath: entry.name });
      assertEntryCount(files.length);
      continue;
    }
    if (entry.isDirectory() && ALLOWED_ROOT_SUBDIRS.has(entry.name)) {
      await collectRegularFiles(absolutePath, entry.name, files, skipped);
      continue;
    }
    skipped.push({ path: entry.name, reason: NOT_ALLOWLISTED_REASON });
  }

  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
  return { avatar, files, skipped };
}

async function collectRegularFiles(
  directory: string,
  relativeBase: string,
  files: ProfilePackFile[],
  skipped: ProfilePackSkippedItem[]
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = `${relativeBase}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectRegularFiles(absolutePath, relativePath, files, skipped);
      continue;
    }
    if (!entry.isFile()) {
      skipped.push({
        path: relativePath,
        reason:
          "Only regular files are included; links and devices are excluded.",
      });
      continue;
    }
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) {
      skipped.push({ path: relativePath, reason: NOT_ALLOWLISTED_REASON });
      continue;
    }
    files.push({ absolutePath, relativePath });
    assertEntryCount(files.length);
  }
}

async function buildProfilePackMeta(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string,
  profile: StoredProfileRecord
): Promise<ProfilePackMeta> {
  const tools = (await db.listToolsForProfile(profileId)).filter(
    (tool) => tool.orgId == null || tool.orgId === orgId
  );
  const mcpServers = (await db.listMcpServersForProfile(profileId)).filter(
    (server) => server.orgId === orgId
  );
  const skills = (await db.listSkillsForProfile(profileId)).filter(
    (skill) => skill.orgId == null || skill.orgId === orgId
  );
  const toolkitAssignments = await db.listProfileComposioToolkits(profileId);
  const bundledSkillNames: string[] = [];
  const profileSkillNames: string[] = [];

  for (const skill of skills) {
    (isGlobalSkillSourcePath(skill.sourcePath)
      ? bundledSkillNames
      : profileSkillNames
    ).push(skill.name);
  }

  const composioToolkitAssignments: ProfilePackComposioToolkitAssignment[] = [];
  for (const assignment of toolkitAssignments) {
    const toolkit = await db.getComposioToolkit(assignment.toolkitId);
    if (toolkit?.orgId === orgId) {
      composioToolkitAssignments.push({
        allowedActions:
          assignment.allowedActions === null
            ? null
            : uniqueSorted(assignment.allowedActions),
        toolkitSlug: toolkit.toolkitSlug,
      });
    }
  }
  composioToolkitAssignments.sort((left, right) =>
    left.toolkitSlug.localeCompare(right.toolkitSlug)
  );

  return {
    bundledSkillNames: uniqueSorted(bundledSkillNames),
    composioToolkitAssignments,
    composioToolkitSlugs: composioToolkitAssignments.map(
      (assignment) => assignment.toolkitSlug
    ),
    mcpServerNames: uniqueSorted(mcpServers.map((server) => server.name)),
    model: profile.model,
    name: profile.name,
    profileSkillNames: uniqueSorted(profileSkillNames),
    skillsPostTurnReview: profile.skillsPostTurnReview ?? null,
    skillsWriteApproval: profile.skillsWriteApproval ?? null,
    systemPrompt: profile.systemPrompt,
    thinkingEffort: profile.thinkingEffort ?? null,
    thinkingEnabled: profile.thinkingEnabled ?? null,
    toolNames: uniqueSorted(tools.map((tool) => tool.name)),
  };
}

async function collectPackedCustomTools(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string,
  startingTotalBytes: number
): Promise<{
  entries: Record<string, Uint8Array>;
  skipped: ProfilePackSkippedItem[];
  totalBytes: number;
  tools: ProfilePackCustomTool[];
}> {
  const claimedSourcePaths = new Set<string>();
  const entries: Record<string, Uint8Array> = {};
  const skipped: ProfilePackSkippedItem[] = [];
  let totalBytes = startingTotalBytes;
  const tools: ProfilePackCustomTool[] = [];

  for (const tool of await db.listToolsForProfile(profileId)) {
    if (tool.handlerType !== "javascript" || tool.orgId !== orgId) {
      continue;
    }
    const modulePath = readModulePath(tool.handlerConfig);
    if (!modulePath) {
      skipped.push(customToolSkip(tool.name, "has no valid module path"));
      continue;
    }

    let absolutePath: string;
    let sourceFilePath: string;
    try {
      absolutePath = resolveJavascriptModulePath(modulePath);
      const metadata = await lstat(absolutePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("not a regular file");
      }
      const [canonicalToolsDir, canonicalSourcePath] = await Promise.all([
        realpath(getCustomToolsDir()),
        realpath(absolutePath),
      ]);
      if (!isPathInside(canonicalSourcePath, canonicalToolsDir)) {
        throw new Error("source resolves outside tools directory");
      }
      sourceFilePath = canonicalSourcePath;
    } catch {
      skipped.push(
        customToolSkip(
          tool.name,
          "has no regular source file inside the tools directory"
        )
      );
      continue;
    }
    const portablePath = portableToolsPath(absolutePath);
    if (!portablePath?.endsWith(".js")) {
      skipped.push(
        customToolSkip(tool.name, "has no portable JavaScript module")
      );
      continue;
    }
    const sourcePath = `${CUSTOM_TOOLS_ARCHIVE_DIR}/${portablePath}`;
    if (claimedSourcePaths.has(sourcePath)) {
      skipped.push(customToolSkip(tool.name, "shares a packed module path"));
      continue;
    }
    claimedSourcePaths.add(sourcePath);
    const portableParameters = readPortableToolParameters(tool.handlerConfig);
    const definition = portableCustomToolDefinition(
      tool,
      portablePath,
      portableParameters.parameters
    );
    if (!portableParameters.valid) {
      tools.push(portableCustomToolDefinition(tool, portablePath));
      skipped.push(
        customToolSkip(
          tool.name,
          "has malformed or oversized input parameters and cannot be restored safely"
        )
      );
      continue;
    }
    try {
      const source = await readBoundedRegularFile(
        sourceFilePath,
        sourcePath,
        totalBytes
      );
      if (hasRelativeJavaScriptImports(source)) {
        tools.push(definition);
        skipped.push(
          customToolSkip(
            tool.name,
            "uses relative imports whose dependency graph cannot be restored safely"
          )
        );
        continue;
      }
      entries[sourcePath] = source;
      totalBytes += source.length;
    } catch (error) {
      if (error instanceof AtlasApiError) {
        throw error;
      }
      skipped.push(customToolSkip(tool.name, "has no readable source file"));
      continue;
    }
    tools.push(definition);
  }

  return {
    entries,
    skipped,
    tools: tools.sort((left, right) => left.name.localeCompare(right.name)),
    totalBytes,
  };
}

async function inspectToolAssignments(
  db: DatabaseAdapter,
  orgId: string,
  manifest: ProfilePackManifest,
  entries: ProfilePackZipEntry[],
  restoreCustomTools: boolean,
  skipped: ProfilePackSkippedItem[]
): Promise<void> {
  for (const name of manifest.meta.toolNames) {
    const packed = findPackedCustomTool(manifest, name);
    const existing = await db.getToolByName(name, orgId);
    if (!packed) {
      if (!existing) {
        skipped.push(missingToolSkip(name));
      }
      continue;
    }
    const source = entries.find((entry) => entry.name === packed.sourcePath);
    if (!source) {
      skipped.push(customToolSkip(name, "is missing its source file"));
      continue;
    }
    if (hasRelativeJavaScriptImports(source.data)) {
      skipped.push(
        customToolSkip(
          name,
          "uses relative imports whose dependency graph cannot be restored safely"
        )
      );
      continue;
    }
    if (existing) {
      if (
        !(await existingCustomToolMatches(
          existing,
          source.data,
          packed.definition
        ))
      ) {
        skipped.push(customToolSkip(name, "conflicts with an existing tool"));
      }
      continue;
    }
    if (!restoreCustomTools) {
      skipped.push(
        customToolSkip(name, "requires a platform admin to restore source code")
      );
    }
  }
}

async function inspectNamedAssignments(
  db: DatabaseAdapter,
  orgId: string,
  manifest: ProfilePackManifest,
  entries: ProfilePackZipEntry[],
  skipped: ProfilePackSkippedItem[]
): Promise<void> {
  const packedSkillNames = new Set(
    readSkillNamesFromZip(entries).map((skill) => skill.name)
  );
  for (const name of manifest.meta.mcpServerNames) {
    if (!(await db.getMcpServerByName(name, orgId))) {
      skipped.push({
        path: `MCP server:${name}`,
        reason: `MCP server "${name}" is unavailable in the destination organization.`,
      });
    }
  }
  for (const name of manifest.meta.bundledSkillNames) {
    const skill = await db.getSkillByName(name, orgId);
    if (!(skill && isGlobalSkillSourcePath(skill.sourcePath))) {
      skipped.push({
        path: `bundled skill:${name}`,
        reason: `Bundled skill "${name}" is unavailable in the destination.`,
      });
    }
  }
  for (const name of manifest.meta.profileSkillNames) {
    if (
      !((await db.getSkillByName(name, orgId)) || packedSkillNames.has(name))
    ) {
      skipped.push({
        path: `profile skill:${name}`,
        reason: `Profile skill "${name}" is unavailable in the destination organization.`,
      });
    }
  }
  for (const assignment of getPortableComposioAssignments(manifest)) {
    if (assignment.allowedActions === undefined) {
      skipped.push(legacyComposioPolicySkip(assignment.toolkitSlug));
      continue;
    }
    if (
      Array.isArray(assignment.allowedActions) &&
      assignment.allowedActions.length === 0
    ) {
      skipped.push(emptyComposioPolicySkip(assignment.toolkitSlug));
      continue;
    }
    if (!(await db.getComposioToolkitBySlug(orgId, assignment.toolkitSlug))) {
      skipped.push({
        path: `Composio toolkit:${assignment.toolkitSlug}`,
        reason: `Composio toolkit "${assignment.toolkitSlug}" is unavailable in the destination organization.`,
      });
    }
  }
}

async function requireActiveOrganization(
  db: DatabaseAdapter,
  orgId: string
): Promise<void> {
  const organization = await db.getOrganizationById(orgId);
  if (!organization || organization.archivedAt) {
    throw new AtlasApiError("Organization not found.", 404);
  }
}

function inspectModelAssignment(
  model: string | null,
  availableModelIds: ReadonlySet<string> | undefined,
  skipped: ProfilePackSkippedItem[]
): void {
  if (model && !availableModelIds?.has(model)) {
    skipped.push({
      path: `model:${model}`,
      reason:
        "The packed model is not configured in the destination organization; the imported profile will use its organization default.",
    });
  }
}

function inspectGovernanceSettings(
  manifest: ProfilePackManifest,
  skipped: ProfilePackSkippedItem[]
): void {
  if (manifest.meta.skillsWriteApproval !== null) {
    skipped.push({
      path: "profile setting:skills write approval",
      reason:
        "The source override is not activated; the imported profile inherits the destination organization policy.",
    });
  }
  if (manifest.meta.skillsPostTurnReview !== null) {
    skipped.push({
      path: "profile setting:post-turn skill review",
      reason:
        "The source override is not activated; the imported profile inherits the destination organization policy.",
    });
  }
}

function resolveImportedModel(
  model: string | null,
  availableModelIds: ReadonlySet<string> | undefined,
  skipped: ProfilePackSkippedItem[]
): string | null {
  if (!model) {
    return null;
  }
  if (availableModelIds?.has(model)) {
    return model;
  }
  inspectModelAssignment(model, availableModelIds, skipped);
  return null;
}

function inspectPackedSkillCollisions(
  entries: ProfilePackZipEntry[],
  skills: StoredSkillRecord[],
  orgId: string,
  skipped: ProfilePackSkippedItem[]
): void {
  const visibleNames = new Set(
    skills
      .filter((skill) => skill.orgId == null || skill.orgId === orgId)
      .map((skill) => skill.name)
  );
  for (const skill of readSkillNamesFromZip(entries)) {
    if (visibleNames.has(skill.name)) {
      skipped.push({
        path: `skills/${skill.folder}`,
        reason: `Skill "${skill.name}" already exists and the packed copy will be skipped.`,
      });
    }
  }
}

async function restoreToolAssignments(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string,
  manifest: ProfilePackManifest,
  entries: ProfilePackZipEntry[],
  restoreCustomTools: boolean,
  stagedToolsDir: string,
  finalToolsModuleDir: string,
  skipped: ProfilePackSkippedItem[],
  createdTools: CreatedCustomTool[],
  existingTools: ExistingCustomToolExpectation[]
): Promise<void> {
  for (const name of manifest.meta.toolNames) {
    const packed = findPackedCustomTool(manifest, name);
    const existing = await db.getToolByName(name, orgId);
    if (!packed) {
      if (existing) {
        await db.assignToolToProfile(profileId, existing.id);
      } else {
        skipped.push(missingToolSkip(name));
      }
      continue;
    }

    const source = entries.find((entry) => entry.name === packed.sourcePath);
    if (!source) {
      skipped.push(customToolSkip(name, "is missing its source file"));
      continue;
    }
    if (hasRelativeJavaScriptImports(source.data)) {
      skipped.push(
        customToolSkip(
          name,
          "uses relative imports whose dependency graph cannot be restored safely"
        )
      );
      continue;
    }
    if (existing) {
      if (
        await existingCustomToolMatches(
          existing,
          source.data,
          packed.definition
        )
      ) {
        existingTools.push({
          definition: packed.definition,
          source: source.data,
          toolId: existing.id,
        });
        await db.assignToolToProfile(profileId, existing.id);
      } else {
        skipped.push(customToolSkip(name, "conflicts with an existing tool"));
      }
      continue;
    }
    if (!restoreCustomTools) {
      skipped.push(
        customToolSkip(name, "requires a platform admin to restore source code")
      );
      continue;
    }

    validateJavaScriptSource(source.data, name);
    const moduleFilename = `${slugifyProfileName(name)}.js`;
    const modulePath = `${finalToolsModuleDir}/${moduleFilename}`;
    const finalAbsolutePath = resolveJavascriptModulePath(modulePath);
    const stagedAbsolutePath = join(stagedToolsDir, moduleFilename);
    if (
      (await pathExists(finalAbsolutePath)) ||
      (await pathExists(stagedAbsolutePath))
    ) {
      skipped.push(customToolSkip(name, "cannot replace an existing module"));
      continue;
    }

    const now = new Date().toISOString();
    const record: StoredToolRecord = {
      createdAt: now,
      description: packed.definition.description,
      handlerConfig: {
        modulePath,
        ...(packed.definition.handlerConfig.parameters
          ? { parameters: packed.definition.handlerConfig.parameters }
          : {}),
      },
      handlerType: "javascript",
      id: createId("tool"),
      name,
      orgId,
      updatedAt: now,
    };
    await writePrivateBytesFile(stagedAbsolutePath, source.data);
    await db.upsertTool(record);
    createdTools.push({ id: record.id });
    await db.assignToolToProfile(profileId, record.id);
  }
}

async function existingCustomToolMatches(
  tool: StoredToolRecord,
  packedSource: Buffer,
  definition: ProfilePackCustomTool
): Promise<boolean> {
  if (
    tool.name !== definition.name ||
    tool.description !== definition.description ||
    tool.handlerType !== definition.handlerType ||
    tool.handlerType !== "javascript"
  ) {
    return false;
  }
  const existingParameters = readPortableToolParameters(tool.handlerConfig);
  const packedParameters = readPortableToolParameters(definition.handlerConfig);
  if (
    !(
      existingParameters.valid &&
      packedParameters.valid &&
      portableParametersEqual(
        existingParameters.parameters,
        packedParameters.parameters
      )
    )
  ) {
    return false;
  }
  const modulePath = readModulePath(tool.handlerConfig);
  if (!modulePath) {
    return false;
  }
  try {
    return (
      await readBoundedRegularFile(
        resolveJavascriptModulePath(modulePath),
        `custom tool:${tool.name}`,
        0
      )
    ).equals(packedSource);
  } catch {
    return false;
  }
}

async function revalidateExistingCustomTools(
  db: DatabaseAdapter,
  expectations: ExistingCustomToolExpectation[]
): Promise<void> {
  for (const expectation of expectations) {
    const current = await db.getTool(expectation.toolId);
    if (
      !(
        current &&
        (await existingCustomToolMatches(
          current,
          expectation.source,
          expectation.definition
        ))
      )
    ) {
      throw new AtlasApiError(
        `Custom tool "${expectation.definition.name}" changed during import.`,
        409
      );
    }
  }
}

function portableParametersEqual(
  left: JsonSchema | undefined,
  right: JsonSchema | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writePackedWorkspaceFiles(
  soulDir: string,
  entries: ProfilePackZipEntry[],
  skipped: ProfilePackSkippedItem[]
): Promise<void> {
  const resolvedSoulDir = resolve(soulDir);
  for (const entry of entries) {
    if (
      isManifestEntry(entry.name) ||
      entry.name.startsWith(`${CUSTOM_TOOLS_ARCHIVE_DIR}/`)
    ) {
      continue;
    }
    if (isAvatarEntry(entry.name)) {
      await writePackedAvatar(resolvedSoulDir, entry);
      continue;
    }
    if (!isAllowlistedProfilePackPath(entry.name)) {
      skipped.push({ path: entry.name, reason: NOT_ALLOWLISTED_REASON });
      continue;
    }
    const targetPath = resolve(resolvedSoulDir, entry.name);
    if (!isPathInside(targetPath, resolvedSoulDir)) {
      throw new AtlasApiError(
        `Archive entry escapes profile root: ${entry.name}`,
        400
      );
    }
    await writePrivateBytesFile(targetPath, entry.data);
  }
}

async function writePackedAvatar(
  soulDir: string,
  entry: ProfilePackZipEntry
): Promise<void> {
  const extension = entry.name
    .slice(entry.name.lastIndexOf(".") + 1)
    .toLowerCase();
  const mediaType = AVATAR_EXTENSION_MEDIA_TYPES[extension];
  if (!mediaType) {
    return;
  }
  await validateDecodedImageAttachments([
    {
      data: entry.data.toString("base64"),
      mediaType,
    },
  ]);
  await writePrivateBytesFile(join(soulDir, entry.name), entry.data);
}

async function recreatePackedSkills(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string,
  sourceSkillsDir: string,
  finalSkillsDir: string,
  skipped: ProfilePackSkippedItem[]
): Promise<string[]> {
  const createdSkillIds: string[] = [];
  if (!(await pathExists(sourceSkillsDir))) {
    return createdSkillIds;
  }

  const folders = (
    await readdir(sourceSkillsDir, { withFileTypes: true })
  ).filter((entry) => entry.isDirectory());
  for (const folder of folders) {
    const stagedSourcePath = join(sourceSkillsDir, folder.name);
    const discovered = await discoverSkillDirectory(stagedSourcePath);
    if (!discovered) {
      skipped.push({
        path: `skills/${folder.name}`,
        reason: "Skill directory has no valid SKILL.md and was skipped.",
      });
      await rm(stagedSourcePath, { force: true, recursive: true });
      continue;
    }
    const existing = await db.getSkillByName(discovered.name, orgId);
    if (existing) {
      skipped.push({
        path: `skills/${folder.name}`,
        reason: `Skill "${discovered.name}" already exists and the packed copy was skipped.`,
      });
      await rm(stagedSourcePath, { force: true, recursive: true });
      continue;
    }
    const now = new Date().toISOString();
    const record: StoredSkillRecord = {
      createdAt: now,
      createdBy: "human",
      description: discovered.description,
      disableModelInvocation: discovered.disableModelInvocation,
      enabled: true,
      hasTool: discovered.hasTool,
      id: createId("skill"),
      name: discovered.name,
      orgId,
      sourcePath: join(finalSkillsDir, folder.name),
      updatedAt: now,
    };
    await db.upsertSkill(record);
    createdSkillIds.push(record.id);
    await db.assignSkillToProfile(profileId, record.id);
  }
  return createdSkillIds;
}

async function restoreNamedAssignments(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string,
  manifest: ProfilePackManifest,
  skipped: ProfilePackSkippedItem[]
): Promise<void> {
  for (const name of manifest.meta.mcpServerNames) {
    const server = await db.getMcpServerByName(name, orgId);
    if (server?.orgId === orgId) {
      await db.assignMcpServerToProfile(profileId, server.id);
    } else {
      skipped.push({
        path: `MCP server:${name}`,
        reason: `MCP server "${name}" was skipped.`,
      });
    }
  }
  for (const name of manifest.meta.bundledSkillNames) {
    const skill = await db.getSkillByName(name, orgId);
    if (skill && isGlobalSkillSourcePath(skill.sourcePath)) {
      await db.assignSkillToProfile(profileId, skill.id);
    } else {
      skipped.push({
        path: `bundled skill:${name}`,
        reason: `Bundled skill "${name}" was skipped.`,
      });
    }
  }
  for (const name of manifest.meta.profileSkillNames) {
    const skill = await db.getSkillByName(name, orgId);
    if (skill && (skill.orgId == null || skill.orgId === orgId)) {
      await db.assignSkillToProfile(profileId, skill.id);
    } else {
      skipped.push({
        path: `profile skill:${name}`,
        reason: `Profile skill "${name}" was skipped.`,
      });
    }
  }

  const assignments: StoredProfileComposioToolkitRecord[] = [];
  for (const assignment of getPortableComposioAssignments(manifest)) {
    if (assignment.allowedActions === undefined) {
      skipped.push(legacyComposioPolicySkip(assignment.toolkitSlug));
      continue;
    }
    if (
      Array.isArray(assignment.allowedActions) &&
      assignment.allowedActions.length === 0
    ) {
      skipped.push(emptyComposioPolicySkip(assignment.toolkitSlug));
      continue;
    }
    const toolkit = await db.getComposioToolkitBySlug(
      orgId,
      assignment.toolkitSlug
    );
    if (toolkit?.orgId === orgId) {
      assignments.push({
        allowedActions: assignment.allowedActions,
        profileId,
        toolkitId: toolkit.id,
      });
    } else {
      skipped.push({
        path: `Composio toolkit:${assignment.toolkitSlug}`,
        reason: `Composio toolkit "${assignment.toolkitSlug}" was skipped.`,
      });
    }
  }
  if (assignments.length > 0) {
    await db.replaceProfileComposioToolkits(profileId, assignments);
  }
}

async function rollbackFailedImport(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string | null,
  reservationCreated: boolean,
  filesystemPaths: string[]
): Promise<string[]> {
  const cleanupFailures: string[] = [];

  // Remove files before releasing the hidden reservation so another profile
  // cannot claim the id while cleanup still targets its final paths.
  for (const path of filesystemPaths) {
    try {
      await rm(path, { force: true, recursive: true });
    } catch {
      cleanupFailures.push(`filesystem:${basename(path)}`);
    }
  }
  if (cleanupFailures.length === 0 && reservationCreated && profileId) {
    try {
      if (!(await db.deleteProfileImportReservation(profileId, orgId))) {
        cleanupFailures.push(`profile:${profileId}`);
      }
    } catch {
      cleanupFailures.push(`profile:${profileId}`);
    }
  }
  return cleanupFailures;
}

async function readProfilePackZip(
  archive: Buffer | Uint8Array | ArrayBuffer
): Promise<ProfilePackZipEntry[]> {
  const bytes = toBuffer(archive);
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw new AtlasApiError(
      "Profile pack exceeds the 25 MB archive limit.",
      413
    );
  }

  try {
    const metadata = inspectZipCentralDirectory(bytes);
    let declaredTotalBytes = 0;
    const files = metadata.filter((entry) => !entry.isDirectory);
    assertEntryCount(files.length);

    for (const entry of files) {
      assertEntrySize(entry.name, entry.originalSize);
      if (
        isManifestEntry(entry.name) &&
        entry.originalSize > MAX_MANIFEST_BYTES
      ) {
        throw new AtlasApiError("Profile pack manifest exceeds 1 MB.", 413);
      }
      declaredTotalBytes += entry.originalSize;
      assertTotalSize(declaredTotalBytes);
    }

    const entries: ProfilePackZipEntry[] = [];
    let totalBytes = 0;
    for (const metadataEntry of files) {
      const entry = await extractProfilePackEntry(bytes, metadataEntry);
      assertEntrySize(metadataEntry.name, entry.length);
      totalBytes += entry.length;
      assertTotalSize(totalBytes);
      entries.push({ data: entry, name: metadataEntry.name });
    }
    assertProfilePackStructure(entries);
    return entries;
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new AtlasApiError(
      detail === "invalid zip data"
        ? "Invalid ZIP archive."
        : `Invalid ZIP archive. ${detail}`,
      400
    );
  }
}

export function decodeProfilePackRequestData(data: string): Buffer {
  const encoded = data.trim();
  if (!encoded) {
    throw new AtlasApiError("Profile pack data is required.", 400);
  }
  if (encoded.length > MAX_ENCODED_ARCHIVE_CHARS) {
    throw new AtlasApiError(
      "Profile pack exceeds the 25 MB archive limit.",
      413
    );
  }
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new AtlasApiError("Profile pack data is not valid base64.", 400);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length > MAX_ARCHIVE_BYTES) {
    throw new AtlasApiError(
      "Profile pack exceeds the 25 MB archive limit.",
      413
    );
  }
  return decoded;
}

function inspectZipCentralDirectory(bytes: Buffer): ProfilePackZipMetadata[] {
  const endOfCentralDirectorySignature = 0x06_05_4b_50;
  const centralDirectorySignature = 0x02_01_4b_50;
  const localFileHeaderSignature = 0x04_03_4b_50;
  const minimumEocdBytes = 22;
  const searchStart = Math.max(0, bytes.length - 65_557);
  let eocdOffset = -1;

  for (
    let offset = bytes.length - minimumEocdBytes;
    offset >= searchStart;
    offset -= 1
  ) {
    if (
      bytes.readUInt32LE(offset) === endOfCentralDirectorySignature &&
      offset + minimumEocdBytes + bytes.readUInt16LE(offset + 20) ===
        bytes.length
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new AtlasApiError("Invalid ZIP archive.", 400);
  }

  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDiskNumber = bytes.readUInt16LE(eocdOffset + 6);
  const diskEntryCount = bytes.readUInt16LE(eocdOffset + 8);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDiskNumber !== 0 ||
    diskEntryCount !== entryCount ||
    entryCount === 0xff_ff ||
    centralSize === 0xff_ff_ff_ff ||
    centralOffset === 0xff_ff_ff_ff ||
    entryCount > MAX_ENTRIES ||
    centralOffset + centralSize > eocdOffset
  ) {
    throw new AtlasApiError("Unsupported or oversized ZIP archive.", 400);
  }

  let offset = centralOffset;
  const centralEnd = centralOffset + centralSize;
  const entries: Array<
    Omit<ProfilePackZipMetadata, "dataOffset"> & {
      centralFlags: number;
      filenameBytes: Buffer;
    }
  > = [];
  const seenPaths = new Map<string, string>();
  let declaredTotalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > centralEnd ||
      bytes.readUInt32LE(offset) !== centralDirectorySignature
    ) {
      throw new AtlasApiError("Invalid ZIP central directory.", 400);
    }
    const versionMadeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const crc32 = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const originalSize = bytes.readUInt32LE(offset + 24);
    const filenameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const diskStart = bytes.readUInt16LE(offset + 34);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    if (hasZipFlag(flags, 1)) {
      throw new AtlasApiError("Encrypted ZIP entries are not supported.", 400);
    }
    if (compression !== 0 && compression !== 8) {
      throw new AtlasApiError(
        `Unsupported ZIP compression method: ${compression}`,
        400
      );
    }
    if (
      diskStart !== 0 ||
      compressedSize === 0xff_ff_ff_ff ||
      originalSize === 0xff_ff_ff_ff ||
      localHeaderOffset === 0xff_ff_ff_ff
    ) {
      throw new AtlasApiError("ZIP64 archives are not supported.", 400);
    }

    const sourcePlatform = Math.floor(versionMadeBy / 256);
    if (sourcePlatform === 3) {
      const unixMode = Math.floor(externalAttributes / 65_536);
      const fileType = unixMode - (unixMode % 0o1_0000);
      const isRegularOrDirectory =
        fileType === 0 || fileType === 0o10_0000 || fileType === 0o04_0000;
      if (!isRegularOrDirectory) {
        throw new AtlasApiError(
          "ZIP links and special filesystem entries are not supported.",
          400
        );
      }
    }
    const nextOffset =
      offset + 46 + filenameLength + extraLength + commentLength;
    if (nextOffset > centralEnd) {
      throw new AtlasApiError("Invalid ZIP central directory.", 400);
    }
    const filenameBytes = Buffer.from(
      bytes.subarray(offset + 46, offset + 46 + filenameLength)
    );
    const name = decodeZipFilename(filenameBytes, flags);
    const isDirectory = name.endsWith("/");
    const logicalName = isDirectory ? name.slice(0, -1) : name;
    validateProfilePackEntryPath(logicalName);
    const collisionKey = normalizedArchivePathKey(logicalName);
    const previous = seenPaths.get(collisionKey);
    if (previous) {
      throw new AtlasApiError(
        `Profile pack contains duplicate or case-colliding paths: ${previous} and ${name}`,
        400
      );
    }
    seenPaths.set(collisionKey, name);
    if (!isDirectory) {
      assertEntrySize(name, originalSize);
      declaredTotalBytes += originalSize;
      assertTotalSize(declaredTotalBytes);
    }
    entries.push({
      centralFlags: flags,
      compressedSize,
      compression,
      crc32,
      filenameBytes,
      isDirectory,
      localHeaderOffset,
      name,
      originalSize,
    });
    offset = nextOffset;
  }
  if (offset !== centralEnd) {
    throw new AtlasApiError("Invalid ZIP central directory size.", 400);
  }

  validateArchivePathHierarchy(entries);

  const ranges: Array<{ end: number; name: string; start: number }> = [];
  const result: ProfilePackZipMetadata[] = [];
  for (const entry of entries) {
    const localOffset = entry.localHeaderOffset;
    if (
      localOffset + 30 > centralOffset ||
      bytes.readUInt32LE(localOffset) !== localFileHeaderSignature
    ) {
      throw new AtlasApiError(
        `Invalid local ZIP header for ${entry.name}.`,
        400
      );
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localCompression = bytes.readUInt16LE(localOffset + 8);
    const localCrc32 = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localOriginalSize = bytes.readUInt32LE(localOffset + 22);
    const localFilenameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset =
      localOffset + 30 + localFilenameLength + localExtraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataOffset > centralOffset || dataEnd > centralOffset) {
      throw new AtlasApiError(
        `ZIP entry data is outside the local file area: ${entry.name}`,
        400
      );
    }
    const localFilenameBytes = bytes.subarray(
      localOffset + 30,
      localOffset + 30 + localFilenameLength
    );
    if (
      localFlags !== entry.centralFlags ||
      localCompression !== entry.compression ||
      !entry.filenameBytes.equals(localFilenameBytes)
    ) {
      throw new AtlasApiError(
        `ZIP local and central headers disagree for ${entry.name}.`,
        400
      );
    }

    const usesDataDescriptor = hasZipFlag(localFlags, 8);
    const localMetadataMatches = usesDataDescriptor
      ? (localCrc32 === 0 || localCrc32 === entry.crc32) &&
        (localCompressedSize === 0 ||
          localCompressedSize === entry.compressedSize) &&
        (localOriginalSize === 0 || localOriginalSize === entry.originalSize)
      : localCrc32 === entry.crc32 &&
        localCompressedSize === entry.compressedSize &&
        localOriginalSize === entry.originalSize;
    if (!localMetadataMatches) {
      throw new AtlasApiError(
        `ZIP local metadata is invalid for ${entry.name}.`,
        400
      );
    }
    ranges.push({ end: dataEnd, name: entry.name, start: localOffset });
    result.push({
      compressedSize: entry.compressedSize,
      compression: entry.compression,
      crc32: entry.crc32,
      dataOffset,
      isDirectory: entry.isDirectory,
      localHeaderOffset: entry.localHeaderOffset,
      name: entry.name,
      originalSize: entry.originalSize,
    });
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1]!;
    const current = ranges[index]!;
    if (current.start < previous.end) {
      throw new AtlasApiError(
        `ZIP entries overlap: ${previous.name} and ${current.name}.`,
        400
      );
    }
  }

  return result;
}

async function extractProfilePackEntry(
  archive: Buffer,
  metadata: ProfilePackZipMetadata
): Promise<Buffer> {
  const compressed = archive.subarray(
    metadata.dataOffset,
    metadata.dataOffset + metadata.compressedSize
  );
  let data: Buffer;
  if (metadata.compression === 0) {
    data = Buffer.from(compressed);
  } else {
    data = await inflateProfilePackEntry(compressed, metadata);
  }

  if (data.length !== metadata.originalSize) {
    throw new AtlasApiError(
      `ZIP entry size does not match its header: ${metadata.name}`,
      400
    );
  }
  if (crc32(data) !== metadata.crc32) {
    throw new AtlasApiError(`ZIP entry checksum failed: ${metadata.name}`, 400);
  }
  return data;
}

function inflateProfilePackEntry(
  compressed: Buffer,
  metadata: ProfilePackZipMetadata
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const inflater = createInflateRaw();
    const chunks: Buffer[] = [];
    let emittedBytes = 0;
    let settled = false;

    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      inflater.destroy();
      rejectPromise(error);
    };

    inflater.on("data", (chunk: Buffer) => {
      const nextSize = emittedBytes + chunk.length;
      if (nextSize > metadata.originalSize || nextSize > MAX_ENTRY_BYTES) {
        rejectOnce(
          new AtlasApiError(
            `ZIP entry expands beyond its declared size: ${metadata.name}`,
            400
          )
        );
        return;
      }
      emittedBytes = nextSize;
      chunks.push(Buffer.from(chunk));
    });
    inflater.once("error", (error) => {
      rejectOnce(
        new AtlasApiError(
          `Invalid compressed ZIP entry ${metadata.name}: ${error.message}`,
          400
        )
      );
    });
    inflater.once("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise(Buffer.concat(chunks, emittedBytes));
    });
    inflater.end(compressed);
  });
}

function decodeZipFilename(bytes: Buffer, flags: number): string {
  try {
    return hasZipFlag(flags, 0x08_00)
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : bytes.toString("latin1");
  } catch {
    throw new AtlasApiError("ZIP entry name is not valid UTF-8.", 400);
  }
}

function validateArchivePathHierarchy(
  entries: Array<{ isDirectory: boolean; name: string }>
): void {
  const filePaths = new Map(
    entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => [normalizedArchivePathKey(entry.name), entry.name])
  );

  for (const entry of entries) {
    const logicalName = entry.isDirectory
      ? entry.name.slice(0, -1)
      : entry.name;
    const segments = logicalName.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = normalizedArchivePathKey(
        segments.slice(0, length).join("/")
      );
      const conflictingFile = filePaths.get(ancestor);
      if (conflictingFile) {
        throw new AtlasApiError(
          `Profile pack path is both a file and a directory: ${conflictingFile} and ${entry.name}`,
          400
        );
      }
    }
  }
}

function crc32(data: Buffer): number {
  return Bun.hash.crc32(data);
}

function hasZipFlag(flags: number, flag: number): boolean {
  return Math.floor(flags / flag) % 2 === 1;
}

function readProfilePackManifest(
  entries: ProfilePackZipEntry[]
): ProfilePackManifest {
  const manifestEntry = entries.find((entry) => isManifestEntry(entry.name));
  if (!manifestEntry) {
    throw new AtlasApiError("Archive is missing a profile pack manifest.", 400);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch {
    throw new AtlasApiError("Profile pack manifest is not valid JSON.", 400);
  }
  if (!isRecord(raw)) {
    throw new AtlasApiError("Profile pack manifest is invalid.", 400);
  }
  const kind = raw.kind;
  if (kind !== PROFILE_PACK_KIND && kind !== LEGACY_PROFILE_PACK_KIND) {
    throw new AtlasApiError(
      "Archive is not an Atlas or Nakama profile pack.",
      400
    );
  }
  if (
    raw.version !== LEGACY_PROFILE_PACK_FORMAT_VERSION &&
    raw.version !== PROFILE_PACK_FORMAT_VERSION
  ) {
    throw new AtlasApiError(
      `Unsupported profile pack version: ${String(raw.version)}`,
      400
    );
  }
  if (!isRecord(raw.meta)) {
    throw new AtlasApiError("Profile pack metadata is invalid.", 400);
  }
  const meta = raw.meta;
  const name = readRequiredString(meta.name, "profile name");
  const systemPrompt = readRequiredString(
    meta.systemPrompt,
    "system prompt",
    true
  );

  return {
    apiVersion: typeof raw.apiVersion === "string" ? raw.apiVersion : "unknown",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    kind,
    meta: {
      bundledSkillNames: readStringArray(meta.bundledSkillNames),
      composioToolkitAssignments: readComposioToolkitAssignments(
        meta.composioToolkitAssignments
      ),
      composioToolkitSlugs: readStringArray(meta.composioToolkitSlugs),
      customTools: readCustomToolDefinitions(meta.customTools),
      mcpServerNames: readStringArray(meta.mcpServerNames),
      model: typeof meta.model === "string" ? meta.model : null,
      name,
      profileSkillNames: readStringArray(meta.profileSkillNames),
      skillsPostTurnReview: readNullableBoolean(meta.skillsPostTurnReview),
      skillsWriteApproval: readNullableBoolean(meta.skillsWriteApproval),
      systemPrompt,
      thinkingEffort:
        typeof meta.thinkingEffort === "string" ? meta.thinkingEffort : null,
      thinkingEnabled: readNullableBoolean(meta.thinkingEnabled),
      toolNames: readStringArray(meta.toolNames),
    },
    skipped: readSkippedItems(raw.skipped),
    sourceProfileId:
      typeof raw.sourceProfileId === "string" ? raw.sourceProfileId : "unknown",
    topLevelPaths: readStringArray(raw.topLevelPaths),
    version: raw.version,
  };
}

function readCustomToolDefinitions(
  value: unknown
): ProfilePackCustomTool[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const results: ProfilePackCustomTool[] = [];
  const names = new Set<string>();
  const modulePaths = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      entry.handlerType !== "javascript" ||
      !isRecord(entry.handlerConfig)
    ) {
      throw new AtlasApiError(
        "Profile pack contains an invalid custom tool definition.",
        400
      );
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const description =
      typeof entry.description === "string" ? entry.description : "";
    const modulePath = readModulePath(entry.handlerConfig);
    if (!(name && description && modulePath?.endsWith(".js"))) {
      throw new AtlasApiError(
        "Profile pack contains an invalid custom tool definition.",
        400
      );
    }
    const portableParameters = readPortableToolParameters(entry.handlerConfig);
    if (!portableParameters.valid) {
      throw new AtlasApiError(
        "Profile pack contains an invalid custom tool parameter schema.",
        400
      );
    }
    try {
      validatePortablePath(modulePath);
    } catch {
      throw new AtlasApiError(
        "Profile pack contains an invalid custom tool module path.",
        400
      );
    }
    const nameKey = name.normalize("NFC").toLowerCase();
    const modulePathKey = normalizedArchivePathKey(modulePath);
    if (names.has(nameKey) || modulePaths.has(modulePathKey)) {
      throw new AtlasApiError(
        "Profile pack contains duplicate custom tool definitions.",
        400
      );
    }
    names.add(nameKey);
    modulePaths.add(modulePathKey);
    results.push({
      description,
      handlerConfig: {
        modulePath,
        ...(portableParameters.parameters
          ? { parameters: portableParameters.parameters }
          : {}),
      },
      handlerType: "javascript",
      name,
    });
  }
  return results;
}

function findPackedCustomTool(
  manifest: ProfilePackManifest,
  name: string
): ValidCustomToolDefinition | null {
  const definition = manifest.meta.customTools?.find(
    (tool) => tool.name === name
  );
  if (!definition) {
    return null;
  }
  const modulePath = definition.handlerConfig.modulePath;
  return {
    definition,
    sourcePath: `${CUSTOM_TOOLS_ARCHIVE_DIR}/${modulePath}`,
  };
}

function readSkillNamesFromZip(
  entries: ProfilePackZipEntry[]
): Array<{ folder: string; name: string }> {
  const results: Array<{ folder: string; name: string }> = [];
  for (const entry of entries) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(entry.name);
    if (!match?.[1]) {
      continue;
    }
    try {
      const parsed = parseSkillMarkdown(
        entry.data.toString("utf8"),
        entry.name
      );
      results.push({ folder: match[1], name: parsed.frontmatter.name });
    } catch {
      // Invalid skill content is reported during import.
    }
  }
  return results;
}

async function reserveImportedProfile(
  db: DatabaseAdapter,
  orgId: string,
  name: string,
  record: Omit<StoredProfileRecord, "id">
): Promise<StoredProfileRecord> {
  const base = slugifyProfileName(name);
  for (let suffix = 1; suffix <= PROFILE_ID_ATTEMPTS; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (await pathExists(getProfileSoulDir(orgId, candidate))) {
      continue;
    }
    const profile = { ...record, id: candidate, isImporting: true };
    const admission = await db.reserveProfileImport(profile);
    if (admission === "inactive") {
      throw new AtlasApiError("Organization not found.", 404);
    }
    if (admission === "reserved") {
      return profile;
    }
  }
  throw new AtlasApiError(
    `Could not find a free profile id for "${name}".`,
    409
  );
}

function normalizeImportedName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new AtlasApiError("Imported profile name is required.", 400);
  }
  if (name.length > 120) {
    throw new AtlasApiError(
      "Imported profile name must be at most 120 characters.",
      400
    );
  }
  return name;
}

function validateProfilePackEntryPath(path: string): void {
  if (
    !path ||
    path.length > MAX_PATH_LENGTH ||
    path.includes("\0") ||
    path.includes("\\")
  ) {
    throw new AtlasApiError("Archive entry path is empty or invalid.", 400);
  }
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path)) {
    throw new AtlasApiError(`Archive entry must be relative: ${path}`, 400);
  }
  const segments = path.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new AtlasApiError(
      `Archive entry escapes profile pack root: ${path}`,
      400
    );
  }
}

function normalizedArchivePathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function assertProfilePackStructure(entries: ProfilePackZipEntry[]): void {
  const manifests = entries.filter((entry) => isManifestEntry(entry.name));
  if (manifests.length !== 1) {
    throw new AtlasApiError(
      manifests.length === 0
        ? "Archive is missing a profile pack manifest."
        : "Archive contains multiple profile pack manifests.",
      400
    );
  }
  if (entries.filter((entry) => isAvatarEntry(entry.name)).length > 1) {
    throw new AtlasApiError("Archive contains multiple profile avatars.", 400);
  }
}

function validatePortablePath(path: string): void {
  validateProfilePackEntryPath(path);
  if (path.endsWith("/")) {
    throw new AtlasApiError("Portable module path must name a file.", 400);
  }
}

function isAllowlistedProfilePackPath(path: string): boolean {
  if (ROOT_ALLOWED_FILES.has(path)) {
    return true;
  }
  const [first, second] = path.split("/");
  return Boolean(first && second && ALLOWED_ROOT_SUBDIRS.has(first));
}

function isAvatarEntry(path: string): boolean {
  return !path.includes("/") && AVATAR_BASENAME_PATTERN.test(path);
}

function isManifestEntry(path: string): boolean {
  return (
    path === PROFILE_PACK_MANIFEST_FILENAME ||
    path === LEGACY_PROFILE_PACK_MANIFEST_FILENAME
  );
}

function portableToolsPath(absolutePath: string): string | null {
  const toolsDir = resolve(getCustomToolsDir());
  const relativePath = relative(toolsDir, resolve(absolutePath))
    .split("\\")
    .join("/");
  if (
    !relativePath ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  try {
    validatePortablePath(relativePath);
    return relativePath;
  } catch {
    return null;
  }
}

function readModulePath(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const modulePath = value.modulePath;
  return typeof modulePath === "string" && modulePath.trim()
    ? modulePath.trim()
    : null;
}

function validateJavaScriptSource(source: Buffer, name: string): void {
  try {
    const transpiler = new Bun.Transpiler({ loader: "js" });
    transpiler.transformSync(source.toString("utf8"));
  } catch (error) {
    throw new AtlasApiError(
      `Custom tool "${name}" is not valid JavaScript: ${error instanceof Error ? error.message : String(error)}`,
      400
    );
  }
}

function hasRelativeJavaScriptImports(source: Buffer): boolean {
  try {
    const sourceText = source.toString("utf8");
    const transpiler = new Bun.Transpiler({ loader: "js" });
    const scannedImports = transpiler.scan(sourceText).imports;
    if (scannedImports.some((entry) => entry.path.startsWith("."))) {
      return true;
    }

    // Bun omits computed dynamic imports from scan results. If more import()
    // expressions are present than Bun can resolve, their dependency graph is
    // unknown and therefore unsafe to relocate as a single-file tool.
    const dynamicImportCount = [...sourceText.matchAll(DYNAMIC_IMPORT_PATTERN)]
      .length;
    const resolvedDynamicImportCount = scannedImports.filter(
      (entry) => entry.kind === "dynamic-import"
    ).length;
    return dynamicImportCount > resolvedDynamicImportCount;
  } catch {
    // Invalid source is handled by import validation if it is ever restored.
    return false;
  }
}

function portableCustomToolDefinition(
  tool: StoredToolRecord,
  modulePath: string,
  parameters?: JsonSchema
): ProfilePackCustomTool {
  return {
    description: tool.description,
    handlerConfig: {
      modulePath,
      ...(parameters ? { parameters } : {}),
    },
    handlerType: "javascript",
    name: tool.name,
  };
}

function readPortableToolParameters(handlerConfig: unknown): {
  parameters?: JsonSchema;
  valid: boolean;
} {
  if (
    !(isRecord(handlerConfig) && Object.hasOwn(handlerConfig, "parameters"))
  ) {
    return { valid: true };
  }
  if (!isRecord(handlerConfig.parameters)) {
    return { valid: false };
  }

  try {
    const state = { bytes: 0, nodes: 0 };
    const parameters = cloneBoundedJson(handlerConfig.parameters, 0, state);
    if (!isRecord(parameters)) {
      return { valid: false };
    }
    if (
      Buffer.byteLength(JSON.stringify(parameters), "utf8") >
      MAX_CUSTOM_TOOL_SCHEMA_BYTES
    ) {
      return { valid: false };
    }
    return { parameters: parameters as JsonSchema, valid: true };
  } catch {
    return { valid: false };
  }
}

function cloneBoundedJson(
  value: unknown,
  depth: number,
  state: { bytes: number; nodes: number }
): unknown {
  state.nodes += 1;
  if (
    depth > MAX_CUSTOM_TOOL_SCHEMA_DEPTH ||
    state.nodes > MAX_CUSTOM_TOOL_SCHEMA_NODES
  ) {
    throw new Error("JSON value exceeds profile pack limits.");
  }

  if (value === null || typeof value === "boolean") {
    state.bytes += value === null ? 4 : 5;
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JSON numbers must be finite.");
    }
    state.bytes += String(value).length;
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8") + 2;
    assertPortableSchemaBudget(state.bytes);
    return value;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      result.push(cloneBoundedJson(entry, depth + 1, state));
    }
    return result;
  }
  if (!isPlainRecord(value)) {
    throw new Error("JSON objects must use a plain prototype.");
  }

  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, entry] of Object.entries(value)) {
    state.bytes += Buffer.byteLength(key, "utf8") + 3;
    assertPortableSchemaBudget(state.bytes);
    result[key] = cloneBoundedJson(entry, depth + 1, state);
  }
  return result;
}

function assertPortableSchemaBudget(bytes: number): void {
  if (bytes > MAX_CUSTOM_TOOL_SCHEMA_BYTES) {
    throw new Error("JSON value exceeds profile pack limits.");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readBoundedRegularFile(
  path: string,
  archivePath: string,
  existingTotalBytes: number
): Promise<Buffer> {
  // biome-ignore lint/suspicious/noBitwiseOperators: Node open flags are bit masks.
  const openFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await open(path, openFlags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new AtlasApiError(
        `Profile pack source is not a regular file: ${archivePath}`,
        400
      );
    }
    assertEntrySize(archivePath, metadata.size);
    assertTotalSize(existingTotalBytes + metadata.size);

    const chunks: Buffer[] = [];
    let totalRead = 0;
    while (true) {
      const entryBudget = MAX_ENTRY_BYTES - totalRead;
      const totalBudget = MAX_TOTAL_BYTES - existingTotalBytes - totalRead;
      const readSize = Math.max(
        1,
        Math.min(FILE_READ_CHUNK_BYTES, entryBudget + 1, totalBudget + 1)
      );
      const chunk = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(chunk, 0, readSize, null);
      if (bytesRead === 0) {
        break;
      }
      totalRead += bytesRead;
      assertEntrySize(archivePath, totalRead);
      assertTotalSize(existingTotalBytes + totalRead);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalRead);
  } finally {
    await handle.close();
  }
}

function assertEntrySize(path: string, size: number): void {
  if (size > MAX_ENTRY_BYTES) {
    throw new AtlasApiError(`Profile pack entry exceeds 25 MB: ${path}`, 413);
  }
}

function assertEntryCount(count: number): void {
  if (count > MAX_ENTRIES) {
    throw new AtlasApiError("Profile pack contains too many entries.", 413);
  }
}

function assertTotalSize(size: number): void {
  if (size > MAX_TOTAL_BYTES) {
    throw new AtlasApiError(
      "Profile pack expands beyond the 100 MB limit.",
      413
    );
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueSorted(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, MAX_ENTRIES)
  );
}

function readComposioToolkitAssignments(
  value: unknown
): ProfilePackComposioToolkitAssignment[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    return [];
  }

  const assignments = new Map<string, ProfilePackComposioToolkitAssignment>();
  for (const entry of value.slice(0, MAX_ENTRIES)) {
    if (!isRecord(entry)) {
      continue;
    }
    const toolkitSlug =
      typeof entry.toolkitSlug === "string" ? entry.toolkitSlug.trim() : "";
    if (!toolkitSlug) {
      continue;
    }
    const allowedActions =
      entry.allowedActions === null
        ? null
        : readStringArray(entry.allowedActions);
    const existing = assignments.get(toolkitSlug);
    if (!existing) {
      assignments.set(toolkitSlug, { allowedActions, toolkitSlug });
      continue;
    }

    // Duplicate records can only narrow a policy, never broaden one.
    if (existing.allowedActions === null) {
      existing.allowedActions = allowedActions;
    } else if (allowedActions !== null) {
      const nextAllowed = new Set(allowedActions);
      existing.allowedActions = existing.allowedActions.filter((action) =>
        nextAllowed.has(action)
      );
    }
  }
  return [...assignments.values()].sort((left, right) =>
    left.toolkitSlug.localeCompare(right.toolkitSlug)
  );
}

function getPortableComposioAssignments(
  manifest: ProfilePackManifest
): PortableComposioAssignment[] {
  const current = manifest.meta.composioToolkitAssignments;
  if (current === undefined) {
    return manifest.meta.composioToolkitSlugs.map((toolkitSlug) => ({
      allowedActions: undefined,
      toolkitSlug,
    }));
  }

  const assignedSlugs = new Set(
    current.map((assignment) => assignment.toolkitSlug)
  );
  return [
    ...current,
    ...manifest.meta.composioToolkitSlugs
      .filter((toolkitSlug) => !assignedSlugs.has(toolkitSlug))
      .map((toolkitSlug) => ({
        allowedActions: undefined,
        toolkitSlug,
      })),
  ];
}

function readNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readRequiredString(
  value: unknown,
  label: string,
  allowEmpty = false
): string {
  if (typeof value !== "string" || !(allowEmpty || value.trim())) {
    throw new AtlasApiError(`Profile pack ${label} is invalid.`, 400);
  }
  return value;
}

function readSkippedItems(value: unknown): ProfilePackSkippedItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (entry): entry is { path: string; reason: string } =>
        isRecord(entry) &&
        typeof entry.path === "string" &&
        typeof entry.reason === "string"
    )
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({ path: entry.path, reason: entry.reason }));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function getTopLevelPaths(paths: string[]): string[] {
  return uniqueSorted(
    paths.map((path) => path.split("/")[0] ?? "").filter(Boolean)
  );
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "unknown";
}

function isPathInside(target: string, directory: string): boolean {
  const relativePath = relative(directory, target);
  return (
    relativePath === "" ||
    !(relativePath.startsWith("..") || isAbsolute(relativePath))
  );
}

function customToolSkip(name: string, detail: string): ProfilePackSkippedItem {
  return {
    path: `custom tool:${name}`,
    reason: `Custom tool "${name}" ${detail}.`,
  };
}

function missingToolSkip(name: string): ProfilePackSkippedItem {
  return {
    path: `tool:${name}`,
    reason: `Tool "${name}" is unavailable in the destination.`,
  };
}

function legacyComposioPolicySkip(toolkitSlug: string): ProfilePackSkippedItem {
  return {
    path: `Composio toolkit:${toolkitSlug}`,
    reason: `Composio toolkit "${toolkitSlug}" was skipped because this legacy pack does not include its allowed-action policy.`,
  };
}

function emptyComposioPolicySkip(toolkitSlug: string): ProfilePackSkippedItem {
  return {
    path: `Composio toolkit:${toolkitSlug}`,
    reason: `Composio toolkit "${toolkitSlug}" was skipped because its packed allowed-action policy permits no actions.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBuffer(value: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
