import { expect, test } from "bun:test";
import { markdownToDocx } from "./docx-write";
import { resolveDocxImages } from "./docx-write-images";
import { openOfficeArchive } from "./office-document/archive";
import { OfficeDocument } from "./office-document/document";
import { FIXTURE_PNG } from "./office-document/testing/fixtures";
import {
  attribute,
  elements,
  parseXml,
  WORD_NAMESPACES,
} from "./office-document/xml";

test("Markdown hyperlinks create real relationships and preserve styled link labels", async () => {
  const bytes = await markdownToDocx(
    "Read [**Atlas** documentation](https://example.com/atlas?q=one&n=two).\n\n| Resource | Link |\n| --- | --- |\n| Help | [Support](mailto:help@example.com) |"
  );
  const archive = openOfficeArchive(bytes);
  const links = archive.relationships
    .get(archive.mainPart)!
    .filter((relationship) => relationship.type.endsWith("/hyperlink"));
  expect(
    links.map((link) => ({ external: link.external, target: link.target }))
  ).toEqual([
    { external: true, target: "https://example.com/atlas?q=one&n=two" },
    { external: true, target: "mailto:help@example.com" },
  ]);
  const xml = parseXml(archive.parts[archive.mainPart]!, archive.mainPart);
  const hyperlinks = elements(
    xml.documentElement,
    "hyperlink",
    WORD_NAMESPACES
  );
  expect(hyperlinks).toHaveLength(2);
  expect(elements(hyperlinks[0]!, "b", WORD_NAMESPACES)).toHaveLength(1);
  expect(
    new OfficeDocument(archive).read({ limit: 1, start: 1 })
  ).toMatchObject({ paragraphs: [{ text: "Read Atlas documentation." }] });
});

test("Markdown images embed the original bytes with image relationships and alt text, including table cells", async () => {
  const resolved: string[] = [];
  const bytes = await markdownToDocx(
    "![Atlas chart](att_chart)\n\n| Chart |\n| --- |\n| ![Same chart](att_chart) |",
    {
      resolveImage: async (reference) => {
        resolved.push(reference);
        return { bytes: FIXTURE_PNG, filename: "chart.png" };
      },
    }
  );
  expect(resolved).toEqual(["att_chart"]);
  const archive = openOfficeArchive(bytes);
  const imageParts = archive.relationships
    .get(archive.mainPart)!
    .filter((relationship) => relationship.type.endsWith("/image"));
  expect(imageParts).toHaveLength(1);
  expect(archive.parts[imageParts[0]!.target]).toEqual(
    new Uint8Array(FIXTURE_PNG)
  );
  const xml = parseXml(archive.parts[archive.mainPart]!, archive.mainPart);
  expect(
    elements(xml.documentElement, "drawing", WORD_NAMESPACES)
  ).toHaveLength(2);
  expect(
    elements(xml.documentElement, "docPr").map((element) =>
      attribute(element, "descr")
    )
  ).toEqual(["Atlas chart", "Same chart"]);
});

test("Word images require a resolver and remote references are rejected before asset loading", async () => {
  await expect(markdownToDocx("![Image](image.png)")).rejects.toThrow();
  let calls = 0;
  for (const reference of [
    "https://example.com/image.png",
    "data:image/png;base64,AAAA",
    "file:///tmp/image.png",
    "//example.com/image.png",
  ]) {
    await expect(
      markdownToDocx(`![Image](${reference})`, {
        resolveImage: async () => {
          calls += 1;
          return { bytes: FIXTURE_PNG, filename: "image.png" };
        },
      })
    ).rejects.toThrow();
  }
  expect(calls).toBe(0);
  await expect(
    markdownToDocx("[Unsafe](javascript:alert%281%29)")
  ).rejects.toThrow();
});

test("Word image dimensions preserve aspect ratio and reject malformed or oversized content", async () => {
  const wide = Uint8Array.from(FIXTURE_PNG);
  const view = new DataView(wide.buffer);
  view.setUint32(16, 1200);
  view.setUint32(20, 400);
  const images = await resolveDocxImages(new Set(["wide.png"]), {
    resolveImage: async () => ({ bytes: wide, filename: "wide.png" }),
  });
  expect(images.get("wide.png")!.transformation).toEqual({
    height: 200,
    width: 600,
  });
  view.setUint32(16, 30_000);
  for (const invalid of [
    wide,
    new TextEncoder().encode("not image content"),
    new Uint8Array(8 * 1024 * 1024 + 1),
  ]) {
    await expect(
      resolveDocxImages(new Set(["invalid.png"]), {
        resolveImage: async () => ({ bytes: invalid, filename: "invalid.png" }),
      })
    ).rejects.toThrow();
  }
});
