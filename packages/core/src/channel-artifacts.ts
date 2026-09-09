import { inferArtifactMimeType } from "./artifact-mime";
import type { Artifact } from "./artifact-types";
import type { ChatMessage } from "./contract";
import { isFailedToolResult } from "./tools/result-status";

const ARTIFACT_META_SUFFIX = ".atlas-meta.json";
const ARTIFACTS_SEGMENT = "/artifacts/";
const ARTIFACTS_PREFIX = "artifacts/";

export interface ChannelArtifactRef {
  filename: string;
  mimeType: string;
  path: string;
  savedAt: string;
  sizeBytes: number;
}

interface WriteFileResult {
  bytesWritten?: number;
  error?: string;
  path?: string;
}

interface GenerateImageResult {
  error?: string;
  mimeType?: string;
  path?: string;
  sizeBytes?: number;
}

function parseToolResult(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function isWriteFileToolName(name: string): boolean {
  return name === "write_file" || name === "write_docx";
}

function isGenerateImageToolName(name: string): boolean {
  return name === "generate_image";
}

function pathFromToolResult(result: Record<string, unknown>): string | null {
  for (const key of ["path", "targetCsvPath", "targetXlsxPath"] as const) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

function getWriteFileResult(
  message: Extract<ChatMessage, { role: "tool" }>
): WriteFileResult | null {
  const parsed = parseToolResult(message.content);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    isFailedToolResult(parsed)
  ) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const resultPath = pathFromToolResult(record);
  if (!resultPath) {
    return record as WriteFileResult;
  }

  return {
    bytesWritten:
      typeof record.bytesWritten === "number" ? record.bytesWritten : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    path: resultPath,
  };
}

function isSuccessfulWrite(
  message: Extract<ChatMessage, { role: "tool" }>
): boolean {
  const result = getWriteFileResult(message);
  return (
    result != null &&
    typeof result.error !== "string" &&
    typeof result.path === "string"
  );
}

function resolvedWritePath(
  message: Extract<ChatMessage, { role: "tool" }>
): string | null {
  const result = getWriteFileResult(message);
  if (
    !result ||
    typeof result.error === "string" ||
    typeof result.path !== "string"
  ) {
    return null;
  }

  return result.path;
}

function isUnderArtifactsDir(resolvedPath: string): boolean {
  return (
    resolvedPath.includes(ARTIFACTS_SEGMENT) ||
    resolvedPath.startsWith(ARTIFACTS_PREFIX) ||
    resolvedPath.includes("\\artifacts\\")
  );
}

function isArtifactMetaRelativePath(relativePath: string): boolean {
  return (
    relativePath.endsWith(ARTIFACT_META_SUFFIX) ||
    relativePath.endsWith(".meta.json") ||
    relativePath.includes(".atlas-meta")
  );
}

function isArtifactMetaResolvedPath(resolvedPath: string): boolean {
  return (
    isUnderArtifactsDir(resolvedPath) &&
    (resolvedPath.endsWith(ARTIFACT_META_SUFFIX) ||
      resolvedPath.endsWith(".meta.json") ||
      resolvedPath.includes(".atlas-meta"))
  );
}

export function toArtifactsRelativePath(resolvedPath: string): string | null {
  const markerIndex = resolvedPath.indexOf(ARTIFACTS_SEGMENT);
  if (markerIndex !== -1) {
    return resolvedPath.slice(markerIndex + ARTIFACTS_SEGMENT.length);
  }

  const windowsMarker = resolvedPath.toLowerCase().indexOf("\\artifacts\\");
  if (windowsMarker !== -1) {
    return resolvedPath
      .slice(windowsMarker + "\\artifacts\\".length)
      .replace(/\\/g, "/");
  }

  if (resolvedPath.startsWith(ARTIFACTS_PREFIX)) {
    return resolvedPath.slice(ARTIFACTS_PREFIX.length);
  }

  return null;
}

function siblingContentPath(metaResolvedPath: string): string | null {
  if (!isArtifactMetaResolvedPath(metaResolvedPath)) {
    return null;
  }

  if (metaResolvedPath.endsWith(ARTIFACT_META_SUFFIX)) {
    return metaResolvedPath.slice(0, -ARTIFACT_META_SUFFIX.length);
  }
  if (metaResolvedPath.endsWith(".meta.json")) {
    return metaResolvedPath.slice(0, -".meta.json".length);
  }

  return null;
}

function parseArtifactMeta(
  content: unknown
): Pick<ChannelArtifactRef, "mimeType" | "sizeBytes" | "savedAt"> | null {
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const mimeType =
    typeof record.mimeType === "string" ? record.mimeType.trim() : "";
  const savedAt =
    typeof record.savedAt === "string" ? record.savedAt.trim() : "";
  const sizeBytes = record.sizeBytes;

  if (
    !(mimeType && savedAt) ||
    typeof sizeBytes !== "number" ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes < 0
  ) {
    return null;
  }

  return { mimeType, savedAt, sizeBytes };
}

function buildArtifactRef(
  relativePath: string,
  meta: Pick<ChannelArtifactRef, "mimeType" | "sizeBytes" | "savedAt">
): ChannelArtifactRef {
  const filename = relativePath.split("/").pop() ?? relativePath;
  return {
    filename,
    mimeType: meta.mimeType,
    path: relativePath,
    savedAt: meta.savedAt,
    sizeBytes: meta.sizeBytes,
  };
}

function relativePathFromWriteMessage(
  message: Extract<ChatMessage, { role: "tool" }>,
  toolInputs: Map<string, Record<string, unknown>>
): string | null {
  const resolvedPath = resolvedWritePath(message);
  if (resolvedPath) {
    const fromResolved = toArtifactsRelativePath(resolvedPath);
    if (fromResolved) {
      return fromResolved;
    }
  }

  const input = toolInputs.get(message.toolCallId);
  const inputPath = typeof input?.path === "string" ? input.path : null;
  if (!inputPath) {
    return null;
  }

  const normalized = inputPath.replace(/^\.\//, "");
  return toArtifactsRelativePath(normalized);
}

function metaContentFromSidecarWrite(
  message: Extract<ChatMessage, { role: "tool" }>,
  toolInputs: Map<string, Record<string, unknown>>
): string | null {
  const input = toolInputs.get(message.toolCallId);
  if (!input || typeof input.content !== "string") {
    return null;
  }

  return input.content;
}

function buildToolInputMap(
  messages: ChatMessage[]
): Map<string, Record<string, unknown>> {
  const toolInputs = new Map<string, Record<string, unknown>>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const call of message.toolCalls ?? []) {
      toolInputs.set(call.id, call.arguments);
    }
  }

  return toolInputs;
}

