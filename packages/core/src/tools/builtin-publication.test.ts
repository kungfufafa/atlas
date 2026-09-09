import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { readLineageMeta } from "../artifact-lineage";
import { withProfileSoulMutationLock } from "../soul/mutation-lock";
import { runWriteDocx, runWriteFile, runWritePptx } from "./builtin";

for (const format of ["txt", "docx", "pptx"] as const) {
  test(`B02 writing the returned absolute ${format} artifact path preserves its original bytes`, async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "atlas-publish-"));
    const context = {
      orgId: "org_fixture",
      profileId: "profile_fixture",
      workspaceRoot,
    };
    const write = (target: string, text: string) => {
      if (format === "docx") {
        return runWriteDocx({ markdown: text, path: target }, context);
      }
      if (format === "pptx") {
        return runWritePptx(
          { path: target, slides: [{ title: text }], title: text },
          context
        );
      }
      return runWriteFile({ content: text, path: target }, context);
    };
    try {
      const first = await write(
        `artifacts/report.${format}`,
        "Original content"
      );
      const original = await readFile(first.path);
      const second = await write(first.path, "Revised content");
      expect(second.path).not.toBe(first.path);
      expect(await readFile(first.path)).toEqual(original);
      expect((await readFile(second.path)).equals(original)).toBe(false);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
}

test("B03 metadata enrichment preserves the content version's lineage", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "atlas-publish-"));
  const context = {
    orgId: "org_fixture",
    profileId: "profile_fixture",
    workspaceRoot,
  };
  try {
    await runWriteFile(
      { content: "Original", path: "artifacts/report.txt" },
      context
    );
    const version = await runWriteFile(
      { content: "Revised", path: "artifacts/report.txt" },
      context
    );
    const before = await readLineageMeta(version.path);
    await runWriteFile(
      {
        content: JSON.stringify({
          formatDetails: { title: "Report" },
          mimeType: "text/plain",
          savedAt: "2026-09-06",
        }),
        path: "artifacts/report.txt.atlas-meta.json",
      },
      context
    );
    const after = await readLineageMeta(version.path);
    expect(after).toMatchObject({
      id: before!.id,
      parentArtifactId: before!.parentArtifactId,
      revision: before!.revision,
      rootArtifactId: before!.rootArtifactId,
      sizeBytes: 7,
    });
    expect(
      (await readdir(path.dirname(version.path))).filter((name) =>
        name.endsWith(".atlas-meta.json.atlas-meta.json")
      )
    ).toEqual([]);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("B04 same relative artifact names in different working directories keep independent metadata", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "atlas-publish-"));
  const context = {
    orgId: "org_fixture",
    profileId: "profile_fixture",
    workspaceRoot,
  };
  try {
    const directories = [
      path.join(workspaceRoot, "a"),
      path.join(workspaceRoot, "b"),
    ];
    const written: string[] = [];
    for (const cwd of directories) {
      await mkdir(cwd);
      written.push(
        (
          await runWriteFile(
            { content: cwd, cwd, path: "artifacts/report.txt" },
            context
          )
        ).path
      );
    }
    const bBefore = await readFile(`${written[1]}.atlas-meta.json`);
    const metadata = await runWriteFile(
      {
        content: JSON.stringify({
          formatDetails: { title: "A" },
          mimeType: "text/plain",
          savedAt: "2026-09-06",
        }),
        cwd: directories[0],
        path: "artifacts/report.txt.atlas-meta.json",
      },
      context
    );
    expect(metadata.path).toBe(`${written[0]}.atlas-meta.json`);
    expect(await readFile(`${written[1]}.atlas-meta.json`)).toEqual(bBefore);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

for (const format of ["docx", "pptx"] as const) {
  test(`B05 ${format} creation and metadata wait for the profile mutation lock`, async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "atlas-publish-lock-")
    );
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withProfileSoulMutationLock(
      "org_fixture",
      "profile_fixture",
      async () => {
        acquired.resolve();
        await release.promise;
      }
    );
    try {
      await acquired.promise;
      const context = {
        orgId: "org_fixture",
        profileId: "profile_fixture",
        workspaceRoot,
      };
      let done = false;
      const writing = (
        format === "docx"
          ? runWriteDocx(
              { markdown: "Report", path: "artifacts/report.docx" },
              context
            )
          : runWritePptx(
              {
                path: "artifacts/report.pptx",
                slides: [{ title: "Report" }],
                title: "Report",
              },
              context
            )
      ).then((result) => {
        done = true;
        return result;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(done).toBe(false);
      expect(await readdir(workspaceRoot)).toEqual([]);
      release.resolve();
      await holder;
      const result = await writing;
      expect((await readLineageMeta(result.path))?.sizeBytes).toBe(
        (await readFile(result.path)).length
      );
    } finally {
      release.resolve();
      await holder;
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  test(`B01 simultaneous ${format} creation keeps every complete result`, async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "atlas-publish-"));
    try {
      const context = {
        orgId: "org_fixture",
        profileId: "profile_fixture",
        workspaceRoot,
      };
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) => {
          const filename = `artifacts/report.${format}`;
          const title = `report-${index}`;
          return format === "docx"
            ? runWriteDocx({ markdown: title, path: filename }, context)
            : runWritePptx(
                { path: filename, slides: [{ title }], title },
                context
              );
        })
      );
      expect(new Set(results.map((result) => result.path)).size).toBe(6);
      const original = await readLineageMeta(results[0]!.path);
      expect(original?.sizeBytes).toBe(
        (await readFile(results[0]!.path)).length
      );
      for (const [index, result] of results.entries()) {
        const metadata = await readLineageMeta(result.path);
        expect(metadata?.rootArtifactId).toBe(original!.id);
        if (index > 0) {
          expect(metadata?.parentArtifactId).toBe(original!.id);
        }
        const parts = unzipSync(await readFile(result.path));
        const key =
          format === "docx" ? "word/document.xml" : "ppt/slides/slide1.xml";
        expect(Buffer.from(parts[key]!).toString("utf8")).toContain(
          `report-${index}`
        );
      }
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
}
