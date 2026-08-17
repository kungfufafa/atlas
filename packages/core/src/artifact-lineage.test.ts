import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inferFormatDetails,
  readLineageMeta,
  stampArtifactLineage,
} from "./artifact-lineage";

describe("inferFormatDetails", () => {
  test("marks jsx and html compilers", () => {
    expect(inferFormatDetails("App.jsx", "text/plain").compiler).toBe("jsx");
    expect(inferFormatDetails("index.html", "text/html").compiler).toBe("html");
  });
});

describe("stampArtifactLineage", () => {
  test("creates v1 then v2 with parent and root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-lineage-"));
    const v1 = join(dir, "deck.pptx");
    const v2 = join(dir, "deck-2026-08-17.pptx");
    await writeFile(v1, "v1");
    await writeFile(v2, "v2");

    const first = await stampArtifactLineage({
      extraDetails: { slideCount: 3 },
      sizeBytes: 2,
      writtenPath: v1,
    });
    expect(first.revision).toBe(1);
    expect(first.rootArtifactId).toBe(first.id);
    expect(first.formatDetails?.slideCount).toBe(3);
    expect(first.formatDetails?.compiler).toBeUndefined();

    const second = await stampArtifactLineage({
      extraDetails: { slideCount: 4 },
      parentFilePath: v1,
      sizeBytes: 2,
      writtenPath: v2,
    });
    expect(second.revision).toBe(2);
    expect(second.parentArtifactId).toBe(first.id);
    expect(second.rootArtifactId).toBe(first.id);
    expect(second.formatDetails?.slideCount).toBe(4);

    const reread = await readLineageMeta(v2);
    expect(reread?.parentArtifactId).toBe(first.id);
  });
});
