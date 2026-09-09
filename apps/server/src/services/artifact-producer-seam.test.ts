import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ToolContext } from "@atlas/core";
import {
  createToolArtifactPublisher,
  stageToolArtifact,
} from "@atlas/core/artifact-publication";
import {
  fileAssetRevision,
  MAX_FILE_ASSET_BYTES,
  saveFileArtifact,
} from "@atlas/core/files/assets";
import { writeNewArtifactVersion } from "@atlas/core/files/versioned-write";
import {
  runEditFile,
  runWriteDocx,
  runWriteFile,
  runWritePptx,
} from "@atlas/core/tools/builtin";
import { fileAssetTool } from "@atlas/core/tools/file-asset";
import { officeDocumentTool } from "@atlas/core/tools/office-document";
import { pdfDocumentTool } from "@atlas/core/tools/pdf-document";
import { spreadsheetTool } from "@atlas/core/tools/spreadsheet";
import {
  MAX_SPREADSHEET_BYTES,
  publishSpreadsheet,
  spreadsheetRevision,
} from "@atlas/core/tools/spreadsheet-io";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { runGenerateImageTool } from "../tools/generate-image-tool";
import { ArtifactPublicationService } from "./artifact-publication-service";
import { ArtifactPublicationStore } from "./artifact-publication-store";
import { ArtifactService } from "./artifact-service";
import { BrowserSessionService } from "./browser-session-service";