function getGenerateImageResult(
  message: Extract<ChatMessage, { role: "tool" }>
): GenerateImageResult | null {
  const parsed = parseToolResult(message.content);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    isFailedToolResult(parsed)
  ) {
    return null;
  }

  return parsed as GenerateImageResult;
}

function artifactRefsFromEmbeddedToolArtifacts(
  message: Extract<ChatMessage, { role: "tool" }>
): ChannelArtifactRef[] {
  const parsed = parseToolResult(message.content);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    isFailedToolResult(parsed)
  ) {
    return [];
  }

  const record = parsed as Record<string, unknown>;
  const candidates: unknown[] = [];

  if (Array.isArray(record.artifacts)) {
    candidates.push(...record.artifacts);
  }

  const snapshot =
    typeof record.snapshot === "object" && record.snapshot !== null
      ? (record.snapshot as Record<string, unknown>)
      : null;
  if (snapshot) {
    candidates.push(snapshot.screenshotArtifact, snapshot.downloadArtifact);
  }

  const refs: ChannelArtifactRef[] = [];

  for (const candidate of candidates) {
    const ref = artifactRefFromEmbeddedCandidate(candidate);
    if (ref) {
      refs.push(ref);
    }
  }

  return refs;
}

function artifactRefFromEmbeddedCandidate(
  candidate: unknown
): ChannelArtifactRef | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim()) {
    return null;
  }

  const relativePath = toArtifactsRelativePath(record.path.trim());
  if (!relativePath || isArtifactMetaRelativePath(relativePath)) {
    return null;
  }

  const filename =
    typeof record.filename === "string" && record.filename.trim()
      ? record.filename.trim()
      : (relativePath.split("/").pop() ?? relativePath);
  const mimeType =
    typeof record.mimeType === "string" && record.mimeType.trim()
      ? record.mimeType.trim()
      : inferArtifactMimeType(relativePath);
  const sizeBytes =
    typeof record.sizeBytes === "number" &&
    Number.isInteger(record.sizeBytes) &&
    record.sizeBytes >= 0
      ? record.sizeBytes
      : 0;
  const savedAt = typeof record.createdAt === "string" ? record.createdAt : "";

  return {
    filename,
    mimeType,
    path: relativePath,
    savedAt,
    sizeBytes,
  };
}

