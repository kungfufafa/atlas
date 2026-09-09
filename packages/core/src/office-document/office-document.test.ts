import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { officeDocumentTool } from "../tools/office-document";
import { openOfficeArchive, saveOfficeArchive } from "./archive";
import { OfficeDocument } from "./document";
import {
  createPresentationFixture,
  createWordFixture,
} from "./testing/fixtures";
import {
  elements,
  PRESENTATION_NAMESPACES,
  parseXml,
  serializeXml,
} from "./xml";

const directories: string[] = [];
const wordFixture = createWordFixture();
const presentationFixture = createPresentationFixture();

afterAll(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function workspace(bytes: Uint8Array, extension: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-office-test-"));
  directories.push(directory);
  const filename = `original.${extension}`;
  await writeFile(path.join(directory, filename), bytes);
  return { context: { workspaceRoot: directory }, directory, filename };
}

function resultPath(result: unknown): string {
  if (
    !result ||
    typeof result !== "object" ||
    !("path" in result) ||
    typeof result.path !== "string"
  ) {
    throw new Error("Expected an artifact result.");
  }
  return result.path;
}

describe("Office document inspection and preservation", () => {
  test("edits an independent PowerPoint merged anchor without changing its span and rejects continuation cells", async () => {
    const original = await readFile(
      new URL("../testing/fixtures/pptx-merged-python.pptx", import.meta.url)
    );
    const fixture = await workspace(original, "pptx");
    const saved = await officeDocumentTool.run(
      {
        documentRef: fixture.filename,
        edits: [
          {
            column: 1,
            expectedText: "Merged draft",
            kind: "set_table_cell",
            row: 1,
            table: 1,
            text: "Merged approved",
          },
        ],
        operation: "edit",
      },
      fixture.context
    );
    const after = unzipSync(
      await readFile(path.join(fixture.directory, resultPath(saved)))
    );
    const before = unzipSync(original);
    const slide = parseXml(after["ppt/slides/slide1.xml"]!, "slide");
    const anchor = elements(slide.documentElement, "tc")[0]!;
    expect(anchor.getAttribute("gridSpan")).toBe("2");
    expect(anchor.textContent).toContain("Merged approved");
    for (const [name, bytes] of Object.entries(before)) {
      if (name !== "ppt/slides/slide1.xml") {
        expect(after[name]).toEqual(bytes);
      }
    }
    await expect(
      officeDocumentTool.run(
        {
          documentRef: fixture.filename,
          edits: [
            {
              column: 2,
              expectedText: "",
              kind: "set_table_cell",
              row: 1,
              table: 1,
              text: "Must not become visible",
            },
          ],
          operation: "edit",
        },
        fixture.context
      )
    ).rejects.toThrow();
    expect(
      await readFile(path.join(fixture.directory, fixture.filename))
    ).toEqual(original);
  });
  test("reads Word paragraphs, related headers, and table rows with explicit coverage", async () => {
    const document = new OfficeDocument(openOfficeArchive(await wordFixture));
    expect(document.inspect(1, 10)).toMatchObject({
      format: "docx",
      imageParts: 1,
      units: expect.arrayContaining([
        expect.objectContaining({ index: 1, kind: "document" }),
        expect.objectContaining({ kind: "header" }),
        expect.objectContaining({ kind: "footer" }),
      ]),
    });
    expect(document.read({ limit: 1, start: 1 })).toMatchObject({
      coverage: { complete: false, nextStart: 2, returned: 1 },
      paragraphs: [{ index: 1, text: "Hello Atlas", truncated: false }],
    });
    expect(
      document.read({
        columnLimit: 1,
        columnStart: 2,
        limit: 1,
        start: 2,
        table: 1,
      })
    ).toMatchObject({
      coverage: { returned: 1, total: 2 },
      rows: [{ cells: [{ column: 2, text: "Draft" }], index: 2 }],
    });
  });

  test("replaces split Word runs and table cells without touching images, styles, or relationships", async () => {
    const original = await wordFixture;
    const fixture = await workspace(original, "docx");
    const result = await officeDocumentTool.run(
      {
        documentRef: fixture.filename,
        edits: [
          {
            expectedMatches: 1,
            find: "Hello Atlas",
            kind: "replace_text",
            paragraph: 1,
            replace: "Welcome team",
          },
          {
            column: 2,
            expectedText: "Draft",
            kind: "set_table_cell",
            row: 2,
            table: 1,
            text: "Reviewed",
          },
        ],
        operation: "edit",
      },
      fixture.context
    );
    const editedBytes = await readFile(
      path.join(fixture.directory, resultPath(result))
    );
    const before = unzipSync(original);
    const after = unzipSync(editedBytes);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const name of Object.keys(before)) {
      if (name !== "word/document.xml") {
        expect(after[name]).toEqual(before[name]);
      }
    }
    const edited = new OfficeDocument(openOfficeArchive(editedBytes));
    expect(edited.read({ limit: 1, start: 1 })).toMatchObject({
      paragraphs: [{ text: "Welcome team" }],
    });
    expect(edited.read({ limit: 1, start: 2, table: 1 })).toMatchObject({
      rows: [{ cells: [{ text: "Atlas" }, { text: "Reviewed" }] }],
    });
    expect(
      await readFile(path.join(fixture.directory, fixture.filename))
    ).toEqual(original);
    const second = await officeDocumentTool.run(
      {
        documentRef: fixture.filename,
        edits: [
          {
            expectedMatches: 1,
            find: "Hello Atlas",
            kind: "replace_text",
            replace: "Another version",
          },
        ],
        operation: "edit",
        outputFilename: path.basename(resultPath(result)),
      },
      fixture.context
    );
    expect(resultPath(second)).not.toBe(resultPath(result));
    expect(
      await readFile(path.join(fixture.directory, resultPath(result)))
    ).toEqual(editedBytes);
  });

  test("edits slide text and notes while preserving masters, media, and every unrelated part", async () => {
    const original = await presentationFixture;
    const archive = openOfficeArchive(original);
    const document = new OfficeDocument(archive);
    expect(document.inspect(1, 10)).toMatchObject({
      format: "pptx",
      units: [
        { index: 1, notesAvailable: true },
        { index: 2, notesAvailable: true },
      ],
    });
    const changedParts = document.edit([
      {
        expectedMatches: 1,
        find: "Hello Atlas",
        kind: "replace_text",
        replace: "Welcome team",
        unit: 1,
      },
      {
        expectedMatches: 1,
        find: "confirm results",
        kind: "replace_text",
        replace: "confirm delivery",
        section: "notes",
        unit: 1,
      },
      {
        column: 2,
        expectedText: "Draft",
        kind: "set_table_cell",
        row: 2,
        table: 1,
        text: "Reviewed",
      },
    ]);
    const output = saveOfficeArchive(archive);
    const before = unzipSync(original);
    const after = unzipSync(output);
    for (const name of Object.keys(before)) {
      if (!changedParts.includes(name)) {
        expect(after[name]).toEqual(before[name]);
      }
    }
    const edited = new OfficeDocument(openOfficeArchive(output));
    expect(edited.read({ limit: 1, start: 1, unit: 1 })).toMatchObject({
      paragraphs: [{ text: "Welcome team" }],
    });
    expect(
      JSON.stringify(
        edited.read({ limit: 40, section: "notes", start: 1, unit: 1 })
      )
    ).toContain("confirm delivery");
  });

  test("uses presentation relationship order rather than slide filenames", async () => {
    const parts = unzipSync(await presentationFixture);
    const presentation = parseXml(
      parts["ppt/presentation.xml"]!,
      "presentation"
    );
    const slides = elements(
      presentation.documentElement,
      "sldId",
      PRESENTATION_NAMESPACES
    );
    slides[0]!.parentNode!.appendChild(slides[0]!);
    parts["ppt/presentation.xml"] = serializeXml(presentation);
    const document = new OfficeDocument(openOfficeArchive(zipSync(parts)));
    expect(document.read({ limit: 1, start: 1, unit: 1 })).toMatchObject({
      paragraphs: [{ text: "Second slide" }],
    });
  });

  test("a wrong expected count creates no artifact and leaves the source unchanged", async () => {
    const original = await wordFixture;
    const fixture = await workspace(original, "docx");
    await expect(
      officeDocumentTool.run(
        {
          documentRef: fixture.filename,
          edits: [
            {
              expectedMatches: 99,
              find: "Atlas",
              kind: "replace_text",
              replace: "Changed",
            },
          ],
          operation: "edit",
        },
        fixture.context
      )
    ).rejects.toThrow();
    expect(
      await readFile(path.join(fixture.directory, fixture.filename))
    ).toEqual(original);
    expect(
      await readdir(path.join(fixture.directory, "artifacts")).catch(() => [])
    ).toEqual([]);
  });

  test("loads scoped attachment references and rejects a mismatched file extension", async () => {
    const original = await wordFixture;
    const fixture = await workspace(original, "docx");
    const result = await officeDocumentTool.run(
      {
        columnLimit: 20,
        columnStart: 1,
        documentRef: "att_sample",
        limit: 1,
        operation: "read",
        start: 1,
      },
      {
        ...fixture.context,
        loadAttachment: () =>
          Promise.resolve({
            bytes: original,
            filename: "attachment.docx",
            mediaType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
      }
    );
    expect(result).toMatchObject({ paragraphs: [{ text: "Hello Atlas" }] });
    await writeFile(path.join(fixture.directory, "mismatch.pptx"), original);
    await expect(
      officeDocumentTool.run(
        {
          documentRef: "mismatch.pptx",
          limit: 10,
          operation: "inspect",
          start: 1,
        },
        fixture.context
      )
    ).rejects.toThrow();
  });

  test("updates repeated matches in one split run without damaging untouched run properties", async () => {
    const parts = unzipSync(await wordFixture);
    parts["word/document.xml"] = new TextEncoder().encode(
      new TextDecoder()
        .decode(parts["word/document.xml"])
        .replace("Hello ", "Atlas Atlas ")
    );
    const archive = openOfficeArchive(zipSync(parts));
    const document = new OfficeDocument(archive);
    document.edit([
      {
        expectedMatches: 3,
        find: "Atlas",
        kind: "replace_text",
        paragraph: 1,
        replace: "Team",
      },
    ]);
    const edited = new OfficeDocument(
      openOfficeArchive(saveOfficeArchive(archive))
    );
    expect(edited.read({ limit: 1, start: 1 })).toMatchObject({
      paragraphs: [{ text: "Team Team Team" }],
    });
    expect(
      new TextDecoder().decode(archive.parts["word/document.xml"])
    ).toContain("<w:b/>");
    expect(
      new TextDecoder().decode(archive.parts["word/document.xml"])
    ).toContain("<w:i/>");
  });

  test("escapes edited XML text and preserves leading spaces and Unicode", async () => {
    const archive = openOfficeArchive(await wordFixture);
    const document = new OfficeDocument(archive);
    const replacement = "  Team <Atlas> & café 🚀  ";
    document.edit([
      {
        expectedMatches: 1,
        find: "Hello Atlas",
        kind: "replace_text",
        paragraph: 1,
        replace: replacement,
      },
    ]);
    expect(
      new OfficeDocument(openOfficeArchive(saveOfficeArchive(archive))).read({
        limit: 1,
        start: 1,
      })
    ).toMatchObject({ paragraphs: [{ text: replacement }] });
  });

  test("failed later edits do not save an earlier valid change", async () => {
    const original = await wordFixture;
    const fixture = await workspace(original, "docx");
    await expect(
      officeDocumentTool.run(
        {
          documentRef: fixture.filename,
          edits: [
            {
              expectedMatches: 1,
              find: "Hello Atlas",
              kind: "replace_text",
              replace: "First change",
            },
            {
              expectedMatches: 1,
              find: "Missing text",
              kind: "replace_text",
              replace: "Second change",
            },
          ],
          operation: "edit",
        },
        fixture.context
      )
    ).rejects.toThrow();
    expect(
      await readFile(path.join(fixture.directory, fixture.filename))
    ).toEqual(original);
    expect(
      await readdir(path.join(fixture.directory, "artifacts")).catch(() => [])
    ).toEqual([]);
  });
});

describe("Office archive boundaries", () => {
  test("rejects traversal, macro parts, and signatures before reading document content", async () => {
    for (const name of [
      "../outside.xml",
      "word/vbaProject.bin",
      "_xmlsignatures/sig1.xml",
    ]) {
      const parts = unzipSync(await wordFixture);
      parts[name] = new TextEncoder().encode("<root/>");
      expect(() => openOfficeArchive(zipSync(parts))).toThrow();
    }
  });

  test("rejects XML entities, malformed XML, and missing root relationships", async () => {
    for (const malicious of [
      "<!DOCTYPE root [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><root>&x;</root>",
      "<w:document><broken>",
    ]) {
      const parts = unzipSync(await wordFixture);
      parts["word/document.xml"] = new TextEncoder().encode(malicious);
      expect(() => openOfficeArchive(zipSync(parts))).toThrow();
    }
    const parts = unzipSync(await wordFixture);
    delete parts["_rels/.rels"];
    expect(() => openOfficeArchive(zipSync(parts))).toThrow();
  });

  test("rejects checksum corruption and a forged small expansion size", async () => {
    const parts = unzipSync(await wordFixture);
    parts["word/media/bomb.bin"] = new Uint8Array(2 * 1024 * 1024).fill(65);
    const malicious = zipSync(parts);
    const view = new DataView(
      malicious.buffer,
      malicious.byteOffset,
      malicious.byteLength
    );
    for (let offset = 0; offset < malicious.length - 46; offset += 1) {
      if (view.getUint32(offset, true) !== 0x02_01_4b_50) {
        continue;
      }
      const nameLength = view.getUint16(offset + 28, true);
      const name = new TextDecoder().decode(
        malicious.subarray(offset + 46, offset + 46 + nameLength)
      );
      if (name === "word/media/bomb.bin") {
        view.setUint32(offset + 24, 64, true);
      }
    }
    expect(() => openOfficeArchive(malicious)).toThrow();
    const corrupt = zipSync(unzipSync(await wordFixture), { level: 0 });
    const textOffset = Buffer.from(corrupt).indexOf(Buffer.from("Hello "));
    expect(textOffset).toBeGreaterThan(0);
    corrupt[textOffset] = 74;
    expect(() => openOfficeArchive(corrupt)).toThrow();
  });

  test("rejects edits to protected documents and text fields", async () => {
    const parts = unzipSync(await wordFixture);
    parts["word/settings.xml"] = new TextEncoder().encode(
      '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:documentProtection w:enforcement="1"/></w:settings>'
    );
    const protectedDocument = new OfficeDocument(
      openOfficeArchive(zipSync(parts))
    );
    expect(() =>
      protectedDocument.edit([
        {
          expectedMatches: 1,
          find: "Hello Atlas",
          kind: "replace_text",
          replace: "Changed",
        },
      ])
    ).toThrow();
    delete parts["word/settings.xml"];
    // Keep the original settings relationships intact for this separate field fixture.
    const fieldParts = unzipSync(await wordFixture);
    fieldParts["word/document.xml"] = new TextEncoder().encode(
      new TextDecoder()
        .decode(fieldParts["word/document.xml"])
        .replace("<w:t", '<w:fldChar w:fldCharType="begin"/><w:t')
    );
    const fieldDocument = new OfficeDocument(
      openOfficeArchive(zipSync(fieldParts))
    );
    expect(() =>
      fieldDocument.edit([
        {
          expectedMatches: 1,
          find: "Hello Atlas",
          kind: "replace_text",
          replace: "Changed",
        },
      ])
    ).toThrow();
  });

  test("rejects a match crossing a structural break and paragraphs inside tracked moves", async () => {
    const original = unzipSync(await wordFixture);
    const source = new TextDecoder().decode(original["word/document.xml"]);
    for (const xml of [
      source.replace(
        '<w:t xml:space="preserve">Atlas',
        '<w:br/><w:t xml:space="preserve">Atlas'
      ),
      source
        .replace("<w:body>", '<w:body><w:moveTo w:id="1">')
        .replace("</w:body>", "</w:moveTo></w:body>"),
    ]) {
      const parts = {
        ...original,
        "word/document.xml": new TextEncoder().encode(xml),
      };
      const document = new OfficeDocument(openOfficeArchive(zipSync(parts)));
      const first = document.read({ limit: 1, start: 1 });
      const find = "paragraphs" in first ? first.paragraphs[0]!.text : "";
      expect(() =>
        document.edit([
          {
            expectedMatches: 1,
            find,
            kind: "replace_text",
            paragraph: 1,
            replace: "Changed",
          },
        ])
      ).toThrow();
    }
  });

  test("refuses invalid XML characters in an edit and encrypted ZIP entries", async () => {
    const document = new OfficeDocument(openOfficeArchive(await wordFixture));
    expect(() =>
      document.edit([
        {
          expectedMatches: 1,
          find: "Hello Atlas",
          kind: "replace_text",
          replace: "Invalid\u0000text",
        },
      ])
    ).toThrow();
    const encrypted = Uint8Array.from(await wordFixture);
    const view = new DataView(encrypted.buffer);
    for (let offset = 0; offset < encrypted.length - 46; offset += 1) {
      if (view.getUint32(offset, true) === 0x02_01_4b_50) {
        view.setUint16(offset + 8, 1, true);
        break;
      }
    }
    expect(() => openOfficeArchive(encrypted)).toThrow();
  });

  test("reports merged cells and refuses rewriting them as ordinary grid positions", async () => {
    const parts = unzipSync(await wordFixture);
    const xml = parseXml(parts["word/document.xml"]!, "document");
    const cell = elements(xml.documentElement, "tc")[0]!;
    const properties = xml.createElementNS(cell.namespaceURI, "w:tcPr");
    cell.insertBefore(properties, cell.firstChild);
    const span = xml.createElementNS(properties.namespaceURI, "w:gridSpan");
    span.setAttributeNS(properties.namespaceURI, "w:val", "2");
    properties.appendChild(span);
    parts["word/document.xml"] = serializeXml(xml);
    const document = new OfficeDocument(openOfficeArchive(zipSync(parts)));
    expect(
      document.read({ columnLimit: 1, limit: 1, start: 1, table: 1 })
    ).toMatchObject({ rows: [{ cells: [{ merged: true, text: "Product" }] }] });
    expect(() =>
      document.edit([
        {
          column: 1,
          expectedText: "Product",
          kind: "set_table_cell",
          row: 1,
          table: 1,
          text: "Updated",
        },
      ])
    ).toThrow();
  });
});
