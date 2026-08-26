import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ARTIFACT_EDIT_MAX_CELL_BYTES,
  ARTIFACT_EDIT_MAX_COLUMNS,
  ARTIFACT_EDIT_MAX_FILE_BYTES,
  ARTIFACT_EDIT_MAX_ROWS,
  readEditableArtifact,
  writeEditableArtifact,
} from "./artifact-editing";
import { getProfileArtifactsDir } from "./soul/resolve";

const ORG_ID = "org_edit";
const OTHER_ORG_ID = "org_other";
const PROFILE_ID = "profile_edit";

let configDir: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  previousConfigDir = process.env.ATLAS_CONFIG_DIR;
  configDir = await mkdtemp(path.join(tmpdir(), "atlas-artifact-editing-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
  await Promise.all([
    mkdir(getProfileArtifactsDir(ORG_ID, PROFILE_ID), { recursive: true }),
    mkdir(getProfileArtifactsDir(OTHER_ORG_ID, PROFILE_ID), {
      recursive: true,
    }),
  ]);
});

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.ATLAS_CONFIG_DIR;
  } else {
    process.env.ATLAS_CONFIG_DIR = previousConfigDir;
  }
  await rm(configDir, { force: true, recursive: true });
});

async function seedArtifact(
  filename: string,
  content: string | Buffer,
  orgId = ORG_ID
): Promise<string> {
  const filePath = path.join(
    getProfileArtifactsDir(orgId, PROFILE_ID),
    filename
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

describe("readEditableArtifact", () => {
  test("returns bounded Markdown source and a content hash", async () => {
    const content = "# Weekly\n\nAll good.\n";
    await seedArtifact("reports/weekly.md", content);

    const result = await readEditableArtifact({
      filename: "reports/weekly.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });

    expect(result).toMatchObject({
      content,
      editable: true,
      filename: "weekly.md",
      kind: "markdown",
      path: "reports/weekly.md",
      truncated: false,
    });
    expect(result.expectedHash).toBe(
      createHash("sha256").update(content).digest("hex")
    );
  });

  test("keeps organization roots isolated even for the same profile id", async () => {
    await seedArtifact("report.md", "# Private A\n");
    await seedArtifact("report.md", "# Private B\n", OTHER_ORG_ID);

    const result = await readEditableArtifact({
      filename: "report.md",
      orgId: OTHER_ORG_ID,
      profileId: PROFILE_ID,
    });

    expect(result.content).toBe("# Private B\n");
  });

  test("rejects traversal, absolute paths, and symbolic links", async () => {
    const outsidePath = path.join(configDir, "outside.md");
    const outsideDirectory = path.join(configDir, "outside-directory");
    await mkdir(outsideDirectory);
    await writeFile(outsidePath, "outside", "utf8");
    await writeFile(
      path.join(outsideDirectory, "nested.md"),
      "nested outside",
      "utf8"
    );
    await symlink(
      outsidePath,
      path.join(getProfileArtifactsDir(ORG_ID, PROFILE_ID), "linked.md")
    );
    await symlink(
      outsideDirectory,
      path.join(getProfileArtifactsDir(ORG_ID, PROFILE_ID), "linked-directory")
    );

    await expect(
      readEditableArtifact({
        filename: "../outside.md",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readEditableArtifact({
        filename: outsidePath,
        orgId: ORG_ID,
        profileId: PROFILE_ID,
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readEditableArtifact({
        filename: "linked.md",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readEditableArtifact({
        filename: "linked-directory/nested.md",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  test("rejects an artifacts root symlink even when its target is readable", async () => {
    const artifactsDir = getProfileArtifactsDir(ORG_ID, PROFILE_ID);
    const outsideArtifactsDir = path.join(configDir, "outside-artifacts");
    await mkdir(outsideArtifactsDir);
    await writeFile(
      path.join(outsideArtifactsDir, "report.md"),
      "# Outside\n",
      "utf8"
    );
    await rm(artifactsDir, { recursive: true });
    await symlink(outsideArtifactsDir, artifactsDir);

    await expect(
      readEditableArtifact({
        filename: "report.md",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  test("rejects malformed UTF-8 and malformed CSV", async () => {
    await seedArtifact("invalid.md", Buffer.from([0xc3, 0x28]));
    await seedArtifact("invalid.csv", 'name,value\n"unterminated,1\n');

    await expect(
      readEditableArtifact({
        filename: "invalid.md",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
      })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      readEditableArtifact({
        filename: "invalid.csv",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
      })
    ).rejects.toMatchObject({ status: 422 });
  });

  test("preserves multiline CSV records, blank rows, and cell whitespace", async () => {
    await seedArtifact(
      "multiline.csv",
      ' Name ;Notes\r\n" Alice ";"first\r\nsecond ""quoted"""\r\n\r\n'
    );

    const editable = await readEditableArtifact({
      filename: "multiline.csv",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });

    expect(editable).toMatchObject({
      columnCount: 2,
      delimiter: ";",
      editable: true,
      rowCount: 3,
      truncated: false,
    });
    expect(editable.rows).toEqual([
      [" Name ", "Notes"],
      [" Alice ", 'first\r\nsecond "quoted"'],
      [""],
    ]);
  });

  test("marks oversized and over-dimension artifacts read-only", async () => {
    await seedArtifact(
      "large.md",
      Buffer.alloc(ARTIFACT_EDIT_MAX_FILE_BYTES + 1, 0x61)
    );
    await seedArtifact(
      "many.csv",
      Array.from({ length: ARTIFACT_EDIT_MAX_ROWS + 1 }, (_, index) =>
        String(index)
      ).join("\n")
    );
    await seedArtifact(
      "wide.csv",
      Array.from({ length: ARTIFACT_EDIT_MAX_COLUMNS + 1 }, (_, index) =>
        String(index)
      ).join(",")
    );

    const large = await readEditableArtifact({
      filename: "large.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });
    const many = await readEditableArtifact({
      filename: "many.csv",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });
    const wide = await readEditableArtifact({
      filename: "wide.csv",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });

    expect(large).toMatchObject({ editable: false, truncated: true });
    expect(large.content?.length).toBe(ARTIFACT_EDIT_MAX_FILE_BYTES);
    expect(many).toMatchObject({
      editable: false,
      rowCount: ARTIFACT_EDIT_MAX_ROWS + 1,
      truncated: true,
    });
    expect(many.rows).toHaveLength(ARTIFACT_EDIT_MAX_ROWS);
    expect(wide).toMatchObject({
      columnCount: ARTIFACT_EDIT_MAX_COLUMNS + 1,
      editable: false,
      truncated: true,
    });
  });
});

describe("writeEditableArtifact", () => {
  test("uses hash compare-and-swap and keeps stale writes off disk", async () => {
    const filePath = await seedArtifact("notes.md", "# First\n");
    const editable = await readEditableArtifact({
      filename: "notes.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });
    await writeFile(filePath, "# Changed elsewhere\n", "utf8");

    await expect(
      writeEditableArtifact({
        filename: "notes.md",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        request: {
          content: "# My stale edit\n",
          expectedHash: editable.expectedHash,
        },
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(filePath, "utf8")).toBe("# Changed elsewhere\n");
  });

  test("holds a filesystem lock across compare and replace", async () => {
    const filePath = await seedArtifact("concurrent.md", "# First\n");
    const editable = await readEditableArtifact({
      filename: "concurrent.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });
    let releaseCompare: () => void = () => undefined;
    const compareReleased = new Promise<void>((resolve) => {
      releaseCompare = resolve;
    });
    let signalCompared: () => void = () => undefined;
    const compared = new Promise<void>((resolve) => {
      signalCompared = resolve;
    });

    const firstSave = writeEditableArtifact(
      {
        filename: "concurrent.md",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        request: {
          content: "# First writer\n",
          expectedHash: editable.expectedHash,
        },
      },
      {
        afterCompare: async () => {
          signalCompared();
          await compareReleased;
        },
      }
    );
    await compared;

    let secondSettled = false;
    const secondOutcome = writeEditableArtifact({
      filename: "concurrent.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      request: {
        content: "# Second writer\n",
        expectedHash: editable.expectedHash,
      },
    })
      .then(() => ({ error: null }))
      .catch((error: unknown) => ({ error }))
      .finally(() => {
        secondSettled = true;
      });

    await Bun.sleep(75);
    expect(secondSettled).toBe(false);
    releaseCompare();
    await firstSave;
    const second = await secondOutcome;

    expect(second.error).toMatchObject({ status: 409 });
    expect(await readFile(filePath, "utf8")).toBe("# First writer\n");
  });

  test("recovers an abandoned filesystem lock", async () => {
    const filePath = await seedArtifact("stale-lock.md", "# First\n");
    const editable = await readEditableArtifact({
      filename: "stale-lock.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });
    const lockPath = path.join(
      path.dirname(filePath),
      ".stale-lock.md.atlas-meta-edit.lock"
    );
    await writeFile(lockPath, "abandoned malformed lock\n", { mode: 0o600 });
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, staleTime, staleTime);

    await writeEditableArtifact({
      filename: "stale-lock.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      request: {
        content: "# Recovered\n",
        expectedHash: editable.expectedHash,
      },
    });

    expect(await readFile(filePath, "utf8")).toBe("# Recovered\n");
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("recovers a fresh lock left by a crashed process", async () => {
    const filePath = await seedArtifact("crashed-lock.md", "# First\n");
    const editable = await readEditableArtifact({
      filename: "crashed-lock.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stderr: "ignore",
      stdout: "ignore",
    });
    await child.exited;
    const lockPath = path.join(
      path.dirname(filePath),
      ".crashed-lock.md.atlas-meta-edit.lock"
    );
    await writeFile(
      lockPath,
      `${JSON.stringify({ createdAt: new Date().toISOString(), pid: child.pid })}\n`,
      { mode: 0o600 }
    );

    await writeEditableArtifact({
      filename: "crashed-lock.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      request: {
        content: "# Recovered\n",
        expectedHash: editable.expectedHash,
      },
    });

    expect(await readFile(filePath, "utf8")).toBe("# Recovered\n");
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("atomically saves Markdown with private permissions and fresh metadata", async () => {
    const filePath = await seedArtifact("notes.md", "# First\n");
    await writeFile(
      `${filePath}.atlas-meta.json`,
      JSON.stringify({
        mimeType: "text/markdown",
        savedAt: "2026-01-01T00:00:00.000Z",
        sizeBytes: 8,
      }),
      "utf8"
    );
    const editable = await readEditableArtifact({
      filename: "notes.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });

    const saved = await writeEditableArtifact({
      filename: "notes.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      request: {
        content: "# Saved\n\nNew text.\n",
        expectedHash: editable.expectedHash,
      },
    });

    expect(saved.content).toBe("# Saved\n\nNew text.\n");
    expect((await lstat(filePath)).mode % 512).toBe(0o600);
    const metadata = JSON.parse(
      await readFile(`${filePath}.atlas-meta.json`, "utf8")
    ) as { savedAt: string; sizeBytes: number };
    expect(metadata.sizeBytes).toBe(Buffer.byteLength(saved.content ?? ""));
    expect(metadata.savedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  test("preserves the CSV delimiter and neutralizes spreadsheet formulas", async () => {
    const filePath = await seedArtifact(
      "contacts.csv",
      "name;value\r\nLegacy;=SUM(A1)\r\nAlice;safe\r\n"
    );
    const editable = await readEditableArtifact({
      filename: "contacts.csv",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });

    const saved = await writeEditableArtifact({
      filename: "contacts.csv",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      request: {
        expectedHash: editable.expectedHash,
        rows: [
          ["name", "value"],
          ["Legacy", "=SUM(A1)"],
          ["Alice", '=HYPERLINK("https://example.invalid")'],
          ["Bob", "  +cmd"],
          ["Carol", "-1"],
          ["Dan", "@SUM(A1)"],
          ["Eve", "\uFEFF=IMPORTDATA(A1)"],
        ],
      },
    });

    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("name;value\r\n");
    expect(raw).toContain("Legacy;=SUM(A1)");
    expect(raw).toContain("'  +cmd");
    expect(raw).toContain("'-1");
    expect(saved.rows?.[2]?.[1]).toStartWith("'=");
    expect(saved.rows?.[6]?.[1]).toStartWith("'\uFEFF=");
    expect(saved.delimiter).toBe(";");
  });

  test("rejects oversized edits and invalid row shapes", async () => {
    await seedArtifact("notes.md", "# First\n");
    await seedArtifact("table.tsv", "a\tb\n");
    await seedArtifact(
      "too-many.csv",
      Array.from({ length: ARTIFACT_EDIT_MAX_ROWS + 1 }, () => "x").join("\n")
    );
    const markdown = await readEditableArtifact({
      filename: "notes.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });
    const table = await readEditableArtifact({
      filename: "table.tsv",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });
    const tooMany = await readEditableArtifact({
      filename: "too-many.csv",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });

    await expect(
      writeEditableArtifact({
        filename: "notes.md",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        request: {
          content: "x".repeat(ARTIFACT_EDIT_MAX_FILE_BYTES + 1),
          expectedHash: markdown.expectedHash,
        },
      })
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      writeEditableArtifact({
        filename: "table.tsv",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        request: {
          expectedHash: table.expectedHash,
          rows: [
            Array.from({ length: ARTIFACT_EDIT_MAX_COLUMNS + 1 }, () => "x"),
          ],
        },
      })
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      writeEditableArtifact({
        filename: "table.tsv",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        request: {
          expectedHash: table.expectedHash,
          rows: [["x".repeat(ARTIFACT_EDIT_MAX_CELL_BYTES + 1)]],
        },
      })
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      writeEditableArtifact({
        filename: "too-many.csv",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        request: {
          expectedHash: tooMany.expectedHash,
          rows: [["replacement"]],
        },
      })
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      writeEditableArtifact({
        filename: "table.tsv",
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        request: {
          expectedHash: table.expectedHash,
          rows: Array.from({ length: ARTIFACT_EDIT_MAX_ROWS + 1 }, () => ["x"]),
        },
      })
    ).rejects.toMatchObject({ status: 413 });
  });

  test("rolls content back when the metadata rename fails", async () => {
    const filePath = await seedArtifact("notes.md", "# Original\n");
    const metadataPath = `${filePath}.atlas-meta.json`;
    const originalMetadata = JSON.stringify({
      mimeType: "text/markdown",
      savedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 11,
    });
    await writeFile(metadataPath, originalMetadata, "utf8");
    const editable = await readEditableArtifact({
      filename: "notes.md",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    });
    let renameCount = 0;

    await expect(
      writeEditableArtifact(
        {
          filename: "notes.md",
          orgId: ORG_ID,
          profileId: PROFILE_ID,
          request: {
            content: "# Should roll back\n",
            expectedHash: editable.expectedHash,
          },
        },
        {
          renameFile: async (from, to) => {
            renameCount += 1;
            if (renameCount === 2) {
              throw new Error("injected metadata failure");
            }
            await rename(from, to);
          },
        }
      )
    ).rejects.toMatchObject({ status: 500 });

    expect(await readFile(filePath, "utf8")).toBe("# Original\n");
    expect(await readFile(metadataPath, "utf8")).toBe(originalMetadata);
    expect(
      (await readdir(path.dirname(filePath))).filter((name) =>
        name.includes(".atlas-edit-")
      )
    ).toEqual([]);
  });
});
