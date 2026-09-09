import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isDocxFile, isLegacyDocFile } from "../artifact-mime";
import { coerceDeliverableArtifactPath } from "../artifact-path";
import {
  isArtifactPublicationPath,
  stageToolArtifact,
} from "../artifact-publication";
import type { ToolContext, ToolDefinition } from "../contract";
import { convertDocxToMarkdown } from "../docx-text";
import { markdownToDocx } from "../docx-write";
import { loadFileAsset } from "../files/assets";
import { writeNewArtifactVersion } from "../files/versioned-write";
import { MAX_DOCUMENT_INGEST_BYTES } from "../message-content-limits";
import { isOmniEnabled, omniRetrieveTool } from "../omni";
import { createPptxBuffer } from "../presentation-engine";
import { withProfileSoulMutationLock } from "../soul/mutation-lock";
import { getProfileSoulDir } from "../soul/resolve";
import { browserTool } from "./browser-tool";
import { calculatorTool } from "./calculator";
import { channelActionTool } from "./channel-action";
import { deepResearchTool } from "./deep-research";
import { emailTool } from "./email";
import { extractDocumentTextTool } from "./extract-document-text";
import { fileAssetTool } from "./file-asset";
import {
  refuseProfileSkillMarkdownWrite,
  refuseSkillLocalToolFileWrite,
} from "./file-write-policy";
import {
  copyFileTool,
  createDirectoryTool,
  fileStatTool,
  fileToolAllowedDirs,
  listDirectoryTool,
  moveFileTool,
} from "./filesystem";
import { knowledgeBaseSearchTool } from "./knowledge-base-search";
import { officeDocumentTool } from "./office-document";
import { guardFilePath, PathGuardError, type PathGuardOptions } from "./paths";
import { pdfDocumentTool } from "./pdf-document";
import {
  jsonSchemaFromZod,
  parseToolInput,
  readFileLimitSchema,
  readFileOffsetSchema,
  requiredTrimmedString,
  trimmedOptionalString,
} from "./schema";
import { searchFilesTool } from "./search-files";
import { sendWhatsAppTool } from "./send-whatsapp";
import { spreadsheetTool } from "./spreadsheet";
import { webFetchTool } from "./web-fetch";
import { webSearchTool } from "./web-search";
import { writePptxInputSchema, writePptxTool } from "./write-pptx";

export const writeFileInputSchema = z
  .object({
    content: z.string({ error: "content is required." }),
    cwd: trimmedOptionalString,
    deliverable: z
      .boolean()
      .optional()
      .describe(
        "Publish this completed user deliverable under artifacts/. Omit for intermediate or support files."
      ),
    path: requiredTrimmedString("path"),
  })
  .strict();

export const writeDocxInputSchema = z
  .object({
    cwd: trimmedOptionalString,
    markdown: requiredTrimmedString("markdown"),
    path: requiredTrimmedString("path").describe(
      "Path ending in .docx under artifacts/ (e.g. artifacts/report.docx)"
    ),
  })
  .strict();

export const deleteFileInputSchema = z
  .object({
    cwd: trimmedOptionalString,
    path: requiredTrimmedString("path"),
  })
  .strict();

export const editFileInputSchema = z
  .object({
    cwd: trimmedOptionalString,
    deliverable: z
      .boolean()
      .optional()
      .describe(
        "Publish this completed user deliverable under artifacts/. Omit for intermediate or support files."
      ),
    edits: z
      .array(
        z
          .object({
            newText: z.string({ error: "newText is required." }),
            oldText: requiredTrimmedString("oldText"),
          })
          .strict()
      )
      .min(1, "edits must contain at least one replacement."),
    path: requiredTrimmedString("path"),
  })
  .strict();

export const readFileInputSchema = z
  .object({
    cwd: trimmedOptionalString,
    limit: readFileLimitSchema,
    offset: readFileOffsetSchema,
    path: requiredTrimmedString("path"),
  })
  .strict();

export type WriteFileInput = z.infer<typeof writeFileInputSchema>;
export type WriteDocxInput = z.infer<typeof writeDocxInputSchema>;
export type DeleteFileInput = z.infer<typeof deleteFileInputSchema>;
export type EditFileInput = z.infer<typeof editFileInputSchema>;
export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export interface WriteFileOutput {
  bytesWritten: number;
  path: string;
}