async function setup() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "atlas-producer-seam-"))
  );
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const db = createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: "org",
    name: "Org",
    slug: "org",
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: "profile",
    isSuper: false,
    model: null,
    name: "Profile",
    orgId: "org",
    systemPrompt: "",
    updatedAt: now,
  });
  await db.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "web",
    createdAt: now,
    id: "session",
    modelOverride: null,
    orgId: "org",
    profileId: "profile",
    title: null,
  });
  const owner = {
    actorId: "actor",
    executionId: crypto.randomUUID(),
    orgId: "org",
    profileId: "profile",
    runId: "run",
    sessionId: "session",
    toolCallId: "call",
  };
  await mkdir(path.join(root, "private"));
  const store = await ArtifactPublicationStore.create(
    path.join(root, "private")
  );
  const service = new ArtifactPublicationService(db, store, async () => {});
  const execution = await service.beginExecution(owner, [workspaceRoot]);
  const context: ToolContext = {
    ...owner,
    artifactPublisher: createToolArtifactPublisher(execution.producer),
    workspaceRoot,
  };
  return { context, db, execution, owner, root, service, store, workspaceRoot };
}
async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>
) {
  const f = await setup();
  try {
    await run(f);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
}

test("saveFileArtifact freezes caller bytes before awaits; disk, revision and private publication agree", async () => {
  await fixture(async (f) => {
    const bytes = Buffer.from("original report");
    const expected = Buffer.from(bytes);
    const saving = saveFileArtifact({
      bytes,
      context: f.context,
      filename: "report.txt",
    });
    bytes.fill(90);
    const saved = await saving;
    const result = await f.execution.finalize({ data: saved, success: true });
    expect(saved.revision).toBe(fileAssetRevision(expected));
    expect(await readFile(path.join(f.workspaceRoot, saved.path))).toEqual(
      expected
    );
    expect(result.publications).toHaveLength(1);
    expect(
      (await f.service.read(f.owner, result.publications[0]!.id))?.bytes
    ).toEqual(expected);
  });
});

test("oversized byte outputs reject before workspace mutation and preserve an existing spreadsheet", async () => {
  await fixture(async (f) => {
    const oversized = Buffer.alloc(
      Math.max(MAX_FILE_ASSET_BYTES, MAX_SPREADSHEET_BYTES) + 1
    );
    const destination = path.join(f.workspaceRoot, "existing.csv");
    const original = Buffer.from("value\noriginal\n");
    await writeFile(destination, original);
    await expect(
      saveFileArtifact({
        bytes: oversized,
        context: f.context,
        filename: "oversized.bin",
      })
    ).rejects.toThrow();
    await expect(
      publishSpreadsheet({
        bytes: oversized,
        expectedRevision: spreadsheetRevision(original),
        path: destination,
        writeMode: "inplace",
      })
    ).rejects.toThrow();
    expect(await readFile(destination)).toEqual(original);
    expect(await readdir(f.workspaceRoot)).toEqual(["existing.csv"]);
    const publication = await f.execution.finalize({ success: false });
    expect(publication.status).toBe("discarded");
    expect(publication.publications).toHaveLength(0);
  });
});

test.each(["docx", "pptx"] as const)(
  "nested cwd %s retains its real file receipt when the canonical publication destination is unsupported",
  async (format) => {
    await fixture(async (f) => {
      const cwd = path.join(f.workspaceRoot, "nested");
      await mkdir(cwd);
      const receipt =
        format === "docx"
          ? await runWriteDocx(
              { cwd, markdown: "Nested report", path: "report.docx" },
              f.context
            )
          : await runWritePptx(
              {
                cwd,
                path: "report.pptx",
                slides: [{ title: "Nested report" }],
                title: "Report",
              },
              f.context
            );
      const bytes = await readFile(receipt.path);
      expect(receipt.path).toBe(
        path.join(cwd, "artifacts", `report.${format}`)
      );
      expect(receipt.bytesWritten).toBe(bytes.byteLength);
      expect(bytes.subarray(0, 2).toString()).toBe("PK");
      const publication = await f.execution.finalize({
        data: receipt,
        success: true,
      });
      expect(publication.status).toBe("failed");
      expect(publication.publications).toHaveLength(0);
      expect(await readFile(receipt.path)).toEqual(bytes);
    });
  }
);

test("generic writes and edits publish only explicit deliverables and reject invalid destinations before mutation", async () => {
  await fixture(async (f) => {
    for (const dest of [
      "MEMORY.md",
      "artifacts/work.txt",
      "artifacts/report.txt.atlas-meta.json",
      ".sources/input.txt",
    ]) {
      await runWriteFile({ content: "work", path: dest }, f.context);
    }
    for (const dest of [
      "MEMORY.md",
      ".sources/denied.txt",
      "artifacts/.hidden.txt",
      "artifacts/report.txt.atlas-meta.json",
      "nested/artifacts/no.txt",
    ]) {
      await expect(
        runWriteFile(
          { content: "replace", deliverable: true, path: dest },
          f.context
        )
      ).rejects.toThrow();
    }
    expect(
      await readFile(path.join(f.workspaceRoot, "MEMORY.md"), "utf8")
    ).toBe("work");
    const main = await runWriteFile(
      { content: "first", deliverable: true, path: "artifacts/report.txt" },
      f.context
    );
    const edited = await runEditFile(
      {
        deliverable: true,
        edits: [{ newText: "final", oldText: "first" }],
        path: main.path,
      },
      f.context
    );
    await runEditFile(
      { edits: [{ newText: "updated", oldText: "work" }], path: "MEMORY.md" },
      f.context
    );
    const result = await f.execution.finalize({ data: edited, success: true });
    expect(result.publications.map((p) => p.outputOrdinal)).toEqual([0, 1]);
    expect(result.publications.map((p) => p.sourcePath)).toEqual([
      "artifacts/report.txt",
      "artifacts/report.txt",
    ]);
    expect(
      (
        await f.service.read(f.owner, result.publications[0]!.id)
      )?.bytes.toString()
    ).toBe("first");
    expect(
      (
        await f.service.read(f.owner, result.publications[1]!.id)
      )?.bytes.toString()
    ).toBe("final");
  });
});

test("nested document helpers assign distinct ordinals without publishing materialized sources or reads", async () => {
  await fixture(async (f) => {
    const doc = await runWriteDocx(
      { markdown: "Original text", path: "report.docx" },
      f.context
    );
    await runWritePptx(
      { path: "report.pptx", slides: [{ title: "Overview" }], title: "Report" },
      f.context
    );
    await officeDocumentTool.run(
      {
        documentRef: doc.path,
        edits: [
          {
            expectedMatches: 1,
            find: "Original",
            kind: "replace_text",
            replace: "Revised",
          },
        ],
        operation: "edit",
      },
      f.context
    );
    const pdf = (await pdfDocumentTool.run(
      {
        operation: "create",
        outputFilename: "report.pdf",
        textPages: ["Page one", "Page two"],
      },
      f.context
    )) as { path: string };
    await pdfDocumentTool.run(
      {
        documentRef: pdf.path,
        groups: [[1], [2]],
        operation: "split",
        outputFilename: "part.pdf",
      },
      f.context
    );
    await fileAssetTool.run(
      { documentRef: doc.path, operation: "materialize" },
      f.context
    );
    await officeDocumentTool.run(
      { documentRef: doc.path, limit: 40, operation: "inspect", start: 1 },
      f.context
    );
    const result = await f.execution.finalize({ success: true });
    expect(result.publications).toHaveLength(6);
    expect(result.publications.map((p) => p.outputOrdinal)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    for (const publication of result.publications) {
      expect((await f.service.read(f.owner, publication.id))?.bytes).toEqual(
        await readFile(path.join(f.workspaceRoot, publication.sourcePath))
      );
    }
  });
});

test("spreadsheet creates and exports stage exact complete bytes; reads do not stage", async () => {
  await fixture(async (f) => {
    const created = (await spreadsheetTool.run(
      {
        action: "create",
        columns: ["Item", "Count"],
        data: [["One", 1]],
        path: "report.xlsx",
      },
      f.context
    )) as { revision: string };
    await spreadsheetTool.run(
      { action: "inspect", path: "report.xlsx" },
      f.context
    );
    await spreadsheetTool.run(
      {
        action: "export_csv",
        path: "report.xlsx",
        targetCsvPath: "report.csv",
      },
      f.context
    );
    const result = await f.execution.finalize({ success: true });
    expect(result.publications).toHaveLength(2);
    expect(result.publications[0]?.sha256).toBe(created.revision);
    for (const publication of result.publications) {
      expect((await f.service.read(f.owner, publication.id))?.bytes).toEqual(
        await readFile(path.join(f.workspaceRoot, publication.sourcePath))
      );
    }
  });
});

test("low-level versioned writers freeze mutable bytes before IO and revision calculation", async () => {
  await fixture(async (f) => {
    const bytes = Buffer.from("col\nvalue\n");
    const expected = Buffer.from(bytes);
    const plain = writeNewArtifactVersion(
      path.join(f.workspaceRoot, "plain.txt"),
      bytes
    );
    const sheet = publishSpreadsheet({
      bytes,
      path: path.join(f.workspaceRoot, "sheet.csv"),
      writeMode: "versioned",
    });
    bytes.fill(88);
    expect(await readFile(await plain)).toEqual(expected);
    const saved = await sheet;
    expect(await readFile(saved.path)).toEqual(expected);
    expect(saved.revision).toBe(spreadsheetRevision(expected));
  });
});

for (const failure of ["storage", "invalid-stage"] as const) {
  test(`${failure} preserves original workspace receipts and blocks the complete publication set without producer replay`, async () => {
    await fixture(async (f) => {
      const first = await runWriteFile(
        { content: "first", deliverable: true, path: "artifacts/first.txt" },
        f.context
      );
      if (failure === "storage") {
        Object.defineProperty(f.store, "stage", {
          value: async () => {
            throw new Error("storage unavailable");
          },
        });
      } else {
        await stageToolArtifact(f.context.artifactPublisher, {
          bytes: Buffer.from("bad"),
          sourcePath: "../outside",
        });
      }
      const second = await saveFileArtifact({
        bytes: Buffer.from("second"),
        context: f.context,
        filename: "second.txt",
      });
      expect(second.bytesWritten).toBe(6);
      expect(await readFile(first.path, "utf8")).toBe("first");
      expect(
        await readFile(path.join(f.workspaceRoot, second.path), "utf8")
      ).toBe("second");
      const result = await f.execution.finalize({
        data: second,
        success: true,
      });
      expect(result.status).toBe("failed");
      expect(result.publications).toEqual([]);
    });
  });
}

for (const property of ["bytes", "sourcePath"] as const) {
  test(`throwing ${property} getter reaches trusted failure boundary and poisons earlier staged output`, async () => {
    await fixture(async (f) => {
      await saveFileArtifact({
        bytes: Buffer.from("first"),
        context: f.context,
        filename: "first.txt",
      });
      const input = {
        bytes: Buffer.from("bad"),
        sourcePath: "artifacts/bad.txt",
      };
      Object.defineProperty(input, property, {
        get() {
          throw new Error("malformed tool input");
        },
      });
      await stageToolArtifact(f.context.artifactPublisher, input);
      expect((await f.execution.finalize({ success: true })).status).toBe(
        "failed"
      );
      expect(
        await readFile(
          path.join(f.workspaceRoot, "artifacts/first.txt"),
          "utf8"
        )
      ).toBe("first");
    });
  });
}

test("one invocation owns ordinals across overlapping nested saves; a second publisher starts independently", async () => {
  await fixture(async (f) => {
    await Promise.all(
      ["one", "two", "three"].map((name) =>
        saveFileArtifact({
          bytes: Buffer.from(name),
          context: f.context,
          filename: `${name}.txt`,
        })
      )
    );
    const second = await f.service.beginExecution(
      { ...f.owner, executionId: "second" },
      [f.workspaceRoot]
    );
    await saveFileArtifact({
      bytes: Buffer.from("other"),
      context: {
        ...f.context,
        artifactPublisher: createToolArtifactPublisher(second.producer),
      },
      filename: "other.txt",
    });
    expect(
      (await f.execution.finalize({ success: true })).publications.map(
        (p) => p.outputOrdinal
      )
    ).toEqual([0, 1, 2]);
    expect(
      (await second.finalize({ success: true })).publications[0]?.outputOrdinal
    ).toBe(0);
  });
});

test("symlinked profile root produces canonical relative publication paths", async () => {
  await fixture(async (f) => {
    const alias = path.join(f.root, "alias");
    await symlink(f.workspaceRoot, alias);
    await runWriteDocx(
      { markdown: "Report", path: "report.docx" },
      { ...f.context, workspaceRoot: alias }
    );
    const result = await f.execution.finalize({ success: true });
    expect(result.publications[0]?.sourcePath).toBe("artifacts/report.docx");
  });
});

test("generated image stages the same bytes as its file and preserves success when staging rejects", async () => {
  await fixture(async (f) => {
    const generated = Buffer.from("image fixture bytes");
    const original = Buffer.from(generated);
    const result = await runGenerateImageTool(
      { filename: "fixture.png", prompt: "fixture" },
      f.context,
      {
        db: f.db,
        ensureSettingsLoaded: async () => {},
        generateImage: async () => ({
          data: generated,
          mediaType: "image/png",
          model: "gpt-image-2",
          size: "1024x1024",
        }),
        getUserConfig: () => ({
          defaultProviderId: "fixture",
          imageModel: "fixture::gpt-image-2",
          providers: [
            {
              apiKey: "offline-fixture",
              createdAt: "2026-01-01",
              id: "fixture",
              label: "Fixture",
              type: "openai",
            },
          ],
        }),
        recordUsage: () => generated.fill(88),
      }
    );
    const published = await f.execution.finalize({
      data: result,
      success: true,
    });
    expect(published.publications).toHaveLength(1);
    expect(
      (await f.service.read(f.owner, published.publications[0]!.id))?.bytes
    ).toEqual(original);
    expect(
      await readFile(
        path.join(f.workspaceRoot, published.publications[0]!.sourcePath)
      )
    ).toEqual(original);
    const failedStage = await runGenerateImageTool(
      { filename: "second.png", prompt: "fixture" },
      {
        ...f.context,
        artifactPublisher: {
          stageBytes: async () => {
            throw new Error("failed");
          },
        },
      },
      {
        db: f.db,
        ensureSettingsLoaded: async () => {},
        generateImage: async () => ({
          data: original,
          mediaType: "image/png",
          model: "gpt-image-2",
          size: "1024x1024",
        }),
        getUserConfig: () => ({
          defaultProviderId: "fixture",
          imageModel: "fixture::gpt-image-2",
          providers: [
            {
              apiKey: "offline-fixture",
              createdAt: "2026-01-01",
              id: "fixture",
              label: "Fixture",
              type: "openai",
            },
          ],
        }),
      }
    );
    expect(failedStage).toMatchObject({
      path: "artifacts/second.png",
      sizeBytes: original.length,
    });
  });
});

test("ArtifactService captures buffer before awaits, and browser screenshot/download forward one capability per output", async () => {
  await fixture(async (f) => {
    const oldConfig = process.env.ATLAS_CONFIG_DIR;
    process.env.ATLAS_CONFIG_DIR = path.join(f.root, "browser-config");
    try {
      const service = new ArtifactService();
      const input = Buffer.from("original");
      const writing = service.saveArtifact(
        "org",
        "profile",
        "direct.txt",
        input,
        { artifactPublisher: f.context.artifactPublisher }
      );
      input.fill(88);
      const saved = await writing;
      expect(
        (
          await service.getArtifact("org", "profile", saved.path)
        ).content.toString()
      ).toBe("original");
      const browser = new BrowserSessionService();
      Object.defineProperty(browser, "getOrCreateSession", {
        value: async () => ({
          page: {
            screenshot: async () => Buffer.from("screenshot"),
            waitForEvent: async () => ({
              createReadStream: async () =>
                Readable.from([Buffer.from("download")]),
              suggestedFilename: () => "download.txt",
            }),
          },
        }),
      });
      Object.defineProperty(browser, "extractPageSnapshot", {
        value: async () => ({}),
      });
      const options = {
        artifactPublisher: f.context.artifactPublisher,
        orgId: "org",
        profileId: "profile",
        sessionId: "session",
      };
      expect(
        (await browser.executeBrowserAction({ action: "screenshot" }, options))
          .artifacts
      ).toHaveLength(1);
      expect(
        (await browser.executeBrowserAction({ action: "download" }, options))
          .artifacts
      ).toHaveLength(1);
      const result = await f.execution.finalize({ success: true });
      expect(result.publications.map((p) => p.outputOrdinal)).toEqual([
        0, 1, 2,
      ]);
      const contents = await Promise.all(
        result.publications.map(async (p) =>
          (await f.service.read(f.owner, p.id))?.bytes.toString()
        )
      );
      expect(contents).toEqual(["original", "screenshot", "download"]);
    } finally {
      if (oldConfig === undefined) {
        delete process.env.ATLAS_CONFIG_DIR;
      } else {
        process.env.ATLAS_CONFIG_DIR = oldConfig;
      }
    }
  });
});

test("all direct core producers retain successful effect receipts when publication storage fails", async () => {
  await fixture(async (f) => {
    Object.defineProperty(f.store, "stage", {
      value: async () => {
        throw new Error("storage unavailable");
      },
    });
    const text = await runWriteFile(
      { content: "first", deliverable: true, path: "artifacts/text.txt" },
      f.context
    );
    const edited = await runEditFile(
      {
        deliverable: true,
        edits: [{ newText: "edited", oldText: "first" }],
        path: text.path,
      },
      f.context
    );
    const doc = await runWriteDocx(
      { markdown: "Report", path: "report.docx" },
      f.context
    );
    const slides = await runWritePptx(
      { path: "report.pptx", slides: [{ title: "Report" }], title: "Report" },
      f.context
    );
    const sheet = (await spreadsheetTool.run(
      {
        action: "create",
        columns: ["Label"],
        data: [["Report"]],
        path: "report.csv",
      },
      f.context
    )) as { path: string; bytesWritten: number };
    for (const saved of [edited, doc, slides, sheet]) {
      const absolute = path.isAbsolute(saved.path)
        ? saved.path
        : path.join(f.workspaceRoot, saved.path);
      expect((await readFile(absolute)).length).toBe(saved.bytesWritten);
    }
    expect(edited.replacements).toBe(1);
    expect(
      (await f.execution.finalize({ data: sheet, success: true })).status
    ).toBe("failed");
  });
});

test("generic explicit edit rejects outside artifacts before changing the file", async () => {
  await fixture(async (f) => {
    await runWriteFile({ content: "keep", path: "MEMORY.md" }, f.context);
    await expect(
      runEditFile(
        {
          deliverable: true,
          edits: [{ newText: "changed", oldText: "keep" }],
          path: "MEMORY.md",
        },
        f.context
      )
    ).rejects.toThrow();
    expect(
      await readFile(path.join(f.workspaceRoot, "MEMORY.md"), "utf8")
    ).toBe("keep");
    expect(
      (await f.execution.finalize({ success: true })).publications
    ).toEqual([]);
  });
});

test("tool input cannot choose output ordinal or publication ownership", async () => {
  await fixture(async (f) => {
    const input = {
      bytes: Buffer.from("content"),
      executionId: "forged",
      orgId: "foreign",
      outputOrdinal: 31,
      sourcePath: "artifacts/report.txt",
    };
    await f.context.artifactPublisher!.stageBytes(input);
    const result = await f.execution.finalize({ success: true });
    expect(result.publications[0]).toMatchObject({
      executionId: f.owner.executionId,
      orgId: "org",
      outputOrdinal: 0,
    });
  });
});
