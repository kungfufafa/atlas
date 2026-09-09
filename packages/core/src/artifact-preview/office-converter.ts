import { spawn } from "node:child_process";
import { existsSync, promises as fs, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readOfficeZipParts } from "../office-document/archive";
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
  if (buffer.subarray(0, 2).toString("ascii") !== "PK") {
    // Legacy binary formats do not use ZIP; LibreOffice owns their parser.
    return;
  }
  const parts = readOfficeZipParts(buffer);
  for (const [name, bytes] of Object.entries(parts)) {
    if (
      name.startsWith("xl/externalLinks/") ||
      name.endsWith("vbaProject.bin")
    ) {
      throw new Error(
        "Office conversion requires a source without macros or external workbook links."
      );
    }
    if (
      name.startsWith("xl/worksheets/") &&
      /(?:WEBSERVICE|DDE|RTD|HYPERLINK)\s*\(/i.test(
        Buffer.from(bytes).toString("utf8")
      )
    ) {
      throw new Error(
        "Office conversion requires a workbook without external-data formulas."
      );
    }
  }
}

function assertOfficeOutputSize(
  size: number,
  maxBytes: number,
  format: "pdf" | "xlsx"
): void {
  if (size === 0) {
    throw new Error(`Office conversion produced an empty ${format} file.`);
  }
  if (size > maxBytes) {
    throw new Error(
      `Generated ${format} size (${Math.round(size / 1024 / 1024)}MB) exceeds maximum limit (${maxBytes / 1024 / 1024}MB).`
    );
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
    const officeExts = [
      "pptx",
      "ppt",
      "docx",
      "doc",
      "rtf",
      "odt",
      "odp",
      "xlsx",
      "xls",
      "ods",
    ];
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
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/vnd.oasis.opendocument.spreadsheet",
    ];
    return Boolean(mimeType && officeMimes.includes(mimeType));
  }

  async convertOfficeToPdf(input: {
    buffer: Buffer;
    filename: string;
    maxOutputBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<OfficeConversionResult> {
    const converted = await this.convertOfficeFile({ ...input, format: "pdf" });
    const header = converted.bytes.subarray(0, 10).toString("ascii");
    if (!header.startsWith("%PDF-")) {
      throw new Error(
        "Generated PDF output does not have a valid %PDF- header signature."
      );
    }
    return {
      converterVersion: OFFICE_CONVERTER_VERSION,
      durationMs: converted.durationMs,
      pageCount: extractPdfPageCount(converted.bytes),
      pdfBytes: converted.bytes,
    };
  }

  async convertOfficeToXlsx(input: {
    buffer: Buffer;
    filename: string;
    maxOutputBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ bytes: Buffer; converterVersion: string }> {
    const converted = await this.convertOfficeFile({
      ...input,
      format: "xlsx",
    });
    const parts = readOfficeZipParts(converted.bytes);
    if (!parts["xl/workbook.xml"]) {
      throw new Error("Office conversion did not produce an XLSX workbook.");
    }
    return {
      bytes: converted.bytes,
      converterVersion: OFFICE_CONVERTER_VERSION,
    };
  }

  private async convertOfficeFile(input: {
    buffer: Buffer;
    filename: string;
    format: "pdf" | "xlsx";
    maxOutputBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ bytes: Buffer; durationMs: number }> {
    input.signal?.throwIfAborted();
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
    try {
      const userProfileDir = join(tempDir, "user-profile");
      await fs.mkdir(userProfileDir, { recursive: true });
      await fs.mkdir(join(userProfileDir, "user"), { recursive: true });
      await fs.writeFile(
        join(userProfileDir, "user", "registrymodifications.xcu"),
        '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>'
      );

      const safeBaseName = basename(input.filename).replace(/[^\w.-]/g, "_");
      const inputFilePath = join(tempDir, safeBaseName);
      await fs.writeFile(inputFilePath, input.buffer);
      const outputDirectory =
        input.format === "xlsx" ? join(tempDir, "output") : tempDir;
      await fs.mkdir(outputDirectory, { recursive: true });

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
        input.format === "xlsx" ? "xlsx:Calc MS Excel 2007 XML" : "pdf",
        "--outdir",
        outputDirectory,
        inputFilePath,
      ];

      const { exitCode, stderr } = await new Promise<{
        exitCode: number;
        stderr: string;
      }>((resolve, reject) => {
        let timer: NodeJS.Timeout | null = null;
        let failure: Error | undefined;
        let forceKill: ReturnType<typeof setTimeout> | undefined;

        const child = spawn(converterBinary, args, {
          cwd: tempDir,
          env: sanitizedEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let errOutput = "";
        child.stderr?.on("data", (chunk) => {
          if (errOutput.length < 64 * 1024) {
            errOutput += chunk
              .toString("utf8")
              .slice(0, 64 * 1024 - errOutput.length);
          }
        });
        child.stdout?.resume();

        const stop = (error: Error) => {
          failure ??= error;
          child.kill("SIGTERM");
          forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1000);
        };
        const onAbort = () => stop(new Error("Office conversion cancelled."));
        input.signal?.addEventListener("abort", onAbort, { once: true });
        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
          }
          if (forceKill) {
            clearTimeout(forceKill);
          }
          input.signal?.removeEventListener("abort", onAbort);
        };

        timer = setTimeout(() => {
          stop(
            new Error(
              `Office conversion worker timed out after ${timeoutMs}ms.`
            )
          );
        }, timeoutMs);

        child.on("error", (err) => {
          cleanup();
          reject(err);
        });

        child.on("close", (code) => {
          cleanup();
          if (failure) {
            reject(failure);
            return;
          }
          resolve({
            exitCode: code ?? -1,
            stderr: errOutput,
          });
        });
        if (input.signal?.aborted) {
          onAbort();
        }
      });

      if (exitCode !== 0) {
        throw new Error(
          `Office converter failed with exit code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`
        );
      }

      const outputName = `${safeBaseName.replace(/\.[^.]+$/, "")}.${input.format}`;
      const outputPath = join(outputDirectory, outputName);

      if (!existsSync(outputPath)) {
        throw new Error(
          `Office conversion produced no output file (expected: ${outputName}).`
        );
      }

      input.signal?.throwIfAborted();
      // The worker has exited and owns a private directory. Check its output
      // before readFile allocates a buffer, then verify the bytes actually read.
      const outputStat = await fs.stat(outputPath);
      if (!outputStat.isFile()) {
        throw new Error("Office conversion output is not a regular file.");
      }
      assertOfficeOutputSize(outputStat.size, maxOutputBytes, input.format);
      const bytes = await fs.readFile(outputPath, {
        signal: input.signal,
      });
      assertOfficeOutputSize(bytes.length, maxOutputBytes, input.format);

      return {
        bytes,
        durationMs: Date.now() - startTime,
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

  async convertOfficeToPng(input: {
    buffer: Buffer;
    filename: string;
    timeoutMs?: number;
  }): Promise<{ converterVersion: string; pngBytes: Buffer }> {
    inspectZipBombSafety(input.buffer);
    const converterBinary = await this.resolveConverterBinary();
    if (!converterBinary) {
      throw new Error(
        "Office converter binary (soffice/libreoffice) not available on host system."
      );
    }

    const tempDir = await fs.mkdtemp(join(tmpdir(), "atlas-office-thumb-"));
    try {
      const userProfileDir = join(tempDir, "user-profile");
      await fs.mkdir(userProfileDir, { recursive: true });
      const safeBaseName = basename(input.filename).replace(/[^\w.-]/g, "_");
      const inputFilePath = join(tempDir, safeBaseName);
      await fs.writeFile(inputFilePath, input.buffer);

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
        "png",
        "--outdir",
        tempDir,
        inputFilePath,
      ];

      await new Promise<void>((resolve, reject) => {
        const child = spawn(converterBinary, args, {
          cwd: tempDir,
          env: {
            HOME: tempDir,
            PATH:
              process.env.PATH ||
              "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
            TMPDIR: tempDir,
          },
          stdio: "ignore",
        });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("Office thumbnail conversion timed out."));
        }, input.timeoutMs ?? OFFICE_CONVERSION_TIMEOUT_MS);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`Office thumbnail conversion failed (${code}).`));
        });
      });

      const entries = await fs.readdir(tempDir);
      const pngName = entries
        .filter((name) => name.toLowerCase().endsWith(".png"))
        .sort()[0];
      if (!pngName) {
        throw new Error("Office conversion produced no PNG thumbnail.");
      }
      const pngBytes = await fs.readFile(join(tempDir, pngName));
      if (pngBytes.length < 8 || pngBytes[0] !== 0x89 || pngBytes[1] !== 0x50) {
        throw new Error("Generated thumbnail is not a PNG.");
      }
      return { converterVersion: OFFICE_CONVERTER_VERSION, pngBytes };
    } finally {
      try {
        rmSync(tempDir, { force: true, recursive: true });
      } catch {
        // ignore
      }
    }
  }
}

export const officeConverter = new OfficeConverter();
