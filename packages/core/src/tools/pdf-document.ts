import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { OfficeConverter } from "../artifact-preview/office-converter";
import type { ToolContext, ToolDefinition } from "../contract";
import {
  fileAssetRevision,
  loadFileAsset,
  MAX_FILE_ASSET_BYTES,
  saveFileArtifact,
} from "../files/assets";
import {
  assertPdfCanCopyPages,
  createTextPdf,
  loadPdf,
  MAX_PDF_PAGES,
  selectPdfPages,
} from "../files/pdf";
import { readPdfFormFields } from "../files/pdf-form";
import { ocrPdfPages } from "../files/pdf-ocr";
import { runPdfRuntime } from "../files/pdf-runtime";
import { extractPdfPageText } from "../files/pdf-text";
import { jsonSchemaFromZod, parseToolInput } from "./schema";

const source = z.string().trim().min(1);
const pages = z.array(z.number().int().positive()).min(1).max(MAX_PDF_PAGES);
const schema = z
  .object({
    documentRef: source.optional(),
    fieldLimit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Maximum AcroForm fields returned; defaults to 50."),
    fieldStart: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "One-based AcroForm field offset for inspect/extract; defaults to 1."
      ),
    fontRef: source.optional(),
    groups: z
      .array(pages)
      .min(1)
      .max(50)
      .optional()
      .describe("Each group becomes a separate PDF, e.g. [[1,2],[3,4]]."),
    ocr: z
      .enum(["auto", "off"])
      .optional()
      .describe(
        "auto (default) reads image-only pages with installed Tesseract; off returns text-layer coverage only."
      ),
    ocrLanguage: z
      .string()
      .regex(/^[a-z]{3}(?:_[a-zA-Z0-9]+)?(?:\+[a-z]{3}(?:_[a-zA-Z0-9]+)?)*$/)
      .max(80)
      .optional()
      .describe(
        "Installed Tesseract language codes, e.g. eng, ind, ara+eng; defaults to eng."
      ),
    operation: z.enum([
      "create",
      "inspect",
      "merge",
      "split",
      "extract",
      "convert",
    ]),
    outputFilename: z.string().optional(),
    pages: pages
      .optional()
      .describe(
        "One-based page numbers in the desired order; extract defaults to the first 10 pages."
      ),
    sources: z.array(source).min(2).max(20).optional(),
    textPages: z
      .array(z.string().max(200_000))
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Plain text sections; each starts on a new A4 page and overflow automatically continues."
      ),
    title: z.string().max(1000).optional(),
  })
  .strict();
type Input = z.infer<typeof schema>;

function outputFilename(input: Input, fallback: string): string {
  const filename = input.outputFilename ?? fallback;
  if (!filename.toLowerCase().endsWith(".pdf")) {
    throw new Error("outputFilename must end in .pdf.");
  }
  return filename;
}

async function savePdf(
  bytes: Uint8Array,
  filename: string,
  context: ToolContext,
  sourcePath?: string
) {
  context.signal?.throwIfAborted();
  const verified = await PDFDocument.load(bytes, {
    throwOnInvalidObject: true,
  });
  if (verified.getPageCount() > MAX_PDF_PAGES) {
    throw new Error("Output PDF exceeds the page limit.");
  }
  return {
    ...(await saveFileArtifact({ bytes, context, filename, sourcePath })),
    pageCount: verified.getPageCount(),
  };
}