export function channelArtifactRefFromArtifact(
  artifact: Artifact
): ChannelArtifactRef | null {
  const relativePath = toArtifactsRelativePath(artifact.path);
  if (!relativePath || isArtifactMetaRelativePath(relativePath)) {
    return null;
  }

  return {
    filename:
      artifact.filename || (relativePath.split("/").pop() ?? relativePath),
    mimeType: artifact.mimeType || inferArtifactMimeType(relativePath),
    path: relativePath,
    savedAt: artifact.createdAt,
    sizeBytes: artifact.size,
  };
}

function artifactRefFromGenerateImage(
  message: Extract<ChatMessage, { role: "tool" }>
): ChannelArtifactRef | null {
  if (!isGenerateImageToolName(message.name)) {
    return null;
  }

  const result = getGenerateImageResult(message);
  if (!result || typeof result.error === "string") {
    return null;
  }

  if (typeof result.path !== "string" || !result.path.trim()) {
    return null;
  }

  const mimeType =
    typeof result.mimeType === "string" ? result.mimeType.trim() : "";
  if (!mimeType) {
    return null;
  }

  if (
    typeof result.sizeBytes !== "number" ||
    !Number.isInteger(result.sizeBytes) ||
    result.sizeBytes < 0
  ) {
    return null;
  }

  const relativePath = toArtifactsRelativePath(result.path.trim());
  if (!relativePath || isArtifactMetaRelativePath(relativePath)) {
    return null;
  }

  return buildArtifactRef(relativePath, {
    mimeType,
    savedAt: "",
    sizeBytes: result.sizeBytes,
  });
}

/** Messages belonging to the latest user turn (from last user message through end). */
export function extractLatestTurnMessages(
  messages: ChatMessage[]
): ChatMessage[] {
  let lastUserIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  if (lastUserIndex === -1) {
    return messages;
  }

  return messages.slice(lastUserIndex);
}

/**
 * Extract save-artifact pairs (content + `.atlas-meta.json` sidecar) from chat history.
 * Strict pairing only — no content-only or assistant-text fallbacks.
 */
export function extractPairedTurnArtifacts(
  messages: ChatMessage[]
): ChannelArtifactRef[] {
  const turnMessages = extractLatestTurnMessages(messages);
  const toolInputs = buildToolInputMap(messages);
  const contentWrites = new Map<string, { relativePath: string }>();
  const artifactsByPath = new Map<string, ChannelArtifactRef>();

  for (const message of turnMessages) {
    if (
      message.role !== "tool" ||
      !isWriteFileToolName(message.name) ||
      !isSuccessfulWrite(message)
    ) {
      continue;
    }

    const resolvedPath = resolvedWritePath(message);
    if (!resolvedPath || isArtifactMetaResolvedPath(resolvedPath)) {
      continue;
    }

    const relativePath = relativePathFromWriteMessage(message, toolInputs);
    if (!relativePath || isArtifactMetaRelativePath(relativePath)) {
      continue;
    }

    contentWrites.set(resolvedPath, { relativePath });
  }

  for (const message of turnMessages) {
    if (
      message.role !== "tool" ||
      !isWriteFileToolName(message.name) ||
      !isSuccessfulWrite(message)
    ) {
      continue;
    }

    const resolvedPath = resolvedWritePath(message);
    if (!(resolvedPath && isArtifactMetaResolvedPath(resolvedPath))) {
      continue;
    }

    const siblingPath = siblingContentPath(resolvedPath);
    if (!siblingPath) {
      continue;
    }

    const contentWrite = contentWrites.get(siblingPath);
    if (!contentWrite) {
      continue;
    }

    const meta = parseArtifactMeta(
      metaContentFromSidecarWrite(message, toolInputs)
    );
    if (!meta) {
      continue;
    }

    artifactsByPath.set(
      contentWrite.relativePath,
      buildArtifactRef(contentWrite.relativePath, meta)
    );
  }

  for (const message of turnMessages) {
    if (message.role !== "tool") {
      continue;
    }

    const generated = artifactRefFromGenerateImage(message);
    if (generated) {
      artifactsByPath.set(generated.path, generated);
    }

    for (const embedded of artifactRefsFromEmbeddedToolArtifacts(message)) {
      artifactsByPath.set(embedded.path, embedded);
    }
  }

  return [...artifactsByPath.values()];
}

