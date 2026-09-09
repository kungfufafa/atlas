import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { openOfficeArchive, saveOfficeArchive } from "./archive";
import { OfficeDocument } from "./document";
import {
  attribute,
  elements,
  parseXml,
  serializeXml,
  WORD_NAMESPACES,
} from "./xml";

const fixture = new URL(
  "../testing/fixtures/word-tracked-runs-python.docx",
  import.meta.url
);

test("editing an independent tracked insertion retains history and records new accept/rejectable revisions", async () => {
  const source = await readFile(fixture);
  const archive = openOfficeArchive(source);
  const originalParts = { ...archive.parts };
  const document = new OfficeDocument(archive);
  document.edit(
    [
      {
        expectedMatches: 1,
        find: "Inserted draft",
        kind: "replace_text",
        replace: "Inserted approved",
      },
    ],
    { revisionAuthor: "Atlas", trackChanges: true }
  );
  const output = openOfficeArchive(saveOfficeArchive(archive));
  expect(Object.keys(output.parts).sort()).toEqual(
    Object.keys(originalParts).sort()
  );
  for (const [part, original] of Object.entries(originalParts)) {
    if (part !== "word/document.xml") {
      expect(output.parts[part]).toEqual(original);
    }
  }
  const xml = parseXml(output.parts["word/document.xml"]!, "document");
  const insertions = elements(xml.documentElement, "ins", WORD_NAMESPACES);
  expect(insertions.map((element) => attribute(element, "author"))).toEqual([
    "Synthetic reviewer",
    "Atlas",
  ]);
  expect(attribute(insertions[0]!, "id")).toBe("4");
  const deletion = elements(xml.documentElement, "del", WORD_NAMESPACES)[0]!;
  expect(attribute(deletion, "author")).toBe("Atlas");
  expect(elements(deletion, "delText", WORD_NAMESPACES)[0]?.textContent).toBe(
    "Inserted draft"
  );
  expect(
    new Set(
      [...insertions, deletion].map((element) => attribute(element, "id"))
    ).size
  ).toBe(3);
  const read = new OfficeDocument(output).read({ limit: 10, start: 1 });
  expect("paragraphs" in read && read.paragraphs[0]?.text).toBe(
    "Inserted approved"
  );
  // Independently reject only the new author's revisions in the output tree.
  for (const insertion of insertions.filter(
    (element) => attribute(element, "author") === "Atlas"
  )) {
    insertion.parentNode!.removeChild(insertion);
  }
  for (const text of elements(deletion, "delText", WORD_NAMESPACES)) {
    const restored = xml.createElementNS(text.namespaceURI, "w:t");
    restored.textContent = text.textContent;
    text.parentNode!.replaceChild(restored, text);
  }
  const parent = deletion.parentNode!;
  while (deletion.firstChild) {
    parent.insertBefore(deletion.firstChild, deletion);
  }
  parent.removeChild(deletion);
  expect(
    elements(xml.documentElement, "t", WORD_NAMESPACES)
      .map((element) => element.textContent)
      .join("")
  ).toBe("Inserted draft");
  expect(
    attribute(
      elements(xml.documentElement, "ins", WORD_NAMESPACES)[0]!,
      "author"
    )
  ).toBe("Synthetic reviewer");
  expect(await readFile(fixture)).toEqual(source);
});

test("repeated tracked replacements preserve offsets and hide deleted text on subsequent reads", async () => {
  const archive = openOfficeArchive(await readFile(fixture));
  const xml = parseXml(archive.parts["word/document.xml"]!, "document");
  elements(xml.documentElement, "t", WORD_NAMESPACES)[0]!.textContent =
    "draft draft draft";
  archive.parts["word/document.xml"] = serializeXml(xml);
  const document = new OfficeDocument(
    openOfficeArchive(zipSync(archive.parts))
  );
  document.edit([
    {
      expectedMatches: 3,
      find: "draft",
      kind: "replace_text",
      replace: "done",
    },
  ]);
  document.edit([
    {
      expectedMatches: 3,
      find: "done",
      kind: "replace_text",
      replace: "final",
    },
  ]);
  const read = document.read({ limit: 10, start: 1 });
  expect("paragraphs" in read && read.paragraphs[0]?.text).toBe(
    "final final final"
  );
  const saved = parseXml(
    document.archive.parts["word/document.xml"]!,
    "document"
  );
  expect(
    elements(saved.documentElement, "delText", WORD_NAMESPACES)
      .map((element) => element.textContent)
      .sort()
  ).toEqual(["done", "done", "done", "draft", "draft", "draft"].sort());
});

test("plain Word edits opt into tracking and default-namespace documents retain qualified revision metadata", async () => {
  const archive = openOfficeArchive(await readFile(fixture));
  const xml = parseXml(archive.parts["word/document.xml"]!, "document");
  const insertion = elements(xml.documentElement, "ins", WORD_NAMESPACES)[0]!;
  const paragraph = insertion.parentNode!;
  while (insertion.firstChild) {
    paragraph.insertBefore(insertion.firstChild, insertion);
  }
  paragraph.removeChild(insertion);
  const text = new TextDecoder()
    .decode(serializeXml(xml))
    .replaceAll("w:", "")
    .replace("xmlns:w=", "xmlns=");
  archive.parts["word/document.xml"] = new TextEncoder().encode(text);
  const document = new OfficeDocument(
    openOfficeArchive(zipSync(archive.parts))
  );
  document.edit(
    [
      {
        expectedMatches: 1,
        find: "Inserted draft",
        kind: "replace_text",
        replace: "Approved",
      },
    ],
    { trackChanges: true }
  );
  const parsed = parseXml(
    document.archive.parts["word/document.xml"]!,
    "document"
  );
  const revision = elements(parsed.documentElement, "ins", WORD_NAMESPACES)[0]!;
  expect(revision.getAttributeNS(revision.namespaceURI, "author")).toBe(
    "Atlas"
  );
  expect(revision.getAttributeNS(revision.namespaceURI, "id")).not.toBeNull();
  expect(
    elements(parsed.documentElement, "delText", WORD_NAMESPACES)[0]?.textContent
  ).toBe("Inserted draft");
});
