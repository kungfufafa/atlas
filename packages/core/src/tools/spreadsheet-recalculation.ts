import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import { lineageMetaPath } from "../artifact-lineage";
import { officeConverter } from "../artifact-preview/office-converter";
import {
  assertWorkbookBounds,
  spreadsheetCellValue,
} from "./spreadsheet-cells";
import {
  assertSpreadsheetRecalculationSafe,
  unsupportedSpreadsheetFeatures,
} from "./spreadsheet-features";
import {
  inspectSpreadsheetArchive,
  readSpreadsheetBytes,
} from "./spreadsheet-io";

import { restoreEmptyFormulaResults } from "./spreadsheet-ooxml";

const RECALCULATION_TIMEOUT_MS = 30_000;
const CALCULATION_ENGINE = "LibreOffice Calc";

export async function readSpreadsheetCalculation(
  filePath: string,
  revision: string
): Promise<"recalculated" | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(lineageMetaPath(filePath), "utf8")
    );
    if (
      value &&
      typeof value === "object" &&
      "spreadsheetCalculation" in value
    ) {
      const calculation = value.spreadsheetCalculation;
      if (
        calculation &&
        typeof calculation === "object" &&
        "contentSha256" in calculation &&
        calculation.contentSha256 === revision &&
        "engine" in calculation &&
        calculation.engine === CALCULATION_ENGINE
      ) {
        return "recalculated";
      }
    }
  } catch {
    // Missing or outdated provenance never upgrades cached values to verified.
  }
}

export async function recordSpreadsheetCalculation(
  filePath: string,
  revision: string
): Promise<void> {
  const metadataPath = lineageMetaPath(filePath);
  const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Spreadsheet metadata is invalid.");
  }
  const temporary = `${metadataPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        ...metadata,
        spreadsheetCalculation: {
          contentSha256: revision,
          engine: CALCULATION_ENGINE,
        },
      }),
      { flag: "wx", mode: 0o600 }
    );
    await rename(temporary, metadataPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function runRecalculationProcess(
  binary: string,
  args: string[],
  directory: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: directory,
      env: {
        HOME: directory,
        LANG: "en_US.UTF-8",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: directory,
      },
      stdio: "ignore",
    });
    let failure: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const onAbort = () =>
      stop(new Error("Spreadsheet recalculation cancelled."));
    const timeout = setTimeout(
      () =>
        stop(
          new Error("Spreadsheet recalculation timed out after 30 seconds.")
        ),
      RECALCULATION_TIMEOUT_MS
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKill) {
        clearTimeout(forceKill);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (failure || code !== 0) {
        reject(
          failure ?? new Error(`LibreOffice recalculation failed (${code}).`)
        );
      } else {
        resolve();
      }
    });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

export async function recalculateSpreadsheet(
  bytes: Buffer,
  signal?: AbortSignal,
  resolveBinary = () => officeConverter.resolveConverterBinary()
): Promise<{
  bytes: Buffer;
  engine: string;
  formulaErrorCount: number;
  formulaErrors: { address: string; error: string; sheet: string }[];
}> {
  signal?.throwIfAborted();
  const parts = inspectSpreadsheetArchive(bytes);
  const unsupported = unsupportedSpreadsheetFeatures(parts);
  if (unsupported.length) {
    throw new Error(
      `Recalculation cannot preserve these workbook features: ${unsupported.join(", ")}. Use a desktop spreadsheet editor.`
    );
  }
  assertSpreadsheetRecalculationSafe(parts);
  unzipSync(bytes, {
    filter(file) {
      if (
        file.name.startsWith("xl/externalLinks/") ||
        file.name.startsWith("xl/macrosheets/") ||
        file.name.endsWith("vbaProject.bin")
      ) {
        throw new Error(
          "Recalculation requires a workbook without macros or external workbook links."
        );
      }
      return false;
    },
  });
  const binary = await resolveBinary();
  if (!binary) {
    throw new Error(
      "Recalculation requires LibreOffice on the Atlas host. Install LibreOffice or set ATLAS_OFFICE_CONVERTER_PATH to soffice, then retry recalculate."
    );
  }
  const original = new ExcelJS.Workbook();
  await original.xlsx.load(Uint8Array.from(bytes).buffer);
  assertWorkbookBounds(original);
  for (const sheet of original.worksheets) {
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (
          cell.formula &&
          /(?:WEBSERVICE|DDE|RTD|STOCKHISTORY|IMAGE|CALL|REGISTER\.ID|EXEC|RUN)\s*\(|\[[^\]]+\][^,;()]*!/i.test(
            cell.formula
          )
        ) {
          throw new Error(
            "Recalculation does not support external-data formulas. Replace external data with local values first."
          );
        }
      })
    );
  }
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-sheet-recalc-"));
  try {
    const output = path.join(directory, "output");
    const profile = path.join(directory, "profile");
    await mkdir(output);
    await mkdir(path.join(profile, "user"), { recursive: true });
    // Disable document macros and external link refresh in the temporary profile.
    await writeFile(
      path.join(profile, "user", "registrymodifications.xcu"),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>'
    );
    const input = path.join(directory, "workbook.xlsx");
    await writeFile(input, bytes);
    await runRecalculationProcess(
      binary,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--nodefault",
        "--nofirststartwizard",
        "--norestore",
        "--convert-to",
        "xlsx:Calc MS Excel 2007 XML",
        "--outdir",
        output,
        input,
      ],
      directory,
      signal
    );
    signal?.throwIfAborted();
    const calculated = await readSpreadsheetBytes(
      path.join(output, "workbook.xlsx")
    );
    const calculatedParts = inspectSpreadsheetArchive(calculated);
    const verified = new ExcelJS.Workbook();
    await verified.xlsx.load(Uint8Array.from(calculated).buffer);
    assertWorkbookBounds(verified);
    restoreEmptyFormulaResults(verified, calculatedParts);
    const formulaErrors: { address: string; error: string; sheet: string }[] =
      [];
    let formulaErrorCount = 0;
    if (verified.worksheets.length !== original.worksheets.length) {
      throw new Error("Recalculation changed the workbook sheet count.");
    }
    for (const sheet of original.worksheets) {
      const calculatedSheet = verified.getWorksheet(sheet.name);
      if (!calculatedSheet) {
        throw new Error("Recalculation changed the workbook sheet names.");
      }
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          if (!cell.formula) {
            return;
          }
          const outputCell = calculatedSheet.getCell(cell.address);
          if (!outputCell.formula || outputCell.result === undefined) {
            throw new Error(
              `No calculated result for ${sheet.name}!${cell.address}. Open the workbook in Excel to calculate unsupported formulas.`
            );
          }
          const result = spreadsheetCellValue(outputCell, "recalculated");
          if (
            result &&
            typeof result === "object" &&
            "cachedResult" in result &&
            result.cachedResult &&
            typeof result.cachedResult === "object"
          ) {
            formulaErrorCount += 1;
            if (formulaErrors.length < 100) {
              formulaErrors.push({
                address: cell.address,
                error: result.cachedResult.error,
                sheet: sheet.name,
              });
            }
          }
        })
      );
    }
    return {
      bytes: calculated,
      engine: CALCULATION_ENGINE,
      formulaErrorCount,
      formulaErrors,
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