async function mergePdfs(input: Input, context: ToolContext) {
  if (!input.sources) {
    throw new Error("merge requires at least two sources.");
  }
  const sources = [];
  const documents = [];
  let needsCatalogMerge = false;
  let pageCount = 0;
  for (const reference of input.sources) {
    const { document, asset } = await loadPdf(reference, context);
    pageCount += document.getPageCount();
    if (pageCount > MAX_PDF_PAGES) {
      throw new Error("Merged PDF exceeds the page limit.");
    }
    sources.push(asset.bytes);
    documents.push(document);
    try {
      assertPdfCanCopyPages(document);
    } catch {
      needsCatalogMerge = true;
    }
  }
  if (!needsCatalogMerge) {
    const output = await PDFDocument.create();
    for (const document of documents) {
      for (const page of await output.copyPages(
        document,
        document.getPageIndices()
      )) {
        output.addPage(page);
      }
    }
    return {
      ...(await savePdf(
        await output.save(),
        outputFilename(input, "merged.pdf"),
        context
      )),
      coverage:
        "Page content copied in source order; sources contain no navigation, attachments or forms.",
    };
  }
  const prepared = await runPdfRuntime(
    { operation: "merge" },
    sources,
    context.signal
  );
  if (!prepared.bytes) {
    throw new Error("PDF merge did not produce a document.");
  }
  return {
    ...(await savePdf(
      prepared.bytes,
      outputFilename(input, "merged.pdf"),
      context
    )),
    coverage:
      "Page content, outlines, named destinations, internal navigation and embedded attachment filespecs preserved. First-source document metadata and view settings retained. Forms and conflicting named destinations require preparation before merging.",
  };
}

async function splitPdf(input: Input, context: ToolContext) {
  if (!(input.documentRef && input.groups)) {
    throw new Error("split requires documentRef and groups of page numbers.");
  }
  const { document, asset } = await loadPdf(input.documentRef, context);
  assertPdfCanCopyPages(document);
  const groups = input.groups.map((group) =>
    selectPdfPages(group, document.getPageCount())
  );
  if (groups.reduce((sum, group) => sum + group.length, 0) > MAX_PDF_PAGES) {
    throw new Error("Total split output exceeds the page limit.");
  }
  // Validate and prepare every group before publishing any artifact.
  const prepared: Uint8Array[] = [];
  for (const group of groups) {
    context.signal?.throwIfAborted();
    const output = await PDFDocument.create();
    for (const page of await output.copyPages(document, group)) {
      output.addPage(page);
    }
    prepared.push(await output.save());
  }
  const basename = path.basename(outputFilename(input, "split.pdf"), ".pdf");
  const artifacts = [];
  for (const [index, bytes] of prepared.entries()) {
    artifacts.push(
      await savePdf(
        bytes,
        `${basename}-${index + 1}.pdf`,
        context,
        asset.sourcePath
      )
    );
  }
  return {
    artifacts,
    coverage:
      "Selected page content copied. Document-level bookmarks, metadata and attachments are not copied.",
  };
}