export interface DeleteFileOutput {
  deleted: true;
  path: string;
}

export interface EditFileOutput {
  bytesWritten: number;
  fuzzyMatches: number;
  path: string;
  replacements: number;
}

export interface ReadFileOutput {
  bytesRead: number;
  content: string;
  endLine: number;
  path: string;
  startLine: number;
  totalLines: number;
  truncated: boolean;
}

interface FileToolRunOptions {
  workspaceRoot?: string;
}

let defaultGuardOptions: PathGuardOptions = {};

const BLOCKED_READ_BASENAMES = ["config.ini"];
const ARTIFACT_META_SUFFIX = ".atlas-meta.json";
const artifactRemap = new Map<string, string>();

async function publicationRoot(options: PathGuardOptions): Promise<string> {
  return (await guardFilePath(".", null, undefined, options)).resolved;
}

function requireDeliverableDestination(filePath: string, root: string): void {
  if (
    !isArtifactPublicationPath(
      path.relative(root, filePath).split(path.sep).join("/")
    )
  ) {
    throw new Error(
      "deliverable requires a visible content file under artifacts/ in the profile workspace."
    );
  }
}

async function isArtifactDestination(
  resolvedPath: string,
  options: PathGuardOptions
): Promise<boolean> {
  const root = await guardFilePath(".", null, undefined, options);
  const relative = path.relative(root.resolved, resolvedPath);
  return (
    !(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) &&
    path.dirname(relative).split(path.sep).includes("artifacts") &&
    !resolvedPath.endsWith(ARTIFACT_META_SUFFIX)
  );
}

function artifactRemapKey(
  context: ToolContext,
  resolvedContentPath: string
): string {
  return JSON.stringify([
    context.orgId,
    context.profileId,
    context.sessionId ?? "default",
    resolvedContentPath,
  ]);
}

export function setDefaultFileGuardOptions(options: PathGuardOptions): void {
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

export { refuseProfileSkillMarkdownWrite, refuseSkillLocalToolFileWrite };

function buildFileGuardOptions(
  context: ToolContext,
  options: FileToolRunOptions = {}
): PathGuardOptions {
  const { orgId, profileId } = requireProfileScope(context);
  const workspaceRoot =
    options.workspaceRoot ??
    context.workspaceRoot ??
    getProfileSoulDir(orgId, profileId);
  assertAbsoluteWorkspaceRoot(workspaceRoot);

  return {
    ...defaultGuardOptions,
    allowedDirs: fileToolAllowedDirs(workspaceRoot, profileId),
    cwd: workspaceRoot,
  };
}

function assertAbsoluteWorkspaceRoot(workspaceRoot: string): void {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error(
      "workspaceRoot must be an absolute path; relative roots resolve against process.cwd() and break profile isolation."
    );
  }
}

export const writeFileTool: ToolDefinition<WriteFileInput, WriteFileOutput> = {
  description:
    "Write text content to a file in the active profile workspace. Creates parent directories if needed. Cannot produce Word documents — use write_docx for .docx.",
  name: "write_file",
  parameters: jsonSchemaFromZod(writeFileInputSchema),
  run(input, context) {
    return runWriteFile(input, context);
  },
};

/**
 * A `.docx` is a ZIP archive and a `.doc` is an OLE container; neither can be written
 * as UTF-8 text. Left unguarded, a model asked for a Word document saves HTML under a
 * `.docx` name, and Word then renders the stylesheet as visible text.
 */
