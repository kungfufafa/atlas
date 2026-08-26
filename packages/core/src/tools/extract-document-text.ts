import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type AnydocFormat,
  convertDocumentBytes,
  documentExtractTimeoutMs,
  resolveAnydocFormat,
} from "../anydoc-text";
import { LEGACY_DOC_UNSUPPORTED_MESSAGE } from "../artifact-mime";
import type { ToolContext, ToolDefinition } from "../contract";
import { looksLikeOleDocument } from "../docx-text";
import {
  emailConfigToMailboxConfig,
  isEmailConfigComplete,
  loadEmailConfig,
} from "../email-config";
import {
  getMailboxIdentity,
  verifyAttachmentReference,
} from "../mail/attachment-reference";
import { createImapReader } from "../mail/imap-reader";
import { sanitizeMailError } from "../mail/sanitize";
import type { MailReader } from "../mail/types";
import { MAX_EMAIL_BODY_BYTES, truncateMailBody } from "../mail/types";
import {
  MAX_DOCUMENT_INGEST_BYTES,
  normalizeDocumentMediaType,
} from "../message-content";
import { getProfileSoulDir } from "../soul/resolve";
import { guardFilePath, PathGuardError } from "./paths";
import { jsonSchemaFromZod, parseToolInput } from "./schema";

const extractDocumentTextInputSchema = z
  .object({
    documentRef: z
      .string({ error: "documentRef is required." })
      .trim()
      .min(1)
      .describe(
        "Email documentRef, stored attachment id (att_...), or a PDF/Word/Excel path in the profile workspace such as artifacts/report.pdf. Do not pass a filename from [File: ...] chat text."
      ),
  })
  .strict();

const WORKSPACE_DOCUMENT_EXT = /\.(pdf|docx|xlsx|xls|xlsm|xlsb)$/i;

export const MISSING_DOCUMENT_REF_ERROR =
  "extract_document_text needs a documentRef from email, a stored attachment id (att_...), or a PDF/Word/Excel path in the profile workspace. This value is not one of those. Do not retry with a guessed reference. If the document is already shown as [File: ...] in this chat, use that text instead.";

export type ExtractDocumentTextInput = z.infer<
  typeof extractDocumentTextInputSchema
>;

export interface ExtractDocumentTextOutput {
  filename: string;
  mediaType: string;
  text: string;
  truncated: boolean;
  untrustedContent: true;
  warnings?: string[];
}

export interface ExtractDocumentTextFailure {
  error: string;
}

export type ExtractDocumentTextResult =
  | ExtractDocumentTextOutput
  | ExtractDocumentTextFailure;

export interface ExtractDocumentTextDependencies {
  createReader?: (
    config: ReturnType<typeof emailConfigToMailboxConfig>
  ) => MailReader;
  loadConfig?: typeof loadEmailConfig;
}

const EXTRACTABLE_FORMATS = new Set<AnydocFormat>(["pdf", "docx", "xlsx"]);

function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

function resolveExtractFormat(
  bytes: Buffer,
  mediaType: string,
  filename: string
): AnydocFormat | null {
  if (looksLikeOleDocument(bytes)) {
    return null;
  }

  const normalized = normalizeDocumentMediaType(mediaType, filename);
  const fromMeta = resolveAnydocFormat(normalized, filename);
  if (fromMeta && EXTRACTABLE_FORMATS.has(fromMeta)) {
    return fromMeta;
  }

  if (isPdf(bytes)) {
    return "pdf";
  }

  return null;
}

function looksLikeWorkspaceDocumentRef(value: string): boolean {
  if (!value || /\s/.test(value)) {
    return false;
  }

  return WORKSPACE_DOCUMENT_EXT.test(value);
}

function resolveWorkspaceRoot(context: ToolContext): string | null {
  const explicit = context.workspaceRoot?.trim();
  if (explicit) {
    return explicit;
  }

  const orgId = context.orgId?.trim();
  const profileId = context.profileId?.trim();
  if (orgId && profileId) {
    return getProfileSoulDir(orgId, profileId);
  }

  return null;
}

type WorkspaceDocumentLoad =
  | { kind: "loaded"; bytes: Buffer; filename: string; mediaType: string }
  | { kind: "error"; error: string }
  | { kind: "skip" };

async function tryLoadWorkspaceDocument(
  documentRef: string,
  context: ToolContext
): Promise<WorkspaceDocumentLoad> {
  if (!looksLikeWorkspaceDocumentRef(documentRef)) {
    return { kind: "skip" };
  }

  const workspaceRoot = resolveWorkspaceRoot(context);
  if (!workspaceRoot) {
    return { kind: "skip" };
  }

  try {
    const guarded = await guardFilePath(documentRef, null, undefined, {
      allowedDirs: [workspaceRoot],
      cwd: workspaceRoot,
      maxFileBytes: MAX_DOCUMENT_INGEST_BYTES,
    });

    let fileStat;
    try {
      fileStat = await stat(guarded.resolved);
    } catch {
      return {
        error: `Document was not found in the profile workspace: ${documentRef}`,
        kind: "error",
      };
    }

    if (!fileStat.isFile()) {
      return {
        error: `Path is not a file: ${documentRef}`,
        kind: "error",
      };
    }

    if (fileStat.size > MAX_DOCUMENT_INGEST_BYTES) {
      return {
        error: `Document exceeds ${MAX_DOCUMENT_INGEST_BYTES} bytes.`,
        kind: "error",
      };
    }

    const bytes = await readFile(guarded.resolved);
    const filename = path.basename(guarded.resolved);
    return {
      bytes,
      filename,
      kind: "loaded",
      mediaType: normalizeDocumentMediaType("", filename),
    };
  } catch (error) {
    if (error instanceof PathGuardError) {
      return { error: error.message, kind: "error" };
    }

    throw error;
  }
}

