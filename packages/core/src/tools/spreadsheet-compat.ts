import path from "node:path";
import { zipSync } from "fflate";
import { readOfficeZipParts } from "../office-document/archive";
import {
  attribute,
  elements,
  parseXml,
  serializeXml,
} from "../office-document/xml";

const COMMENT_PART = /^xl\/(?:comments\/)?comments?\d+\.xml$/i;
const VML_PART = /^xl\/drawings\/[^/]+\.vml$/i;

/** ExcelJS only recognizes its own comment/VML names and relative targets.
 * Adapt already validated OPC parts in memory; the original bytes stay intact.
 */
export function spreadsheetBytesForExcelJs(
  parts: Record<string, Uint8Array>
): Uint8Array {
  const aliases = new Map<string, string>();
  let comment = 0;
  let drawing = 0;
  for (const name of Object.keys(parts)) {
    if (COMMENT_PART.test(name)) {
      aliases.set(name, `xl/comments${++comment}.xml`);
    } else if (VML_PART.test(name)) {
      aliases.set(name, `xl/drawings/vmlDrawing${++drawing}.vml`);
    }
  }
  const normalized: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(parts)) {
    let result = bytes;
    if (name.endsWith(".rels")) {
      const document = parseXml(bytes, name);
      const directory = path.posix.dirname(path.posix.dirname(name));
      for (const relationship of elements(
        document.documentElement,
        "Relationship"
      )) {
        if (attribute(relationship, "TargetMode") === "External") {
          continue;
        }
        const target = attribute(relationship, "Target");
        const resolved = path.posix.normalize(
          target.startsWith("/")
            ? target.slice(1)
            : path.posix.join(directory, target)
        );
        relationship.setAttribute(
          "Target",
          path.posix.relative(directory, aliases.get(resolved) ?? resolved)
        );
      }
      result = serializeXml(document);
    } else if (name === "[Content_Types].xml") {
      const document = parseXml(bytes, name);
      for (const override of elements(document.documentElement, "Override")) {
        const original = attribute(override, "PartName").replace(/^\//, "");
        const alias = aliases.get(original);
        if (alias) {
          override.setAttribute("PartName", `/${alias}`);
        }
      }
      result = serializeXml(document);
    }
    normalized[aliases.get(name) ?? name] = result;
  }
  return zipSync(normalized);
}

function relations(parts: Record<string, Uint8Array>, owner: string) {
  const parsed = path.posix.parse(owner);
  const name = path.posix.join(parsed.dir, "_rels", `${parsed.base}.rels`);
  if (!parts[name]) {
    return [];
  }
  return elements(parseXml(parts[name], name).documentElement, "Relationship")
    .filter((item) => attribute(item, "TargetMode") !== "External")
    .map((item) => {
      const target = attribute(item, "Target");
      return {
        id: attribute(item, "Id"),
        target: path.posix.normalize(
          target.startsWith("/")
            ? target.slice(1)
            : path.posix.join(parsed.dir, target)
        ),
        type: attribute(item, "Type"),
      };
    });
}

function sheets(parts: Record<string, Uint8Array>) {
  const relationships = relations(parts, "xl/workbook.xml");
  return elements(
    parseXml(parts["xl/workbook.xml"]!, "xl/workbook.xml").documentElement,
    "sheet"
  ).map((sheet) => ({
    name: attribute(sheet, "name"),
    part: relationships.find(
      (relationship) => relationship.id === attribute(sheet, "id")
    )?.target,
  }));
}

/** Range edits do not change notes or validation rules. ExcelJS rewrites note
 * authors/plain text and can duplicate validation ranges, so restore these
 * existing XML structures after serialization, matching worksheets by name.
 */
export function preserveSpreadsheetMetadata(
  original: Record<string, Uint8Array>,
  output: Uint8Array,
  replacedSheet?: string
): Uint8Array {
  const result = readOfficeZipParts(output);
  const destinations = sheets(result);
  for (const source of sheets(original)) {
    if (!source.part || source.name === replacedSheet) {
      continue;
    }
    const destination = destinations.find(
      (sheet) => sheet.name === source.name
    );
    if (!destination?.part) {
      continue;
    }
    const sourceXml = parseXml(original[source.part]!, source.part);
    const destinationXml = parseXml(
      result[destination.part]!,
      destination.part
    );
    const validation = elements(
      sourceXml.documentElement,
      "dataValidations"
    )[0];
    if (validation) {
      const generated = elements(
        destinationXml.documentElement,
        "dataValidations"
      )[0];
      if (!generated) {
        throw new Error("Spreadsheet output lost existing validation rules.");
      }
      generated.parentNode!.replaceChild(
        destinationXml.importNode(validation, true),
        generated
      );
      result[destination.part] = serializeXml(destinationXml);
    }
    // Color scales have no style-table references. Keeping their original XML
    // avoids LibreOffice rewriting priorities, endpoints and ARGB values during
    // recalculation. Other conditional formats may reference remapped dxf IDs.
    for (const formatting of elements(
      sourceXml.documentElement,
      "conditionalFormatting"
    )) {
      const rules = elements(formatting, "cfRule");
      if (
        !rules.length ||
        rules.some(
          (rule) =>
            attribute(rule, "type") !== "colorScale" ||
            rule.hasAttribute("dxfId")
        )
      ) {
        continue;
      }
      const generated = elements(
        destinationXml.documentElement,
        "conditionalFormatting"
      ).find(
        (item) => attribute(item, "sqref") === attribute(formatting, "sqref")
      );
      if (!generated) {
        throw new Error("Spreadsheet output lost existing color-scale rules.");
      }
      generated.parentNode!.replaceChild(
        destinationXml.importNode(formatting, true),
        generated
      );
      result[destination.part] = serializeXml(destinationXml);
    }
    const outputRelationships = relations(result, destination.part);
    for (const relationship of relations(original, source.part)) {
      if (!relationship.type.endsWith("/comments")) {
        continue;
      }
      const target = outputRelationships.find(
        (item) => item.type === relationship.type
      )?.target;
      if (!(target && original[relationship.target] && result[target])) {
        throw new Error("Spreadsheet output lost existing cell comments.");
      }
      result[target] = original[relationship.target]!;
    }
  }
  return zipSync(result);
}