const DELIVERABLE_WRITE_TOOLS = new Set([
  "write_file",
  "write_docx",
  "write_pptx",
  "spreadsheet",
]);

const SPREADSHEET_NON_DELIVERABLE_ACTIONS = new Set(["inspect", "read_range"]);

/**
 * Artifacts the channel should send back after a turn: paired save-artifact
 * sidecars first, then unpaired writes under artifacts/ (spreadsheet, docx,
 * pptx, write_file without sidecar).
 */
export function extractTurnDeliverableArtifacts(
  messages: ChatMessage[],
  streamedArtifacts: ChannelArtifactRef[] = []
): ChannelArtifactRef[] {
  const paired = extractPairedTurnArtifacts(messages);
  const artifactsByPath = new Map(
    paired.map((artifact) => [artifact.path, artifact])
  );
  const toolInputs = buildToolInputMap(messages);
  const turnMessages = extractLatestTurnMessages(messages);
  const hasFailedResult = turnMessages.some(
    (message) =>
      message.role === "tool" &&
      isFailedToolResult(parseToolResult(message.content))
  );

  for (const message of turnMessages) {
    if (message.role !== "tool") {
      continue;
    }

    const artifact = artifactRefFromUnpairedWrite(message, toolInputs);
    if (artifact && !artifactsByPath.has(artifact.path)) {
      artifactsByPath.set(artifact.path, artifact);
    }

    for (const embedded of artifactRefsFromEmbeddedToolArtifacts(message)) {
      if (!artifactsByPath.has(embedded.path)) {
        artifactsByPath.set(embedded.path, embedded);
      }
    }
  }

  for (const artifact of streamedArtifacts) {
    // Detached progress events have no tool-call provenance. After a failed
    // result, only canonical successful history can establish a deliverable.
    if (!(hasFailedResult || artifactsByPath.has(artifact.path))) {
      artifactsByPath.set(artifact.path, artifact);
    }
  }

  return [...artifactsByPath.values()];
}

/**
 * Every artifact path proven to originate from one persisted chat session.
 * This is intentionally derived from tool results rather than the shared
 * profile directory so channel workers cannot discover another session's
 * files merely by knowing a filename.
 */
export function extractSessionArtifacts(
  messages: ChatMessage[]
): ChannelArtifactRef[] {
  const artifactsByPath = new Map<string, ChannelArtifactRef>();
  const toolInputs = buildToolInputMap(messages);

  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }

    const written = artifactRefFromUnpairedWrite(message, toolInputs);
    if (written) {
      artifactsByPath.set(written.path, written);
    }

    const generated = artifactRefFromGenerateImage(message);
    if (generated) {
      artifactsByPath.set(generated.path, generated);
    }

    for (const embedded of artifactRefsFromEmbeddedToolArtifacts(message)) {
      artifactsByPath.set(embedded.path, embedded);
    }
  }

  return [...artifactsByPath.values()];
}

function artifactRefFromUnpairedWrite(
  message: Extract<ChatMessage, { role: "tool" }>,
  toolInputs: Map<string, Record<string, unknown>>
): ChannelArtifactRef | null {
  const toolName = message.name ?? "";
  if (!DELIVERABLE_WRITE_TOOLS.has(toolName)) {
    return null;
  }

  if (toolName === "spreadsheet") {
    const action = toolInputs.get(message.toolCallId)?.action;
    if (
      typeof action === "string" &&
      SPREADSHEET_NON_DELIVERABLE_ACTIONS.has(action)
    ) {
      return null;
    }
  }

  const result = getWriteFileResult(message);
  if (
    !result ||
    typeof result.error === "string" ||
    typeof result.path !== "string"
  ) {
    return null;
  }

  const relativePath = relativePathFromWriteMessage(message, toolInputs);
  if (!relativePath || isArtifactMetaRelativePath(relativePath)) {
    return null;
  }

  const sizeBytes =
    typeof result.bytesWritten === "number" &&
    Number.isInteger(result.bytesWritten) &&
    result.bytesWritten >= 0
      ? result.bytesWritten
      : 0;

  return buildArtifactRef(relativePath, {
    mimeType: inferArtifactMimeType(relativePath),
    savedAt: new Date().toISOString(),
    sizeBytes,
  });
}
