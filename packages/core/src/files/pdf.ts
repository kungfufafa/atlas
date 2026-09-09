import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  type PDFFont,
  PDFName,
  StandardFonts,
} from "pdf-lib";
import type { ToolContext } from "../contract";
import { loadFileAsset, MAX_FILE_ASSET_BYTES } from "./assets";
import { runPdfRuntime } from "./pdf-runtime";

export const MAX_PDF_PAGES = 500;

export async function loadPdf(reference: string, context: ToolContext) {
  const asset = await loadFileAsset(reference, context, {
    allowedExtensions: [".pdf"],
    maxBytes: MAX_FILE_ASSET_BYTES,
  });
  if (!asset.bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error("The file does not contain a PDF header.");
  }
  const document = await PDFDocument.load(asset.bytes, {
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  if (document.getPageCount() > MAX_PDF_PAGES) {
    throw new Error(
      `PDF exceeds ${MAX_PDF_PAGES} pages; split it into smaller files first.`
    );
  }
  return { asset, document };
}

export function assertPdfCanCopyPages(document: PDFDocument): void {
  // Copying PDF page trees alone would silently discard interactive form values.
  if (document.catalog.has(PDFName.of("AcroForm"))) {
    throw new Error(
      "This PDF contains a form or signature. Page copying cannot preserve it safely; provide a flattened, unsigned copy."
    );
  }
  if (
    ["Outlines", "Names", "Dests"].some((key) =>
      document.catalog.has(PDFName.of(key))
    )
  ) {
    throw new Error(
      "PDF page copying cannot preserve bookmarks, named destinations, or embedded attachments. This operation is unsupported for this source; no output was saved."
    );
  }
  for (const page of document.getPages()) {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annotations) {
      continue;
    }
    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = annotations.lookupMaybe(index, PDFDict);
      if (!annotation) {
        continue;
      }
      const action = annotation.lookupMaybe(PDFName.of("A"), PDFDict);
      if (
        annotation.has(PDFName.of("Dest")) ||
        action?.lookupMaybe(PDFName.of("S"), PDFName) === PDFName.of("GoTo")
      ) {
        throw new Error(
          "PDF page copying cannot preserve internal navigation. This operation is unsupported for this source; no output was saved."
        );
      }
    }
  }
}

export function selectPdfPages(
  pages: readonly number[] | undefined,
  total: number
): number[] {
  const selected =
    pages ?? Array.from({ length: total }, (_, index) => index + 1);
  if (!selected.length || selected.some((page) => page < 1 || page > total)) {
    throw new Error(`Page numbers must be between 1 and ${total}.`);
  }
  return selected.map((page) => page - 1);
}

async function resolveFont(
  document: PDFDocument
): Promise<{ font: PDFFont; engine: string }> {
  document.registerFontkit(fontkit);
  const candidates = [
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
  ];
  for (const candidate of candidates) {
    let bytes: Buffer;
    try {
      bytes = await readFile(candidate);
    } catch {
      continue;
    }
    return {
      engine: "system-sans",
      font: await document.embedFont(bytes, { subset: true }),
    };
  }
  return {
    engine: "Helvetica",
    font: await document.embedFont(StandardFonts.Helvetica),
  };
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  width: number
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replaceAll("\t", "    ").split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (font.widthOfTextAtSize(line + word, size) <= width) {
        line += word;
        continue;
      }
      if (line.trim()) {
        lines.push(line.trimEnd());
        line = "";
      }
      for (const character of word.trimStart()) {
        if (font.widthOfTextAtSize(line + character, size) > width) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export async function createTextPdf(
  input: { pages: string[]; title?: string; fontRef?: string },
  context: ToolContext
) {
  if (input.fontRef) {
    const asset = await loadFileAsset(input.fontRef, context, {
      allowedExtensions: [".ttf", ".otf"],
      maxBytes: 50 * 1024 * 1024,
    });
    const result = await runPdfRuntime(
      { operation: "create", pages: input.pages, title: input.title },
      [asset.bytes],
      context.signal
    );
    if (!result.bytes) {
      throw new Error("PDF font layout did not produce a document.");
    }
    return {
      bytes: result.bytes,
      font: asset.filename,
      pageCount: Number(result.result.pageCount),
    };
  }
  const document = await PDFDocument.create();
  document.setCreator("Atlas");
  if (input.title) {
    document.setTitle(input.title);
  }
  const { font, engine } = await resolveFont(document);
  const supported = new Set(font.getCharacterSet());
  for (const character of input.pages.join("")) {
    if ("\r\n\t".includes(character)) {
      continue;
    }
    if (!supported.has(character.codePointAt(0)!)) {
      throw new Error(
        `The selected font cannot render ${JSON.stringify(character)}. Supply fontRef with a TTF/OTF font that covers the document language, or convert a DOCX using pdf_document convert.`
      );
    }
  }
  const pageSize: [number, number] = [595.28, 841.89];
  for (const section of input.pages) {
    context.signal?.throwIfAborted();
    if (document.getPageCount() >= MAX_PDF_PAGES) {
      throw new Error("Generated PDF exceeds the page limit.");
    }
    let page = document.addPage(pageSize);
    let y = pageSize[1] - 50;
    for (const line of wrapText(section, font, 11, pageSize[0] - 100)) {
      if (y < 50) {
        if (document.getPageCount() >= MAX_PDF_PAGES) {
          throw new Error("Generated PDF exceeds the page limit.");
        }
        page = document.addPage(pageSize);
        y = pageSize[1] - 50;
      }
      page.drawText(line, { font, size: 11, x: 50, y });
      y -= 16;
    }
  }
  return {
    bytes: await document.save(),
    font: engine,
    pageCount: document.getPageCount(),
  };
}