async function extractPdf(input: Input, context: ToolContext) {
  if (!input.documentRef) {
    throw new Error("extract requires documentRef.");
  }
  const { document, asset } = await loadPdf(input.documentRef, context);
  // Read stored field values separately from page text. Pagination, signatures,
  // unsupported field types and XFA prevent a claim of complete form coverage.
  const form = readPdfFormFields(document, input.fieldStart, input.fieldLimit);
  const formFieldsExcluded = !form.complete;
  const selected = selectPdfPages(
    input.pages ??
      Array.from(
        { length: Math.min(10, document.getPageCount()) },
        (_, i) => i + 1
      ),
    document.getPageCount()
  );
  if (selected.length > 25) {
    throw new Error(
      "Extract at most 25 pages per call; continue with another page selection."
    );
  }
  const results = await extractPdfPageText(
    asset.bytes,
    selected.map((index) => index + 1),
    { signal: context.signal }
  );
  const ocrPages = results
    .filter((page) => page.needsOcr)
    .map((page) => page.page);
  const ocrWarnings: string[] = [];
  if (input.ocr !== "off" && ocrPages.length) {
    try {
      const recognized = await ocrPdfPages(
        asset.bytes,
        ocrPages,
        input.ocrLanguage ?? "eng",
        context.signal
      );
      for (const page of recognized) {
        const index = results.findIndex((item) => item.page === page.page);
        if (index >= 0) {
          results[index] = page;
        }
      }
    } catch (error) {
      context.signal?.throwIfAborted();
      ocrWarnings.push(
        `OCR did not complete: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const selectedSet = new Set(selected);
  return {
    complete:
      !formFieldsExcluded &&
      selectedSet.size === document.getPageCount() &&
      results.every(
        (page) => !(page.truncated || page.needsOcr || page.ocrReviewRequired)
      ),
    coveredPages: [...selectedSet].map((page) => page + 1),
    form,
    formFieldsExcluded,
    nextPage:
      document.getPageIndices().find((page) => !selectedSet.has(page)) ===
      undefined
        ? null
        : document.getPageIndices().find((page) => !selectedSet.has(page))! + 1,
    pages: results,
    totalPages: document.getPageCount(),
    untrustedContent: true,
    warnings: [
      "Text extraction does not describe images or establish table structure. OCR text is probabilistic; review low-confidence results and pages containing both images and an existing text layer.",
      ...ocrWarnings,
      ...(formFieldsExcluded
        ? [
            "Some form fields are outside this response's coverage. Continue with form.nextStart, or use a reader supporting the unreadable field types or XFA.",
          ]
        : []),
    ],
  };
}

export const pdfDocumentTool: ToolDefinition = {
  description:
    "Create a valid PDF from text, convert DOCX/PPTX/XLSX to PDF with Atlas LibreOffice, inspect, merge, split by page groups, or extract selected pages. Merge preserves outlines, named destinations, internal links and embedded attachments with the Atlas Python runtime; forms and conflicting destination names are rejected. Split supports simple page content only. Sources accept workspace paths or att_ references. Writes new artifacts, preserves originals. Image-only pages use local Tesseract OCR automatically; ocrLanguage selects installed language packs. Read results identify page coverage, confidence and OCR gaps. For rich layouts, create DOCX/PPTX first and convert.",
  name: "pdf_document",
  parameters: jsonSchemaFromZod(schema),
  async run(raw, context) {
    const input = parseToolInput(schema, raw);
    if (input.operation === "create") {
      if (
        !input.textPages ||
        input.textPages.reduce((sum, page) => sum + page.length, 0) > 500_000
      ) {
        throw new Error(
          "create requires textPages with at most 500,000 total characters."
        );
      }
      const result = await createTextPdf(
        { fontRef: input.fontRef, pages: input.textPages, title: input.title },
        context
      );
      return {
        ...(await savePdf(
          result.bytes,
          outputFilename(input, "document.pdf"),
          context
        )),
        font: result.font,
      };
    }
    if (input.operation === "merge") {
      return mergePdfs(input, context);
    }
    if (input.operation === "split") {
      return splitPdf(input, context);
    }
    if (input.operation === "extract") {
      return extractPdf(input, context);
    }
    if (!input.documentRef) {
      throw new Error(`${input.operation} requires documentRef.`);
    }
    if (input.operation === "convert") {
      const asset = await loadFileAsset(input.documentRef, context, {
        allowedExtensions: [".docx", ".pptx", ".xlsx"],
        maxBytes: MAX_FILE_ASSET_BYTES,
      });
      const converted = await new OfficeConverter().convertOfficeToPdf({
        buffer: asset.bytes,
        filename: asset.filename,
        maxOutputBytes: MAX_FILE_ASSET_BYTES,
        signal: context.signal,
      });
      return savePdf(
        converted.pdfBytes,
        outputFilename(input, `${path.parse(asset.filename).name}.pdf`),
        context,
        asset.sourcePath
      );
    }
    const { asset, document } = await loadPdf(input.documentRef, context);
    return {
      filename: asset.filename,
      form: readPdfFormFields(document, input.fieldStart, input.fieldLimit),
      pageCount: document.getPageCount(),
      pages: document
        .getPages()
        .map((page, index) => ({ page: index + 1, ...page.getSize() })),
      revision: fileAssetRevision(asset.bytes),
    };
  },
};