function refuseWordExtension(targetPath: string): void {
  const filename = path.basename(targetPath);

  const binaryWriters: Record<string, string> = {
    ".pdf": "pdf_document",
    ".ppt": "write_pptx to create .pptx",
    ".pptx": "write_pptx or office_document",
    ".xls": "spreadsheet to create .xlsx",
    ".xlsb": "spreadsheet to create .xlsx",
    ".xlsm": "spreadsheet to create .xlsx",
    ".xlsx": "spreadsheet",
    ".zip": "a ZIP library through an assigned compute tool",
  };
  const writer = binaryWriters[path.extname(filename).toLowerCase()];
  if (writer) {
    throw new Error(
      `This is a binary format; UTF-8 text writes would corrupt it. Use ${writer}.`
    );
  }

  if (isDocxFile(filename)) {
    throw new Error(
      "write_file writes UTF-8 text and cannot produce a valid .docx (it is a ZIP archive). Use the write_docx tool with Markdown content instead."
    );
  }

  if (isLegacyDocFile(filename)) {
    throw new Error(
      "write_file cannot produce a valid .doc. Use the write_docx tool to create a .docx instead."
    );
  }
}

export async function runWriteFile(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<WriteFileOutput> {
  const { orgId, profileId } = requireProfileScope(context);
  return await withProfileSoulMutationLock(orgId, profileId, () =>
    runWriteFileUnlocked(input, context, options)
  );
}

async function runWriteFileUnlocked(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions
): Promise<WriteFileOutput> {
  const parsed = parseToolInput(writeFileInputSchema, input);
  refuseWordExtension(parsed.path);
  const contentBytes = Buffer.byteLength(parsed.content, "utf8");
  const guardOptions = buildFileGuardOptions(context, options);

  const guarded = await guardFilePath(
    parsed.path,
    parsed.cwd ?? null,
    contentBytes,
    guardOptions
  );
  refuseProfileSkillMarkdownWrite(context, guarded.resolved);
  refuseSkillLocalToolFileWrite(guarded.resolved);
  const publishRoot = await publicationRoot(guardOptions);
  if (parsed.deliverable) {
    requireDeliverableDestination(guarded.resolved, publishRoot);
  }
  let filePath = guarded.resolved;
  const isSidecar = filePath.endsWith(ARTIFACT_META_SUFFIX);
  const originalContentPath = isSidecar
    ? filePath.slice(0, -ARTIFACT_META_SUFFIX.length)
    : filePath;
  const artifact = await isArtifactDestination(
    originalContentPath,
    guardOptions
  );

  if (isSidecar && artifact) {
    const remapped = artifactRemap.get(
      artifactRemapKey(context, originalContentPath)
    );
    if (remapped) {
      const remappedGuard = await guardFilePath(
        `${remapped}${ARTIFACT_META_SUFFIX}`,
        null,
        contentBytes,
        guardOptions
      );
      filePath = remappedGuard.resolved;
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  let contentToWrite = parsed.content;
  if (isSidecar) {
    const { readLineageMeta } = await import("../artifact-lineage");
    const contentFile = filePath.endsWith(ARTIFACT_META_SUFFIX)
      ? filePath.slice(0, -ARTIFACT_META_SUFFIX.length)
      : filePath;
    const previous = await readLineageMeta(contentFile);
    if (previous) {
      try {
        const payload = JSON.parse(parsed.content) as Record<string, unknown>;
        contentToWrite = JSON.stringify({
          ...payload,
          formatDetails: {
            ...previous.formatDetails,
            ...(payload.formatDetails &&
            typeof payload.formatDetails === "object"
              ? payload.formatDetails
              : {}),
          },
          id: previous.id,
          parentArtifactId: previous.parentArtifactId,
          revision: previous.revision,
          rootArtifactId: previous.rootArtifactId,
        });
      } catch {
        // Sidecar is not JSON; write as-is and stamp afterwards.
      }
    }
  }
  if (artifact && !isSidecar) {
    filePath = await writeNewArtifactVersion(
      filePath,
      contentToWrite,
      context.signal
    );
    artifactRemap.set(artifactRemapKey(context, guarded.resolved), filePath);
  } else {
    await writeFile(filePath, contentToWrite, "utf8");
  }

  if (artifact) {
    const { stampArtifactLineage } = await import("../artifact-lineage");
    const parentFilePath =
      isSidecar || filePath === guarded.resolved ? undefined : guarded.resolved;
    const contentPath = filePath.endsWith(ARTIFACT_META_SUFFIX)
      ? filePath.slice(0, -ARTIFACT_META_SUFFIX.length)
      : filePath;
    let stampSize = contentBytes;
    if (filePath.endsWith(ARTIFACT_META_SUFFIX)) {
      try {
        stampSize = (await stat(contentPath)).size;
      } catch {
        stampSize = contentBytes;
      }
    }
    await stampArtifactLineage({
      parentFilePath,
      sizeBytes: stampSize,
      writtenPath: contentPath,
    });
  }

  if (parsed.deliverable && !isSidecar) {
    await stageToolArtifact(context.artifactPublisher, {
      bytes: Buffer.from(contentToWrite, "utf8"),
      sourcePath: path
        .relative(publishRoot, filePath)
        .split(path.sep)
        .join("/"),
    });
  }
  return { bytesWritten: contentBytes, path: filePath };
}

export const writeDocxTool: ToolDefinition<WriteDocxInput, WriteFileOutput> = {
  description:
    "Create a real Microsoft Word (.docx) document from Markdown. Headings, bold/italic, lists, tables, and code blocks are converted. Use this whenever the user asks for a Word document — write_file cannot produce one.",
  name: "write_docx",
  parameters: jsonSchemaFromZod(writeDocxInputSchema),
  run(input, context) {
    return runWriteDocx(input, context);
  },
};

export async function runWriteDocx(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<WriteFileOutput> {
  const { orgId, profileId } = requireProfileScope(context);
  return withProfileSoulMutationLock(orgId, profileId, () =>
    runWriteDocxUnlocked(input, context, options)
  );
}

async function runWriteDocxUnlocked(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions
): Promise<WriteFileOutput> {
  const parsed = parseToolInput(writeDocxInputSchema, input);
  const relativePath = coerceDeliverableArtifactPath(parsed.path);

  if (!isDocxFile(path.basename(relativePath))) {
    throw new Error("write_docx requires a path ending in .docx");
  }

  const bytes = await markdownToDocx(parsed.markdown, {
    resolveImage: (reference) =>
      loadFileAsset(reference, context, {
        allowedExtensions: [".png", ".jpg", ".jpeg", ".gif"],
        maxBytes: 8 * 1024 * 1024,
      }),
  });
  const guardOptions = buildFileGuardOptions(context, options);
  const guarded = await guardFilePath(
    relativePath,
    parsed.cwd ?? null,
    bytes.length,
    guardOptions
  );
  refuseProfileSkillMarkdownWrite(context, guarded.resolved);
  refuseSkillLocalToolFileWrite(guarded.resolved);
  const publishRoot = await publicationRoot(guardOptions);
  // Same rule as write_file: never silently overwrite an existing artifact.
  await mkdir(path.dirname(guarded.resolved), { recursive: true });
  const artifact = await isArtifactDestination(guarded.resolved, guardOptions);
  const filePath = artifact
    ? await writeNewArtifactVersion(guarded.resolved, bytes, context.signal)
    : guarded.resolved;
  if (!artifact) {
    await writeFile(filePath, bytes);
  }

  if (artifact) {
    const { stampArtifactLineage } = await import("../artifact-lineage");
    await stampArtifactLineage({
      parentFilePath:
        filePath === guarded.resolved ? undefined : guarded.resolved,
      sizeBytes: bytes.length,
      writtenPath: filePath,
    });
  }

  await stageToolArtifact(context.artifactPublisher, {
    bytes,
    sourcePath: path.relative(publishRoot, filePath).split(path.sep).join("/"),
  });
  return { bytesWritten: bytes.length, path: filePath };
}

export async function runWritePptx(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<{ bytesWritten: number; path: string; slideCount: number }> {
  const { orgId, profileId } = requireProfileScope(context);
  return withProfileSoulMutationLock(orgId, profileId, () =>
    runWritePptxUnlocked(input, context, options)
  );
}

async function runWritePptxUnlocked(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions
): Promise<{ bytesWritten: number; path: string; slideCount: number }> {
  const parsed = parseToolInput(writePptxInputSchema, input);

  const relativePath = coerceDeliverableArtifactPath(parsed.path);

  if (!relativePath.toLowerCase().endsWith(".pptx")) {
    throw new Error("write_pptx requires a path ending in .pptx");
  }

  const bytes = await createPptxBuffer({
    author: parsed.author,
    company: parsed.company,
    slides: parsed.slides,
    themeColor: parsed.themeColor || "3B82F6",
    title: parsed.title,
  });

  const guardOptions = buildFileGuardOptions(context, options);
  const guarded = await guardFilePath(
    relativePath,
    parsed.cwd ?? null,
    bytes.length,
    guardOptions
  );
  refuseProfileSkillMarkdownWrite(context, guarded.resolved);
  refuseSkillLocalToolFileWrite(guarded.resolved);

  const publishRoot = await publicationRoot(guardOptions);
  await mkdir(path.dirname(guarded.resolved), { recursive: true });
  const artifact = await isArtifactDestination(guarded.resolved, guardOptions);
  const filePath = artifact
    ? await writeNewArtifactVersion(guarded.resolved, bytes, context.signal)
    : guarded.resolved;
  if (!artifact) {
    await writeFile(filePath, bytes);
  }

  if (artifact) {
    const { stampArtifactLineage } = await import("../artifact-lineage");
    await stampArtifactLineage({
      extraDetails: { slideCount: parsed.slides.length },
      parentFilePath:
        filePath === guarded.resolved ? undefined : guarded.resolved,
      sizeBytes: bytes.length,
      writtenPath: filePath,
    });
  }

  await stageToolArtifact(context.artifactPublisher, {
    bytes,
    sourcePath: path.relative(publishRoot, filePath).split(path.sep).join("/"),
  });
  return {
    bytesWritten: bytes.length,
    path: filePath,
    slideCount: parsed.slides.length,
  };
}

export const deleteFileTool: ToolDefinition<DeleteFileInput, DeleteFileOutput> =
  {
    description:
      "Delete a file from disk. Only files within the profile workspace or custom tools directory can be deleted.",
    name: "delete_file",
    parameters: jsonSchemaFromZod(deleteFileInputSchema),
    run(input, context) {
      return runDeleteFile(input, context);
    },
  };

export async function runDeleteFile(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<DeleteFileOutput> {
  const { orgId, profileId } = requireProfileScope(context);
  return await withProfileSoulMutationLock(orgId, profileId, () =>
    runDeleteFileUnlocked(input, context, options)
  );
}

async function runDeleteFileUnlocked(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions
): Promise<DeleteFileOutput> {
  const parsed = parseToolInput(deleteFileInputSchema, input);
  const guardOptions = buildFileGuardOptions(context, options);

  const guarded = await guardFilePath(
    parsed.path,
    parsed.cwd ?? null,
    undefined,
    guardOptions
  );
  refuseProfileSkillMarkdownWrite(context, guarded.resolved);
  refuseSkillLocalToolFileWrite(guarded.resolved);
  await unlink(guarded.resolved);

  return { deleted: true, path: guarded.resolved };
}

export const editFileTool: ToolDefinition<EditFileInput, EditFileOutput> = {
  description:
    "Edit an existing text file with one or more exact replacements. Each oldText must be present once, non-overlapping, and is matched against the original file.",
  name: "edit_file",
  parameters: jsonSchemaFromZod(editFileInputSchema),
  run(input, context) {
    return runEditFile(input, context);
  },
};

export async function runEditFile(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<EditFileOutput> {
  const { orgId, profileId } = requireProfileScope(context);
  return await withProfileSoulMutationLock(orgId, profileId, () =>
    runEditFileUnlocked(input, context, options)
  );
}

async function runEditFileUnlocked(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions
): Promise<EditFileOutput> {
  const parsed = parseToolInput(editFileInputSchema, input);
  // Editing a Word document as UTF-8 text would corrupt the archive.
  refuseWordExtension(parsed.path);

  const guardOptions = buildFileGuardOptions(context, options);
  const maxBytes = guardOptions.maxFileBytes ?? 10 * 1024 * 1024;
  const guarded = await guardFilePath(
    parsed.path,
    parsed.cwd ?? null,
    undefined,
    guardOptions
  );
  refuseProfileSkillMarkdownWrite(context, guarded.resolved);
  refuseSkillLocalToolFileWrite(guarded.resolved);
  const filePath = guarded.resolved;

  if (BLOCKED_READ_BASENAMES.includes(path.basename(filePath).toLowerCase())) {
    throw new PathGuardError(
      `Editing ${path.basename(filePath)} is not allowed`,
      "SPECIAL_FILE"
    );
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  if (!fileStat.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  if (fileStat.size > maxBytes) {
    throw new PathGuardError(
      `File content exceeds max ${maxBytes} bytes (got ${fileStat.size})`,
      "TOO_LARGE"
    );
  }

  const publishRoot = await publicationRoot(guardOptions);
  if (parsed.deliverable) {
    requireDeliverableDestination(filePath, publishRoot);
  }
  const rawBuffer = await readFile(filePath);
  const hasBom =
    rawBuffer.length >= 3 &&
    rawBuffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const content = rawBuffer.toString("utf8", hasBom ? 3 : 0);
  const lineEnding = detectLineEnding(content);
  const plans = parsed.edits
    .map((edit, index) => planEdit(content, edit, index, lineEnding))
    .sort((a, b) => a.start - b.start);
  assertNoOverlappingEdits(plans);

  const nextContent = applyEditPlans(content, plans);
  const outputContent = hasBom ? `\uFEFF${nextContent}` : nextContent;
  const bytesWritten = Buffer.byteLength(outputContent, "utf8");

  await guardFilePath(
    parsed.path,
    parsed.cwd ?? null,
    bytesWritten,
    guardOptions
  );
  await writeFile(filePath, outputContent, "utf8");
  if (parsed.deliverable) {
    await stageToolArtifact(context.artifactPublisher, {
      bytes: Buffer.from(outputContent, "utf8"),
      sourcePath: path
        .relative(publishRoot, filePath)
        .split(path.sep)
        .join("/"),
    });
  }

  return {
    bytesWritten,
    fuzzyMatches: plans.filter((plan) => plan.fuzzy).length,
    path: filePath,
    replacements: plans.length,
  };
}

interface PlannedEdit {
  end: number;
  fuzzy: boolean;
  index: number;
  newText: string;
  start: number;
}

function planEdit(
  content: string,
  edit: EditFileInput["edits"][number],
  index: number,
  lineEnding: string
): PlannedEdit {
  if (edit.oldText === edit.newText) {
    throw new Error(
      `Edit ${index + 1} makes no change: oldText and newText are identical.`
    );
  }

  const exactMatches = findAllOccurrences(content, edit.oldText);

  if (exactMatches.length > 1) {
    throw new Error(
      `Edit ${index + 1} is ambiguous: oldText matched ${exactMatches.length} times.`
    );
  }

  if (exactMatches.length === 1) {
    const start = exactMatches[0]!;
    return {
      end: start + edit.oldText.length,
      fuzzy: false,
      index,
      newText: normalizeReplacementLineEndings(edit.newText, lineEnding),
      start,
    };
  }

  const fuzzyMatches = findNormalizedMatches(content, edit.oldText);

  if (fuzzyMatches.length === 0) {
    throw new Error(`Edit ${index + 1} oldText not found in file.`);
  }

  if (fuzzyMatches.length > 1) {
    throw new Error(
      `Edit ${index + 1} is ambiguous after normalized matching.`
    );
  }

  const match = fuzzyMatches[0]!;

  return {
    end: match.end,
    fuzzy: true,
    index,
    newText: normalizeReplacementLineEndings(edit.newText, lineEnding),
    start: match.start,
  };
}

function detectLineEnding(content: string): string {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lf = content.match(/(?<!\r)\n/g)?.length ?? 0;
  const cr = content.match(/\r(?!\n)/g)?.length ?? 0;

  if (crlf >= lf && crlf >= cr && crlf > 0) {
    return "\r\n";
  }

  if (cr > lf && cr > 0) {
    return "\r";
  }

  return "\n";
}

function normalizeReplacementLineEndings(
  value: string,
  lineEnding: string
): string {
  return value.replace(/\r\n|\r|\n/g, lineEnding);
}

function findAllOccurrences(content: string, search: string): number[] {
  const matches: number[] = [];
  let index = 0;

  while (true) {
    index = content.indexOf(search, index);
    if (index === -1) {
      return matches;
    }
    matches.push(index);
    index += search.length;
  }
}

interface NormalizedMatch {
  end: number;
  start: number;
}

interface NormalizedChar {
  char: string;
  end: number;
  start: number;
}

function findNormalizedMatches(
  content: string,
  search: string
): NormalizedMatch[] {
  const normalizedContent = normalizeForEditMatch(content);
  const normalizedSearch = normalizeForEditMatch(search);
  const needle = normalizedSearch.text;

  if (!needle) {
    return [];
  }

  const matches: NormalizedMatch[] = [];
  let index = 0;

  while (true) {
    index = normalizedContent.text.indexOf(needle, index);
    if (index === -1) {
      return matches;
    }

    const firstChar = normalizedContent.chars[index];
    const lastChar = normalizedContent.chars[index + needle.length - 1];

    if (firstChar && lastChar) {
      matches.push({ end: lastChar.end, start: firstChar.start });
    }

    index += needle.length;
  }
}

function normalizeForEditMatch(value: string): {
  text: string;
  chars: NormalizedChar[];
} {
  const chars: NormalizedChar[] = [];

  for (let index = 0; index < value.length; ) {
    const start = index;
    const codePoint = value.codePointAt(index);

    if (codePoint === undefined) {
      break;
    }

    const rawChar = String.fromCodePoint(codePoint);
    index += rawChar.length;
    const normalizedChar = normalizeEditChar(rawChar);

    if (normalizedChar === null) {
      continue;
    }

    chars.push({ char: normalizedChar, end: index, start });
  }

  const filteredChars = removeTrailingWhitespaceTokens(chars);

  return {
    chars: filteredChars,
    text: filteredChars.map((char) => char.char).join(""),
  };
}

function normalizeEditChar(char: string): string | null {
  if (char === "\r") {
    return null;
  }

  if (char === "\u00A0") {
    return " ";
  }

  if (char === "\u2018" || char === "\u2019") {
    return "'";
  }

  if (char === "\u201C" || char === "\u201D") {
    return '"';
  }

  if (char === "\u2013" || char === "\u2014") {
    return "-";
  }

  return char;
}

function removeTrailingWhitespaceTokens(
  chars: NormalizedChar[]
): NormalizedChar[] {
  const keep = new Array<boolean>(chars.length).fill(true);
  let runStart: number | null = null;

  for (let index = 0; index <= chars.length; index += 1) {
    const char = chars[index]?.char;

    if (char === " " || char === "\t") {
      runStart ??= index;
      continue;
    }

    if ((char === "\n" || char === undefined) && runStart !== null) {
      for (let runIndex = runStart; runIndex < index; runIndex += 1) {
        keep[runIndex] = false;
      }
    }

    runStart = null;
  }

  return chars.filter((_char, index) => keep[index]);
}

function assertNoOverlappingEdits(plans: PlannedEdit[]): void {
  // Caller sorts by start before invoking; only overlap is still possible.
  for (let index = 1; index < plans.length; index += 1) {
    const previous = plans[index - 1];
    const current = plans[index];
    if (previous === undefined || current === undefined) {
      throw new Error("Edit plans must be a contiguous list.");
    }

    if (current.start < previous.end) {
      throw new Error(
        `Edit ${current.index + 1} overlaps with edit ${previous.index + 1}.`
      );
    }
  }
}

function applyEditPlans(content: string, plans: PlannedEdit[]): string {
  let nextContent = "";
  let cursor = 0;

  for (const plan of plans) {
    nextContent += content.slice(cursor, plan.start);
    nextContent += plan.newText;
    cursor = plan.end;
  }

  nextContent += content.slice(cursor);
  return nextContent;
}

/**
 * Word documents are ZIP archives, not UTF-8, so decoding them as text yields
 * mojibake. Convert `.docx` to Markdown instead, which keeps headings and tables
 * legible to the model while still being plain text to every caller downstream.
 */
async function readFileAsText(filePath: string): Promise<string> {
  const filename = path.basename(filePath);

  // Word-named files are judged by their bytes: a real .docx archive, a legacy OLE
  // .doc, or (commonly) HTML that an agent saved under a Word extension.
  if (isDocxFile(filename) || isLegacyDocFile(filename)) {
    return convertDocxToMarkdown(await readFile(filePath));
  }

  if (/\.(pdf|pptx|ppt|xlsx|xls|xlsm|xlsb|zip)$/i.test(filename)) {
    throw new Error(
      "Use pdf_document for PDF, office_document for DOCX/PPTX, spreadsheet for Excel, or extract_document_text. read_file cannot decode this binary format as UTF-8."
    );
  }
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) {
    throw new Error(
      "This file contains binary data. Use a reader for its format."
    );
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export const readFileTool: ToolDefinition<ReadFileInput, ReadFileOutput> = {
  description:
    "Read text from a file in the active profile workspace. Word .docx files are converted to Markdown. Use offset/limit for large files.",
  name: "read_file",
  parallelSafe: true,
  parameters: jsonSchemaFromZod(readFileInputSchema),
  run(input, context) {
    return runReadFile(input, context);
  },
};

export async function runReadFile(
  input: unknown,
  context: ToolContext,
  options: FileToolRunOptions = {}
): Promise<ReadFileOutput> {
  const parsed = parseToolInput(readFileInputSchema, input);
  const guardOptions = buildFileGuardOptions(context, options);
  const isMessagingChannel =
    context.channel === "whatsapp" ||
    context.channel === "telegram" ||
    context.channel === "discord";
  const maxBytes =
    guardOptions.maxFileBytes ??
    (isMessagingChannel ? MAX_DOCUMENT_INGEST_BYTES : 10 * 1024 * 1024);

  const guarded = await guardFilePath(
    parsed.path,
    parsed.cwd ?? null,
    undefined,
    guardOptions
  );
  const filePath = guarded.resolved;

  if (BLOCKED_READ_BASENAMES.includes(path.basename(filePath).toLowerCase())) {
    throw new PathGuardError(
      `Reading ${path.basename(filePath)} is not allowed`,
      "SPECIAL_FILE"
    );
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  if (!fileStat.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  if (fileStat.size > maxBytes) {
    throw new PathGuardError(
      `File content exceeds max ${maxBytes} bytes (got ${fileStat.size})`,
      "TOO_LARGE"
    );
  }

  const rawContent = await readFileAsText(filePath);
  const lines = rawContent.length === 0 ? [] : rawContent.split("\n");
  const totalLines = lines.length;
  const startLine = Math.min(
    Math.max(1, parsed.offset),
    totalLines === 0 ? 1 : totalLines + 1
  );
  const startIndex = startLine - 1;
  const endIndex =
    parsed.limit == null
      ? totalLines
      : Math.min(startIndex + parsed.limit, totalLines);
  const slice = lines.slice(startIndex, endIndex);
  const content = slice.join("\n");
  const endLine =
    slice.length > 0
      ? startLine + slice.length - 1
      : Math.max(0, startLine - 1);

  return {
    bytesRead: Buffer.byteLength(content, "utf8"),
    content,
    endLine,
    path: filePath,
    startLine,
    totalLines,
    truncated: endIndex < totalLines,
  };
}

export const builtinTools: ToolDefinition[] = [
  channelActionTool,
  fileAssetTool,
  officeDocumentTool,
  pdfDocumentTool,
  calculatorTool,
  writeFileTool,
  writeDocxTool,
  writePptxTool,
  deleteFileTool,
  editFileTool,
  readFileTool,
  listDirectoryTool,
  fileStatTool,
  copyFileTool,
  moveFileTool,
  createDirectoryTool,
  spreadsheetTool,
  searchFilesTool,
  knowledgeBaseSearchTool,
  webSearchTool,
  webFetchTool,
  browserTool,
  deepResearchTool,
  emailTool,
  extractDocumentTextTool,
  sendWhatsAppTool,
  // Gated on the server-wide env var, not the per-org toggle: the env var says
  // the binary exists here, the toggle says whether an org uses it. Publishing
  // the expander per-org would let an org flip folding on and have no way to
  // read back what was folded until a restart.
  ...(isOmniEnabled() ? [omniRetrieveTool] : []),
];

export { PathGuardError };
