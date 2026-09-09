import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../contract";
import {
  fileAssetRevision,
  loadFileAsset,
  saveFileArtifact,
} from "../files/assets";
import {
  MAX_OFFICE_BYTES,
  openOfficeArchive,
  saveOfficeArchive,
} from "../office-document/archive";
import { OfficeDocument } from "../office-document/document";
import { jsonSchemaFromZod, parseToolInput } from "./schema";

const selection = {
  section: z.enum(["content", "notes"]).optional(),
  unit: z.number().int().min(1).max(5000).optional(),
};
const replacementSchema = z
  .object({
    ...selection,
    expectedMatches: z.number().int().min(1).max(10_000),
    find: z.string().min(1).max(16_000),
    kind: z.literal("replace_text"),
    paragraph: z.number().int().min(1).optional(),
    replace: z.string().max(16_000),
  })
  .strict();
const cellSchema = z
  .object({
    ...selection,
    column: z.number().int().min(1),
    expectedText: z.string().max(16_000),
    kind: z.literal("set_table_cell"),
    row: z.number().int().min(1),
    table: z.number().int().min(1),
    text: z.string().max(16_000),
  })
  .strict();
const revisionOptions = {
  revisionAuthor: z.string().trim().min(1).max(100).optional(),
  trackChanges: z.boolean().optional(),
};
const source = { documentRef: z.string().trim().min(1) };
const pagination = {
  limit: z.number().int().min(1).max(100).default(40),
  start: z.number().int().min(1).default(1),
};
const editsSchema = z
  .array(z.discriminatedUnion("kind", [replacementSchema, cellSchema]))
  .min(1)
  .max(100);

export const officeDocumentInputSchema = z.discriminatedUnion("operation", [
  z
    .object({ ...source, ...pagination, operation: z.literal("inspect") })
    .strict(),
  z
    .object({
      ...source,
      ...pagination,
      ...selection,
      columnLimit: z.number().int().min(1).max(100).default(20),
      columnStart: z.number().int().min(1).default(1),
      operation: z.literal("read"),
      table: z.number().int().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...source,
      ...revisionOptions,
      edits: editsSchema,
      operation: z.literal("edit"),
      outputFilename: z.string().trim().min(1).optional(),
    })
    .strict(),
]);

// API function declarations require one object at the root. The advertised
// superset stays portable; the discriminated schema above enforces each
// operation's exact fields before any file is loaded or changed.
const advertisedSchema = z
  .object({
    ...source,
    ...selection,
    ...revisionOptions,
    columnLimit: z.number().int().min(1).max(100).optional(),
    columnStart: z.number().int().min(1).optional(),
    edits: z
      .array(
        z
          .object({
            ...replacementSchema.partial().shape,
            ...cellSchema.partial().shape,
            kind: z.enum(["replace_text", "set_table_cell"]),
          })
          .strict()
      )
      .min(1)
      .max(100)
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    operation: z.enum(["inspect", "read", "edit"]),
    outputFilename: z.string().trim().min(1).optional(),
    start: z.number().int().min(1).optional(),
    table: z.number().int().min(1).optional(),
  })
  .strict();

export type OfficeDocumentInput = z.infer<typeof officeDocumentInputSchema>;

export const officeDocumentTool: ToolDefinition<OfficeDocumentInput> = {
  description:
    "Inspect, read, and edit existing .docx/.pptx documents while preserving images, styles, masters, and unrelated package parts. documentRef is a workspace path or stored attachment id. Inspect lists indexed units (Word body and headers/footers, or PowerPoint slides). Read paginates paragraphs in one unit; table selects paginated table rows and columns; section=notes reads speaker notes. For edit, provide edits: kind=replace_text requires find, replace, expectedMatches; kind=set_table_cell requires table, row, column, text, expectedText. Send only fields for the selected operation and edit kind. Word edits inside existing insertions create new tracked revisions without changing earlier author history; trackChanges=true also tracks plain text edits, with revisionAuthor defaulting to Atlas. All indexes are 1-based. Edits save a new version in artifacts/; the source is preserved.",
  name: "office_document",
  parallelSafe: false,
  parameters: jsonSchemaFromZod(advertisedSchema),
  async run(rawInput, context) {
    const input = parseToolInput(officeDocumentInputSchema, rawInput);
    context.signal?.throwIfAborted();
    const asset = await loadFileAsset(input.documentRef, context, {
      allowedExtensions: [".docx", ".pptx"],
      maxBytes: MAX_OFFICE_BYTES,
    });
    // The digest describes exactly the owned bytes parsed below. It is not an
    // atomic filesystem snapshot or a publication/delivery identity.
    const parsedBytes =
      input.operation === "read" &&
      path.extname(asset.filename).toLowerCase() === ".docx"
        ? Buffer.from(asset.bytes)
        : asset.bytes;
    const archive = openOfficeArchive(parsedBytes);
    if (path.extname(asset.filename).toLowerCase() !== `.${archive.format}`) {
      throw new Error("The Office filename does not match its package format.");
    }
    const document = new OfficeDocument(archive);
    if (input.operation === "inspect") {
      return {
        ...document.inspect(input.start, input.limit),
        untrustedContent: true,
      };
    }
    if (input.operation === "read") {
      const result = document.read(input);
      context.signal?.throwIfAborted();
      return {
        ...result,
        ...(result.readback
          ? {
              readback: {
                ...result.readback,
                source: {
                  algorithm: "sha256",
                  bytes: parsedBytes.byteLength,
                  revision: fileAssetRevision(parsedBytes),
                  scope: "parsed_input_bytes",
                },
              },
            }
          : {}),
        untrustedContent: true,
      };
    }
    const outputFilename =
      input.outputFilename ??
      `${path.basename(asset.filename, path.extname(asset.filename))}-edited.${archive.format}`;
    if (
      path.basename(outputFilename) !== outputFilename ||
      path.extname(outputFilename).toLowerCase() !== `.${archive.format}`
    ) {
      throw new Error(
        "outputFilename must be a basename with the source document's extension."
      );
    }
    const changedParts = document.edit(input.edits, input);
    const bytes = Buffer.from(saveOfficeArchive(archive));
    context.signal?.throwIfAborted();
    const saved = await saveFileArtifact({
      bytes,
      context,
      filename: outputFilename,
      sourcePath: asset.sourcePath,
    });
    return {
      ...saved,
      changedParts,
      editCount: input.edits.length,
      format: archive.format,
      sourcePreserved: true,
    };
  },
};
