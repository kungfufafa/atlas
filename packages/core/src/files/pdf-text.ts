import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface PdfPageText {
  method?: "ocr";
  needsOcr: boolean;
  ocrConfidence?: number;
  ocrLanguage?: string;
  ocrReviewRequired?: boolean;
  page: number;
  text: string;
  truncated: boolean;
}

const MAX_WORKER_OUTPUT = 1_500_000;
const WORKER_TIMEOUT_MS = 20_000;
let activeWorkers = 0;

// A separate Bun process makes parser work interruptible, including synchronous
// PDF/font parsing. Pass only local bytes; do not evaluate document scripts,
// render fonts, follow URLs, or fetch remote CMaps/font resources.
const WORKER = String.raw`
const { readFile } = await import("node:fs/promises");
const config = await new Response(Bun.stdin).json();
globalThis.fetch = async () => { throw new Error("PDF extraction cannot fetch network resources."); };
const { getDocument } = await import(config.moduleUrl);
const task = getDocument({
  data: new Uint8Array(await readFile(config.filePath)),
  isEvalSupported: false, useWorkerFetch: false, useSystemFonts: false,
  disableFontFace: true, stopAtErrors: true, maxImageSize: 0, verbosity: 0,
});
try {
  const document = await task.promise;
  const pages = [];
  for (const number of config.pages) {
    const page = await document.getPage(number);
    const stream = page.streamTextContent();
    const reader = stream.getReader();
    let text = ""; let truncated = false; let usedBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const item of chunk.value.items) {
          if (typeof item.str !== "string") continue;
          const next = item.str + (item.hasEOL ? "\n" : " ");
          for (const character of next) {
            if (usedBytes + Buffer.byteLength(character) > config.maxBytes) { truncated = true; break; }
            text += character; usedBytes += Buffer.byteLength(character);
          }
          if (truncated) break;
        }
        if (truncated) { await reader.cancel(new Error("Page text output limit reached.")); break; }
      }
    } finally { reader.releaseLock(); }
    text = text.trim();
    pages.push({ page: number, text, truncated, needsOcr: !text });
    page.cleanup();
  }
  process.stdout.write(JSON.stringify(pages));
} finally { await task.destroy(); }
`;

async function runWorker(
  directory: string,
  pages: number[],
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<PdfPageText[]> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--eval", WORKER], {
      cwd: directory,
      env: { HOME: directory, TMPDIR: directory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let diagnostics = "";
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(new Error("PDF extraction cancelled."));
    const timer = setTimeout(
      () => stop(new Error("PDF extraction timed out.")),
      timeoutMs
    );
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WORKER_OUTPUT) {
        stop(new Error("PDF extraction output exceeds its bound."));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk
        .toString("utf8")
        .slice(0, Math.max(0, 4000 - diagnostics.length));
    });
    child.stdin.on("error", (error) => stop(error));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error(`PDF text parser failed: ${diagnostics.trim()}`));
        return;
      }
      try {
        resolve(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as PdfPageText[]
        );
      } catch {
        reject(new Error("PDF text parser returned invalid output."));
      }
    });
    child.stdin.end(
      JSON.stringify({
        filePath: path.join(directory, "input.pdf"),
        maxBytes: 8000,
        moduleUrl: import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
        pages,
      })
    );
    if (signal?.aborted) {
      abort();
    }
  });
}

export async function extractPdfPageText(
  bytes: Uint8Array,
  pages: number[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<PdfPageText[]> {
  options.signal?.throwIfAborted();
  if (
    bytes.length > 50 * 1024 * 1024 ||
    !pages.length ||
    pages.length > 25 ||
    pages.some((page) => !Number.isInteger(page) || page < 1 || page > 500)
  ) {
    throw new Error("PDF extraction input exceeds its byte or page bound.");
  }
  if (activeWorkers >= 2) {
    throw new Error(
      "PDF extraction capacity is busy; retry after the active operation."
    );
  }
  activeWorkers += 1;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(tmpdir(), "atlas-pdf-text-"));
    await writeFile(path.join(directory, "input.pdf"), bytes, { mode: 0o600 });
    return await runWorker(
      directory,
      pages,
      options.signal,
      Math.min(WORKER_TIMEOUT_MS, options.timeoutMs ?? WORKER_TIMEOUT_MS)
    );
  } finally {
    if (directory) {
      await rm(directory, { force: true, recursive: true });
    }
    activeWorkers -= 1;
  }
}
