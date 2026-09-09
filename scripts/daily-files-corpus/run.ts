/** Run every predeclared case. Does not classify refusal as success. */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeProtectedTool } from "../../packages/core/src/tools/execution";
import { officeDocumentTool } from "../../packages/core/src/tools/office-document";
import { pdfDocumentTool } from "../../packages/core/src/tools/pdf-document";
import { spreadsheetTool } from "../../packages/core/src/tools/spreadsheet";

interface CaseDefinition {
  directory: string;
  expected: Record<string, unknown>;
  id: string;
  sources: Array<{ path: string; sha256: string }>;
}
interface Step {
  error?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  tool: string;
}
const root = path.resolve(
  process.argv[2] ?? "/private/tmp/atlas-daily-files-corpus"
);
const attempt =
  process.argv[3] ?? new Date().toISOString().replaceAll(":", "-");
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8")
) as { cases: CaseDefinition[] };
const directory = path.join(root, "attempts", attempt);
await mkdir(path.dirname(directory), { recursive: true });
await mkdir(directory);
const records: Array<{
  id: string;
  directory: string;
  steps: Step[];
  error?: string;
  durationMs: number;
}> = [];

for (const entry of manifest.cases) {
  const workspace = path.join(directory, entry.id);
  await mkdir(workspace, { recursive: true });
  for (const source of entry.sources) {
    await copyFile(
      path.join(entry.directory, source.path),
      path.join(workspace, source.path)
    );
  }
  const steps: Step[] = [];
  const signal = AbortSignal.timeout(120_000);
  const context = {
    orgId: "org_corpus",
    profileId: "profile_corpus",
    signal,
    userId: "user_corpus",
    workspaceRoot: workspace,
  };
  const call = async (tool: string, input: Record<string, unknown>) => {
    const step: Step = { input, tool };
    steps.push(step);
    try {
      const definition =
        tool === "office_document"
          ? officeDocumentTool
          : tool === "spreadsheet"
            ? spreadsheetTool
            : pdfDocumentTool;
      const executed = await executeProtectedTool(definition, input, context, {
        retryPolicy: { maxRetries: 0 },
        timeoutMs: 120_000,
      });
      if (!executed.success) {
        throw new Error(executed.error?.message ?? "Protected tool failed");
      }
      const output = executed.data as Record<string, unknown>;
      step.output = output;
      return output;
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  const office = (input: Record<string, unknown>) =>
    call("office_document", input);
  const sheet = (input: Record<string, unknown>) => call("spreadsheet", input);
  const pdf = (input: Record<string, unknown>) => call("pdf_document", input);
  const editedOffice = async (reference: string, edits: unknown[]) => {
    const saved = await office({
      documentRef: reference,
      edits,
      operation: "edit",
    });
    await office({
      documentRef: saved.path,
      limit: 100,
      operation: "read",
      start: 1,
    });
    return saved;
  };
  const started = performance.now();
  let failure: string | undefined;
  try {
    switch (entry.id) {
      case "D01":
        await editedOffice("input.docx", [
          {
            expectedMatches: 1,
            find: "Résumé en attente",
            kind: "replace_text",
            paragraph: 1,
            replace: "Résumé validé",
          },
        ]);
        break;
      case "D02":
        await editedOffice("input.docx", [
          {
            column: 2,
            expectedText: "Inner draft",
            kind: "set_table_cell",
            row: 2,
            table: 2,
            text: "Inner approved",
          },
        ]);
        break;
      case "D03":
        await office({
          documentRef: "input.docx",
          edits: [
            {
              expectedMatches: 1,
              find: "Inserted draft",
              kind: "replace_text",
              replace: "Inserted approved",
            },
          ],
          operation: "edit",
          revisionAuthor: "Atlas",
          trackChanges: true,
        });
        break;
      case "D04": {
        const inspected = await office({
          documentRef: "input.docx",
          limit: 100,
          operation: "inspect",
          start: 1,
        });
        const units = inspected.units as Array<{ index: number; kind: string }>;
        let target: number | undefined;
        for (const unit of units.filter((unit) => unit.kind === "header")) {
          const text = await office({
            documentRef: "input.docx",
            limit: 100,
            operation: "read",
            start: 1,
            unit: unit.index,
          });
          if (JSON.stringify(text).includes("Second section draft")) {
            target = unit.index;
          }
        }
        if (!target) {
          throw new Error("The second section header was not discoverable.");
        }
        await editedOffice("input.docx", [
          {
            expectedMatches: 1,
            find: "Second section draft",
            kind: "replace_text",
            replace: "Second section approved",
            unit: target,
          },
        ]);
        break;
      }
      case "P01":
        await editedOffice("input.pptx", [
          {
            expectedMatches: 1,
            find: "Quarter draft",
            kind: "replace_text",
            replace: "Quarter approved",
          },
        ]);
        break;
      case "P02":
        await editedOffice("input.pptx", [
          {
            expectedMatches: 1,
            find: "Grouped draft",
            kind: "replace_text",
            replace: "Grouped approved",
          },
        ]);
        break;
      case "P03":
        await editedOffice("input.pptx", [
          {
            column: 1,
            expectedText: "Merged draft",
            kind: "set_table_cell",
            row: 1,
            table: 1,
            text: "Merged approved",
          },
        ]);
        break;
      case "P04":
        await editedOffice("input.pptx", [
          {
            expectedMatches: 1,
            find: "قيد المراجعة",
            kind: "replace_text",
            replace: "تمت المراجعة",
          },
        ]);
        break;
      case "X01": {
        await sheet({
          action: "read_range",
          path: "input.xlsx",
          range: "A1:D2",
          sheetName: "Records",
        });
        const saved = await sheet({
          action: "write_range",
          path: "input.xlsx",
          range: "C2",
          sheetName: "Records",
          values: [[11]],
        });
        await sheet({
          action: "read_range",
          path: saved.path,
          range: "A1:D2",
          sheetName: "Records",
        });
        break;
      }
      case "X02": {
        const saved = await sheet({
          action: "write_range",
          path: "input.xlsx",
          range: "C2",
          sheetName: "Data",
          values: [[11]],
        });
        const calculated = await sheet({
          action: "recalculate",
          path: saved.path,
        });
        await sheet({
          action: "read_range",
          path: calculated.path,
          range: "B2:B4",
          sheetName: "Summary",
        });
        break;
      }
      case "X03":
        await sheet({ action: "inspect", path: "input.xlsx" });
        await sheet({
          action: "write_range",
          path: "input.xlsx",
          range: "B2",
          sheetName: "Chart data",
          values: [[12]],
        });
        break;
      case "X04": {
        const saved = await sheet({
          action: "write_range",
          path: "input.xlsx",
          range: "B2",
          sheetName: "Table data",
          values: [[12]],
        });
        const calculated = await sheet({
          action: "recalculate",
          path: saved.path,
        });
        await sheet({
          action: "read_range",
          path: calculated.path,
          range: "A1:B4",
          sheetName: "Table data",
        });
        break;
      }
      case "C01":
      case "C03": {
        const imported = await sheet({
          action: "import_csv",
          csvPath: "input.csv",
          delimiter: entry.expected.delimiter,
          path: "imported.xlsx",
        });
        await sheet({
          action: "read_range",
          path: imported.path,
          range: "A1:D3",
        });
        await sheet({
          action: "export_csv",
          delimiter: entry.expected.delimiter,
          escapeCsvFormulas: false,
          path: imported.path,
          targetCsvPath: "exported.csv",
        });
        break;
      }
      case "C02":
        await sheet({
          action: "import_csv",
          columnTypes: ["text", "number"],
          csvHeader: true,
          csvPath: "input.csv",
          decimalSeparator: ",",
          delimiter: ";",
          path: "imported.xlsx",
        });
        break;
      case "F01":
        await pdf({
          documentRef: "input.pdf",
          operation: "extract",
          pages: [3, 2],
        });
        break;
      case "F02":
        await pdf({ documentRef: "input.pdf", operation: "inspect" });
        await pdf({ documentRef: "input.pdf", operation: "extract" });
        break;
      case "F03":
        await pdf({ documentRef: "input.pdf", operation: "extract" });
        break;
      case "F04":
        await pdf({
          operation: "merge",
          outputFilename: "combined.pdf",
          sources: ["input.pdf", "appendix.pdf"],
        });
        break;
      case "F05":
        await pdf({
          fontRef: "covering.ttf",
          operation: "create",
          outputFilename: "multilingual.pdf",
          textPages: [entry.expected.text],
        });
        break;
      case "W01": {
        const imported = await sheet({
          action: "import_csv",
          columnTypes: ["text", "number"],
          csvHeader: true,
          csvPath: "records.csv",
          path: "summary.xlsx",
        });
        const formula = await sheet({
          action: "write_range",
          path: imported.path,
          range: "B5",
          sheetName: "records",
          values: [["=SUM(B2:B4)"]],
        });
        const computed = await sheet({
          action: "recalculate",
          path: formula.path,
        });
        const range = await sheet({
          action: "read_range",
          path: computed.path,
          range: "B5",
          sheetName: "records",
        });
        const rows = range.rows as Array<Array<{ cachedResult?: unknown }>>;
        const total = rows[0]?.[0]?.cachedResult;
        if (typeof total !== "number") {
          throw new Error("Formula result was not a verified number.");
        }
        const report = await editedOffice("report.docx", [
          {
            expectedMatches: 1,
            find: "PLACEHOLDER",
            kind: "replace_text",
            replace: String(total),
          },
        ]);
        await editedOffice("summary.pptx", [
          {
            expectedMatches: 1,
            find: "PLACEHOLDER",
            kind: "replace_text",
            replace: String(total),
          },
        ]);
        const reportPdf = await pdf({
          documentRef: report.path,
          operation: "convert",
          outputFilename: "report.pdf",
        });
        const combined = await pdf({
          operation: "merge",
          outputFilename: "packet.pdf",
          sources: [reportPdf.path, "appendix.pdf"],
        });
        await pdf({ documentRef: combined.path, operation: "extract" });
        break;
      }
      default:
        throw new Error(`Undeclared case ${entry.id}`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const record = {
    directory: workspace,
    durationMs: Math.round(performance.now() - started),
    error: failure,
    id: entry.id,
    steps,
  };
  records.push(record);
  await writeFile(
    path.join(directory, "execution.json"),
    JSON.stringify(
      {
        attempt,
        boundary: "executeProtectedTool",
        converter: process.env.ATLAS_OFFICE_CONVERTER_PATH ?? null,
        records,
      },
      null,
      2
    )
  );
  process.stdout.write(
    JSON.stringify({
      durationMs: record.durationMs,
      error: failure ?? null,
      id: entry.id,
      steps: steps.length,
    }) + "\n"
  );
}
process.stdout.write(
  JSON.stringify({
    attempt,
    execution: path.join(directory, "execution.json"),
  }) + "\n"
);
