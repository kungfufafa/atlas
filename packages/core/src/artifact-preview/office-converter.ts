import { spawn } from "node:child_process";
import { existsSync, promises as fs, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { unzipSync } from "fflate";
import { extractPdfPageCount } from "./previewers/pdf-previewer";

export const OFFICE_CONVERSION_TIMEOUT_MS = 20_000; // 20s
export const MAX_OFFICE_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const MAX_DERIVED_PDF_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const OFFICE_CONVERTER_VERSION = "libreoffice-26.2";

export interface OfficeConversionResult {
  converterVersion: string;
  durationMs: number;
  pageCount: number;
  pdfBytes: Buffer;
}

export function inspectZipBombSafety(buffer: Buffer): void {
  try {
    const unzipped = unzipSync(new Uint8Array(buffer), {
      filter: (file) => !file.name.includes(".."),
    });

    const entries = Object.keys(unzipped);
    if (entries.length > 5000) {
      throw new Error(
        `Zip entry count exceeds safety threshold: ${entries.length} entries.`
      );
    }

    let totalUncompressedSize = 0;
    for (const key of entries) {
      totalUncompressedSize += unzipped[key]?.length || 0;
      if (totalUncompressedSize > 200 * 1024 * 1024) {
        throw new Error(
          "Uncompressed Office archive exceeds safety threshold (200MB)."
        );
      }
    }

    const compressionRatio = totalUncompressedSize / Math.max(1, buffer.length);
    if (compressionRatio > 100) {
      throw new Error(
        `Suspicious compression ratio (${compressionRatio.toFixed(1)}x) detected.`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("threshold")) {
      throw err;
    }
    // If not a valid zip archive (e.g. legacy binary .doc or raw stream), continue
  }
}

export class OfficeConverter {
  private cachedBinaryPath: string | null | undefined = undefined;

  async resolveConverterBinary(): Promise<string | null> {
    if (this.cachedBinaryPath !== undefined) {
      return this.cachedBinaryPath;
    }

    const candidates = [
      process.env.ATLAS_OFFICE_CONVERTER_PATH,
      "/opt/homebrew/bin/soffice",
      "/usr/local/bin/soffice",
      "/usr/bin/soffice",
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      "/opt/homebrew/bin/libreoffice",
      "/usr/local/bin/libreoffice",
      "/usr/bin/libreoffice",
      "soffice",
      "libreoffice",
    ].filter((p): p is string => Boolean(p));

    for (const candidate of candidates) {
      if (candidate.startsWith("/")) {
        if (existsSync(candidate)) {
          this.cachedBinaryPath = candidate;
          return candidate;
        }
      } else {
        // Try testing candidate in PATH
        try {
          const testRes = await new Promise<boolean>((resolve) => {
            const proc = spawn(candidate, ["--version"], {
              env: {
                PATH: process.env.PATH || "/usr/bin:/bin:/opt/homebrew/bin",
              },
              stdio: "ignore",
            });
            proc.on("error", () => resolve(false));
            proc.on("close", (code) => resolve(code === 0));
          });
          if (testRes) {
            this.cachedBinaryPath = candidate;
            return candidate;
          }
        } catch {
          // ignore
        }
      }
    }

    this.cachedBinaryPath = null;
    return null;
  }

  async isAvailable(): Promise<boolean> {
    const bin = await this.resolveConverterBinary();
    return bin !== null;
  }

  isSupportedOfficeFormat(filename: string, mimeType?: string): boolean {
    const lowerName = filename.toLowerCase();
    const ext = lowerName.split(".").pop() || "";
    const officeExts = ["pptx", "ppt", "docx", "doc", "rtf", "odt", "odp"];
    if (officeExts.includes(ext)) {
      return true;
    }

    const officeMimes = [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "application/rtf",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.presentation",
    ];
    return Boolean(mimeType && officeMimes.includes(mimeType));
  }

  async convertOfficeToPdf(input: {
    buffer: Buffer;
    filename: string;
    maxOutputBytes?: number;
    timeoutMs?: number;
  }): Promise<OfficeConversionResult> {
    const startTime = Date.now();
    const maxOutputBytes = input.maxOutputBytes ?? MAX_DERIVED_PDF_SIZE_BYTES;
    const timeoutMs = input.timeoutMs ?? OFFICE_CONVERSION_TIMEOUT_MS;

    if (input.buffer.length > MAX_OFFICE_FILE_SIZE_BYTES) {
      throw new Error(
        `File size (${Math.round(input.buffer.length / 1024 / 1024)}MB) exceeds maximum office conversion limit (${MAX_OFFICE_FILE_SIZE_BYTES / 1024 / 1024}MB).`
      );
    }

    // Security pre-flight: check zip archive bounds and zip bomb patterns
    inspectZipBombSafety(input.buffer);

    const converterBinary = await this.resolveConverterBinary();
    if (!converterBinary) {
      throw new Error(
        "Office converter binary (soffice/libreoffice) not available on host system."
      );
    }

    // Create unique temporary workspace directory
    const tempDir = await fs.mkdtemp(join(tmpdir(), "atlas-office-worker-"));
    const userProfileDir = join(tempDir, "user-profile");
    await fs.mkdir(userProfileDir, { recursive: true });

    const safeBaseName = basename(input.filename).replace(/[^\w.-]/g, "_");
    const inputFilePath = join(tempDir, safeBaseName);
    await fs.writeFile(inputFilePath, input.buffer);

    // Prepare strictly sanitized environment: NO database credentials, API keys, or provider secrets
    const sanitizedEnv: NodeJS.ProcessEnv = {
      HOME: tempDir,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH:
        process.env.PATH || "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
      TMPDIR: tempDir,
    };

    const args = [
      `-env:UserInstallation=file://${userProfileDir}`,
      "--headless",
      "--invisible",
      "--nodefault",
      "--nofirststartwizard",
      "--nolockcheck",
      "--nologo",
      "--norestore",
      "--convert-to",
      "pdf",
      "--outdir",
      tempDir,
      inputFilePath,
    ];

    try {
      const { exitCode, stderr } = await new Promise<{
        exitCode: number;
        stderr: string;
      }>((resolve, reject) => {
        let timer: NodeJS.Timeout | null = null;
        let killed = false;

        const child = spawn(converterBinary, args, {
          cwd: tempDir,
          env: sanitizedEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let errOutput = "";
        child.stderr?.on("data", (chunk) => {
          errOutput += chunk.toString("utf8");
        });

        timer = setTimeout(() => {
          killed = true;
          try {
            child.kill("SIGTERM");
            setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // ignore
              }
            }, 1000);
          } catch {
            // ignore
          }
          reject(
            new Error(
              `Office conversion worker timed out after ${timeoutMs}ms.`
            )
          );
        }, timeoutMs);

        child.on("error", (err) => {
          if (timer) {
            clearTimeout(timer);
          }
          reject(err);
        });

        child.on("close", (code) => {
          if (timer) {
            clearTimeout(timer);
          }
          if (killed) {
            return;
          }
          resolve({
            exitCode: code ?? -1,
            stderr: errOutput,
          });
        });
      });

      if (exitCode !== 0) {
        throw new Error(
          `Office converter failed with exit code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`
        );
      }

      // Expected output PDF path: <tempDir>/<baseNameWithoutExt>.pdf
      const outputPdfName = safeBaseName.replace(/\.[^.]+$/, "") + ".pdf";
      const outputPdfPath = join(tempDir, outputPdfName);

      if (!existsSync(outputPdfPath)) {
        throw new Error(
          `Office conversion produced no output PDF file (expected: ${outputPdfName}).`
        );
      }

      const pdfBytes = await fs.readFile(outputPdfPath);

      if (pdfBytes.length === 0) {
        throw new Error("Office conversion produced an empty PDF file.");
      }

      if (pdfBytes.length > maxOutputBytes) {
        throw new Error(
          `Generated PDF size (${Math.round(pdfBytes.length / 1024 / 1024)}MB) exceeds maximum limit (${maxOutputBytes / 1024 / 1024}MB).`
        );
      }

      // Validate PDF signature
      const header = pdfBytes.subarray(0, 10).toString("ascii");
      if (!header.startsWith("%PDF-")) {
        throw new Error(
          "Generated PDF output does not have a valid %PDF- header signature."
        );
      }

      const pageCount = extractPdfPageCount(pdfBytes);
      const durationMs = Date.now() - startTime;

      return {
        converterVersion: OFFICE_CONVERTER_VERSION,
        durationMs,
        pageCount,
        pdfBytes,
      };
    } finally {
      // Guaranteed workspace cleanup: delete temporary directory and all generated files
      try {
        rmSync(tempDir, { force: true, recursive: true });
      } catch {
        // ignore cleanup error
      }
    }
  }
}

export const officeConverter = new OfficeConverter();
