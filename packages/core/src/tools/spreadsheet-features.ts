import { attribute, elements, parseXml } from "../office-document/xml";

const UNSUPPORTED_PARTS: Array<{ name: string; pattern: RegExp }> = [
  { name: "charts", pattern: /^xl\/charts\//i },
  { name: "pivot tables", pattern: /^xl\/(pivotTables|pivotCache)\//i },
  {
    name: "slicers and timelines",
    pattern: /^xl\/(slicers|slicerCaches|timelines|timelineCaches)\//i,
  },
  {
    name: "external data connections",
    pattern: /^xl\/(connections\.xml|queryTables\/|externalLinks\/)/i,
  },
  {
    name: "embedded objects and controls",
    pattern: /^xl\/(embeddings|activeX|ctrlProps)\//i,
  },
  {
    name: "custom XML",
    pattern: /^customXml\//i,
  },
  { name: "threaded comments", pattern: /^xl\/(threadedComments|persons)\//i },
  {
    name: "data models and macro sheets",
    pattern: /^xl\/(model|macrosheets)\//i,
  },
];
const UNSUPPORTED_EXTERNAL_FORMULA =
  /(?:WEBSERVICE|DDE|RTD|STOCKHISTORY|IMAGE|CALL|REGISTER\.ID|EXEC|RUN)\s*\(|\[[^\]]+\][^,;()]*!/i;

export function unsupportedSpreadsheetFeatures(
  parts: Record<string, Uint8Array>
): string[] {
  const names = Object.keys(parts);
  const features = new Set(
    UNSUPPORTED_PARTS.filter(({ pattern }) =>
      names.some((name) => pattern.test(name))
    ).map(({ name }) => name)
  );
  for (const [part, bytes] of Object.entries(parts)) {
    if (part.toLowerCase() === "docprops/custom.xml") {
      const document = parseXml(bytes, part);
      // LibreOffice emits an empty custom-properties part during ordinary
      // recalculation. Meaningful properties cannot be round-tripped by ExcelJS.
      if (elements(document.documentElement, "property").length) {
        features.add("custom document properties");
      }
    }
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(part)) {
      const document = parseXml(bytes, part);
      if (elements(document.documentElement, "extLst").length) {
        features.add("extended worksheet features");
      }
    }
    if (/^xl\/drawings\/[^/]+\.xml$/i.test(part)) {
      const document = parseXml(bytes, part);
      if (
        ["sp", "grpSp", "cxnSp", "graphicFrame"].some(
          (name) => elements(document.documentElement, name).length
        )
      ) {
        features.add("drawing shapes or charts");
      }
    }
  }
  return [...features];
}

export function inspectUnsupportedSpreadsheet(
  parts: Record<string, Uint8Array>,
  features: string[]
) {
  const workbook = parseXml(parts["xl/workbook.xml"]!, "xl/workbook.xml");
  const sheets = elements(workbook.documentElement, "sheet").map((sheet) => ({
    name: attribute(sheet, "name"),
    state: attribute(sheet, "state") || "visible",
  }));
  return {
    coverage: "Workbook metadata only; cells were not read.",
    editable: false,
    sheetCount: sheets.length,
    sheets: sheets.slice(0, 64),
    unsupportedFeatures: features,
    warnings: [
      "This workbook contains features the spreadsheet tool cannot preserve. Use an assigned coding tool with an appropriate Office library or a desktop spreadsheet editor. The source is unchanged.",
    ],
  };
}

export function assertSpreadsheetRecalculationSafe(
  parts: Record<string, Uint8Array>
): void {
  for (const [part, bytes] of Object.entries(parts)) {
    if (part.endsWith(".rels")) {
      const document = parseXml(bytes, part);
      if (
        elements(document.documentElement, "Relationship").some(
          (relationship) =>
            attribute(relationship, "TargetMode") === "External" &&
            !attribute(relationship, "Type").endsWith("/hyperlink")
        )
      ) {
        throw new Error(
          "Recalculation does not support external document, image, or data relationships."
        );
      }
    }
    if (
      part === "xl/workbook.xml" ||
      /^xl\/worksheets\/[^/]+\.xml$/i.test(part)
    ) {
      const document = parseXml(bytes, part);
      const formulas = [
        ...elements(document.documentElement, "f"),
        ...elements(document.documentElement, "definedName"),
      ];
      if (
        formulas.some((formula) =>
          UNSUPPORTED_EXTERNAL_FORMULA.test(formula.textContent ?? "")
        )
      ) {
        throw new Error(
          "Recalculation does not support external-data formulas in cells or defined names."
        );
      }
    }
  }
}
