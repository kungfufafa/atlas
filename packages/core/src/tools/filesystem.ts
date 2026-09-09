import {
  copyFile,
  mkdir,
  readdir,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../contract";
import { withProfileSoulMutationLock } from "../soul/mutation-lock";
import { getProfileSoulDir } from "../soul/resolve";
import {
  refuseProfileSkillMarkdownWrite,
  refuseSkillLocalToolFileWrite,
} from "./file-write-policy";
import {
  getCustomToolsDir,
  guardFilePath,
  type PathGuardOptions,
} from "./paths";
import {
  jsonSchemaFromZod,
  parseToolInput,
  requiredTrimmedString,
  trimmedOptionalString,
} from "./schema";

interface FileToolRunOptions {
  workspaceRoot?: string;
}

let defaultGuardOptions: PathGuardOptions = {};

export function setDefaultFilesystemGuardOptions(
  options: PathGuardOptions
): void {
  defaultGuardOptions = { ...options };
}

function requireProfileScope(context: ToolContext): {
  orgId: string;
  profileId: string;
} {
  const orgId = context.orgId?.trim();
  const profileId = context.profileId?.trim();

  if (!(orgId && profileId)) {
    throw new Error("orgId and profileId are required.");
  }

  return { orgId, profileId };
}

const SUPER_AGENT_PROFILE_ID = "super_agent";

export function fileToolAllowedDirs(
  workspaceRoot: string,
  profileId?: string
): string[] {
  if (profileId?.trim() === SUPER_AGENT_PROFILE_ID) {
    return [workspaceRoot, getCustomToolsDir()];
  }

  return [workspaceRoot];
}

function buildFileGuardOptions(
  context: ToolContext,
  options: FileToolRunOptions = {}
): PathGuardOptions {
  const { orgId, profileId } = requireProfileScope(context);
  const workspaceRoot =
    options.workspaceRoot ?? getProfileSoulDir(orgId, profileId);

  return {
    ...defaultGuardOptions,
    allowedDirs: fileToolAllowedDirs(workspaceRoot, profileId),
    cwd: workspaceRoot,
  };
}

async function resolveRealWorkspaceRoot(
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<string> {
  const { orgId, profileId } = requireProfileScope(context);
  const rawRoot = options.workspaceRoot ?? getProfileSoulDir(orgId, profileId);
  try {
    return await realpath(rawRoot);
  } catch {
    return path.resolve(rawRoot);
  }
}

// ---------------------------------------------------------------------------
// 1. list_directory
// ---------------------------------------------------------------------------

export const listDirectoryInputSchema = z
  .object({
    cwd: trimmedOptionalString,
    limit: z
      .number()
      .int()
      .min(1, "limit must be at least 1")
      .max(1000, "limit cannot exceed 1000")
      .optional()
      .default(100),
    path: z.string().optional().default("."),
    recursive: z.boolean().optional().default(false),
  })
  .strict();

export type ListDirectoryInput = z.infer<typeof listDirectoryInputSchema>;

export interface DirectoryEntry {
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt: string;
  name: string;
  path: string;
  size: number;
  type: "file" | "directory" | "other";
}

export interface ListDirectoryOutput {
  directory: string;
  entries: DirectoryEntry[];
  totalEntries: number;
  truncated: boolean;
}

export async function runListDirectory(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<ListDirectoryOutput> {
  const parsed = parseToolInput(listDirectoryInputSchema, input);
  const guardOptions = buildFileGuardOptions(context, options);

  const targetPath =
    parsed.path && parsed.path.trim() ? parsed.path.trim() : ".";
  const guarded = await guardFilePath(
    targetPath,
    parsed.cwd ?? null,
    undefined,
    guardOptions
  );

  const dirStat = await stat(guarded.resolved);
  if (!dirStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${guarded.resolved}`);
  }

  const workspaceRoot = await resolveRealWorkspaceRoot(context, options);

  const entries: DirectoryEntry[] = [];
  const limit = parsed.limit ?? 100;

  async function walk(currentDir: string): Promise<void> {
    const dirEntries = await readdir(currentDir, { withFileTypes: true });
    // Sort entries deterministically
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirEntries) {
      if (entries.length >= limit) {
        return;
      }

      const fullPath = path.join(currentDir, dirent.name);
      try {
        const itemStat = await stat(fullPath);
        const relPath = path.relative(workspaceRoot, fullPath);
        const isDir = itemStat.isDirectory();
        const isF = itemStat.isFile();

        entries.push({
          isDirectory: isDir,
          isFile: isF,
          modifiedAt: itemStat.mtime.toISOString(),
          name: dirent.name,
          path: relPath,
          size: itemStat.size,
          type: isDir ? "directory" : isF ? "file" : "other",
        });

        if (parsed.recursive && isDir) {
          await walk(fullPath);
        }
      } catch {
        // Skip unreadable entries
      }
    }
  }

  await walk(guarded.resolved);

  return {
    directory: path.relative(workspaceRoot, guarded.resolved) || ".",
    entries,
    totalEntries: entries.length,
    truncated: entries.length >= limit,
  };
}

export const listDirectoryTool: ToolDefinition<
  ListDirectoryInput,
  ListDirectoryOutput
> = {
  description:
    "List files and subdirectories in a directory within the profile workspace, returning file names, paths, sizes, types, and modification timestamps.",
  name: "list_directory",
  parallelSafe: true,
  parameters: jsonSchemaFromZod(listDirectoryInputSchema),
  run(input, context) {
    return runListDirectory(input, context);
  },
};

// ---------------------------------------------------------------------------
// 2. file_stat
// ---------------------------------------------------------------------------

export const fileStatInputSchema = z
  .object({
    cwd: trimmedOptionalString,
    path: requiredTrimmedString("path"),
  })
  .strict();

export type FileStatInput = z.infer<typeof fileStatInputSchema>;

export interface FileStatOutput {
  createdAt: string;
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt: string;
  name: string;
  path: string;
  size: number;
  type: "file" | "directory" | "other";
}

export async function runFileStat(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<FileStatOutput> {
  const parsed = parseToolInput(fileStatInputSchema, input);
  const guardOptions = buildFileGuardOptions(context, options);

  const guarded = await guardFilePath(
    parsed.path,
    parsed.cwd ?? null,
    undefined,
    guardOptions
  );

  const workspaceRoot = await resolveRealWorkspaceRoot(context, options);

  try {
    const itemStat = await stat(guarded.resolved);
    const isDir = itemStat.isDirectory();
    const isF = itemStat.isFile();

    return {
      createdAt: itemStat.birthtime.toISOString(),
      exists: true,
      isDirectory: isDir,
      isFile: isF,
      modifiedAt: itemStat.mtime.toISOString(),
      name: path.basename(guarded.resolved),
      path: path.relative(workspaceRoot, guarded.resolved),
      size: itemStat.size,
      type: isDir ? "directory" : isF ? "file" : "other",
    };
  } catch {
    return {
      createdAt: "",
      exists: false,
      isDirectory: false,
      isFile: false,
      modifiedAt: "",
      name: path.basename(guarded.resolved),
      path: path.relative(workspaceRoot, guarded.resolved),
      size: 0,
      type: "other",
    };
  }
}

export const fileStatTool: ToolDefinition<FileStatInput, FileStatOutput> = {
  description:
    "Get detailed metadata about a file or directory in the profile workspace (size, timestamps, type, existence).",
  name: "file_stat",
  parallelSafe: true,
  parameters: jsonSchemaFromZod(fileStatInputSchema),
  run(input, context) {
    return runFileStat(input, context);
  },
};

// ---------------------------------------------------------------------------
// 3. copy_file
// ---------------------------------------------------------------------------

export const copyFileInputSchema = z
  .object({
    cwd: trimmedOptionalString,
    destinationPath: requiredTrimmedString("destinationPath"),
    overwrite: z.boolean().optional().default(false),
    sourcePath: requiredTrimmedString("sourcePath"),
  })
  .strict();

export type CopyFileInput = z.infer<typeof copyFileInputSchema>;

export interface CopyFileOutput {
  bytesCopied: number;
  destinationPath: string;
  sourcePath: string;
}

export async function runCopyFile(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<CopyFileOutput> {
  const { orgId, profileId } = requireProfileScope(context);
  return await withProfileSoulMutationLock(orgId, profileId, () =>
    runCopyFileUnlocked(input, context, options)
  );
}

async function runCopyFileUnlocked(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions
): Promise<CopyFileOutput> {
  const parsed = parseToolInput(copyFileInputSchema, input);
  const guardOptions = buildFileGuardOptions(context, options);

  const guardedSrc = await guardFilePath(
    parsed.sourcePath,
    parsed.cwd ?? null,
    undefined,
    guardOptions
  );

  const srcStat = await stat(guardedSrc.resolved);
  if (!srcStat.isFile()) {
    throw new Error(`Source path is not a file: ${guardedSrc.resolved}`);
  }

  const guardedDest = await guardFilePath(
    parsed.destinationPath,
    parsed.cwd ?? null,
    srcStat.size,
    guardOptions
  );

  refuseProfileSkillMarkdownWrite(context, guardedDest.resolved);
  refuseSkillLocalToolFileWrite(guardedDest.resolved);

  if (!parsed.overwrite) {
    try {
      await stat(guardedDest.resolved);
      throw new Error(
        `Destination file already exists: ${parsed.destinationPath}. Set overwrite: true to replace.`
      );
    } catch (err: unknown) {
      if ((err as Error).message.includes("Destination file already exists")) {
        throw err;
      }
      // Otherwise file does not exist, proceed
    }
  }

  await mkdir(path.dirname(guardedDest.resolved), { recursive: true });
  await copyFile(guardedSrc.resolved, guardedDest.resolved);

  return {
    bytesCopied: srcStat.size,
    destinationPath: guardedDest.resolved,
    sourcePath: guardedSrc.resolved,
  };
}

export const copyFileTool: ToolDefinition<CopyFileInput, CopyFileOutput> = {
  description:
    "Copy a file from one location to another within the profile workspace.",
  name: "copy_file",
  parameters: jsonSchemaFromZod(copyFileInputSchema),
  run(input, context) {
    return runCopyFile(input, context);
  },
};

// ---------------------------------------------------------------------------
// 4. move_file
// ---------------------------------------------------------------------------

export const moveFileInputSchema = z
  .object({
    cwd: trimmedOptionalString,
    destinationPath: requiredTrimmedString("destinationPath"),
    overwrite: z.boolean().optional().default(false),
    sourcePath: requiredTrimmedString("sourcePath"),
  })
  .strict();

export type MoveFileInput = z.infer<typeof moveFileInputSchema>;

export interface MoveFileOutput {
  destinationPath: string;
  moved: true;
  sourcePath: string;
}

export async function runMoveFile(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<MoveFileOutput> {
  const { orgId, profileId } = requireProfileScope(context);
  return await withProfileSoulMutationLock(orgId, profileId, () =>
    runMoveFileUnlocked(input, context, options)
  );
}

async function runMoveFileUnlocked(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions
): Promise<MoveFileOutput> {
  const parsed = parseToolInput(moveFileInputSchema, input);
  const guardOptions = buildFileGuardOptions(context, options);

  const guardedSrc = await guardFilePath(
    parsed.sourcePath,
    parsed.cwd ?? null,
    undefined,
    guardOptions
  );

  refuseProfileSkillMarkdownWrite(context, guardedSrc.resolved);
  refuseSkillLocalToolFileWrite(guardedSrc.resolved);

  const srcStat = await stat(guardedSrc.resolved);

  const guardedDest = await guardFilePath(
    parsed.destinationPath,
    parsed.cwd ?? null,
    srcStat.size,
    guardOptions
  );

  refuseProfileSkillMarkdownWrite(context, guardedDest.resolved);
  refuseSkillLocalToolFileWrite(guardedDest.resolved);

  if (!parsed.overwrite) {
    try {
      await stat(guardedDest.resolved);
      throw new Error(
        `Destination file already exists: ${parsed.destinationPath}. Set overwrite: true to replace.`
      );
    } catch (err: unknown) {
      if ((err as Error).message.includes("Destination file already exists")) {
        throw err;
      }
    }
  }

  await mkdir(path.dirname(guardedDest.resolved), { recursive: true });
  await rename(guardedSrc.resolved, guardedDest.resolved);

  return {
    destinationPath: guardedDest.resolved,
    moved: true,
    sourcePath: guardedSrc.resolved,
  };
}

export const moveFileTool: ToolDefinition<MoveFileInput, MoveFileOutput> = {
  description:
    "Move or rename a file or directory within the profile workspace.",
  name: "move_file",
  parameters: jsonSchemaFromZod(moveFileInputSchema),
  run(input, context) {
    return runMoveFile(input, context);
  },
};

// ---------------------------------------------------------------------------
// 5. create_directory
// ---------------------------------------------------------------------------

export const createDirectoryInputSchema = z
  .object({
    cwd: trimmedOptionalString,
    path: requiredTrimmedString("path"),
  })
  .strict();

export type CreateDirectoryInput = z.infer<typeof createDirectoryInputSchema>;

export interface CreateDirectoryOutput {
  created: true;
  path: string;
}

export async function runCreateDirectory(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<CreateDirectoryOutput> {
  const { orgId, profileId } = requireProfileScope(context);
  return await withProfileSoulMutationLock(orgId, profileId, () =>
    runCreateDirectoryUnlocked(input, context, options)
  );
}

async function runCreateDirectoryUnlocked(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions
): Promise<CreateDirectoryOutput> {
  const parsed = parseToolInput(createDirectoryInputSchema, input);
  const guardOptions = buildFileGuardOptions(context, options);

  const guarded = await guardFilePath(
    parsed.path,
    parsed.cwd ?? null,
    undefined,
    guardOptions
  );

  refuseProfileSkillMarkdownWrite(context, guarded.resolved);
  refuseSkillLocalToolFileWrite(guarded.resolved);

  await mkdir(guarded.resolved, { recursive: true });

  const workspaceRoot = await resolveRealWorkspaceRoot(context, options);

  return {
    created: true,
    path: path.relative(workspaceRoot, guarded.resolved) || ".",
  };
}

export const createDirectoryTool: ToolDefinition<
  CreateDirectoryInput,
  CreateDirectoryOutput
> = {
  description:
    "Create a directory (including parent directories) within the profile workspace.",
  name: "create_directory",
  parameters: jsonSchemaFromZod(createDirectoryInputSchema),
  run(input, context) {
    return runCreateDirectory(input, context);
  },
};
