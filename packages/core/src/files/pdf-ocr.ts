import { runPdfRuntime } from "./pdf-runtime";
import type { PdfPageText } from "./pdf-text";

export async function ocrPdfPages(
  bytes: Uint8Array,
  pages: number[],
  language: string,
  signal?: AbortSignal
): Promise<PdfPageText[]> {
  const result = await runPdfRuntime(
    {
      language,
      operation: "ocr",
      pages,
      rasterizer: process.env.ATLAS_PDFTOPPM_PATH?.trim() || "pdftoppm",
      tesseract: process.env.ATLAS_TESSERACT_PATH?.trim() || "tesseract",
    },
    [bytes],
    signal
  );
  return result.result.pages as PdfPageText[];
}