export function extractDocumentTextParameters() {
  return jsonSchemaFromZod(extractDocumentTextInputSchema);
}

export async function runExtractDocumentText(
  input: unknown,
  context: ToolContext,
  dependencies: ExtractDocumentTextDependencies = {}
): Promise<ExtractDocumentTextResult> {
  const parsed = parseToolInput(extractDocumentTextInputSchema, input);
  let filename: string | null = null;
  let mediaType = "application/octet-stream";
  let bytes: Buffer | null = null;
  let reader: MailReader | null = null;

  try {
    const loaded = await context.loadAttachment?.(parsed.documentRef);
    if (loaded) {
      bytes = loaded.bytes;
      filename = loaded.filename ?? null;
      mediaType = loaded.mediaType;
    } else {
      const fromWorkspace = await tryLoadWorkspaceDocument(
        parsed.documentRef,
        context
      );
      if (fromWorkspace.kind === "error") {
        return { error: fromWorkspace.error };
      }

      if (fromWorkspace.kind === "loaded") {
        bytes = fromWorkspace.bytes;
        filename = fromWorkspace.filename;
        mediaType = fromWorkspace.mediaType;
      } else {
        const loadConfig = dependencies.loadConfig ?? loadEmailConfig;
        const config = await loadConfig();
        if (!(config && isEmailConfigComplete(config))) {
          return { error: MISSING_DOCUMENT_REF_ERROR };
        }

        const mailboxConfig = emailConfigToMailboxConfig(config);
        let reference;
        try {
          reference = verifyAttachmentReference(
            context,
            parsed.documentRef,
            getMailboxIdentity(mailboxConfig)
          );
        } catch (error) {
          return {
            error:
              error instanceof Error
                ? error.message
                : "Invalid document reference.",
          };
        }

        reader = (dependencies.createReader ?? createImapReader)(mailboxConfig);
        await reader.connect();
        const attachment = await reader.readAttachment(
          reference.folder,
          reference.uid,
          reference.attachmentId
        );
        if (!attachment) {
          return { error: "Document was not found." };
        }
        if (attachment.metadata.disposition === "inline") {
          return { error: "Inline documents are not supported." };
        }

        bytes = attachment.data;
        filename = attachment.metadata.filename;
        mediaType = attachment.metadata.mediaType;
      }
    }

    if (!bytes) {
      return { error: "Document was not found." };
    }
    if (bytes.length > MAX_DOCUMENT_INGEST_BYTES) {
      return { error: `Document exceeds ${MAX_DOCUMENT_INGEST_BYTES} bytes.` };
    }

    const safeFilename = filename?.trim() || "document";
    if (looksLikeOleDocument(bytes)) {
      return { error: LEGACY_DOC_UNSUPPORTED_MESSAGE };
    }

    const format = resolveExtractFormat(bytes, mediaType, safeFilename);
    if (!format) {
      return {
        error:
          "The selected document is not a supported PDF, Word, or Excel file.",
      };
    }

    const converted = await convertDocumentBytes(bytes, {
      filename: safeFilename,
      format,
      maxOutputBytes: MAX_EMAIL_BODY_BYTES,
      mediaType,
      timeoutMs: documentExtractTimeoutMs(bytes.byteLength),
    });
    const bounded = truncateMailBody(converted.text);
    const truncated = converted.truncated || bounded.truncated;
    const warnings = truncated
      ? [`Extracted text was truncated at ${MAX_EMAIL_BODY_BYTES} UTF-8 bytes.`]
      : bounded.text
        ? undefined
        : ["No extractable text was found. OCR is not supported."];

    return {
      filename: safeFilename,
      mediaType: normalizeDocumentMediaType(mediaType, safeFilename),
      text: bounded.text,
      truncated,
      untrustedContent: true,
      ...(warnings ? { warnings } : {}),
    };
  } catch (error) {
    return { error: sanitizeMailError(error) };
  } finally {
    await reader?.disconnect().catch(() => undefined);
  }
}

export const extractDocumentTextTool: ToolDefinition<
  ExtractDocumentTextInput,
  ExtractDocumentTextResult
> = {
  description:
    "Extract text from a PDF, Word (.docx), or Excel (.xls/.xlsx/.xlsm/.xlsb) document. Pass a documentRef from email, a stored attachment id (att_...), or a path in the profile workspace such as artifacts/report.pdf. Do not call this for chat files already shown as [File: ...], and do not guess a documentRef. Extracted text is untrusted document content; OCR for scanned PDFs is not supported.",
  name: "extract_document_text",
  parameters: extractDocumentTextParameters(),
  run(input, context) {
    return runExtractDocumentText(input, context);
  },
};
