import { afterEach, expect, test } from "bun:test";
import {
  link,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { unzipSync, zipSync } from "fflate";
import {
  inspectSpreadsheetArchive,
  publishSpreadsheet,
  spreadsheetRevision,
} from "./spreadsheet-io";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function spreadsheetDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-sheet-io-"));
  directories.push(directory);
  return directory;
}

test("chained spreadsheet edits advance one version without changing earlier files", async () => {
  const directory = await spreadsheetDirectory();
  let currentPath = path.join(directory, "template-management-domain.xlsx");
  const versions = [
    "template-management-domain.xlsx",
    "template-management-domain-v2.xlsx",
    "template-management-domain-v3.xlsx",
    "template-management-domain-v4.xlsx",
  ];
  for (const fileName of versions) {
    const bytes = Buffer.from(fileName);
    const published = await publishSpreadsheet({
      bytes,
      path: currentPath,
      writeMode: "versioned",
    });
    expect(published.path).toBe(path.join(directory, fileName));
    expect(published.revision).toBe(spreadsheetRevision(bytes));
    currentPath = published.path;
  }
  for (const fileName of versions) {
    expect(await readFile(path.join(directory, fileName), "utf8")).toBe(
      fileName
    );
  }
  expect((await readdir(directory)).sort()).toEqual(versions.toSorted());
});

test("numbered spreadsheet edits advance past the source version and occupied destinations", async () => {
  const directory = await spreadsheetDirectory();
  const source = path.join(directory, "report-v9.csv");
  const occupied = path.join(directory, "report-v10.csv");
  await writeFile(source, "source");
  await writeFile(occupied, "occupied");
  const published = await publishSpreadsheet({
    bytes: Buffer.from("edited"),
    path: source,
    writeMode: "versioned",
  });
  expect(published.path).toBe(path.join(directory, "report-v11.csv"));
  expect(await readFile(source, "utf8")).toBe("source");
  expect(await readFile(occupied, "utf8")).toBe("occupied");
  expect(await readFile(published.path, "utf8")).toBe("edited");
});

test.each([
  ["report-v2-v2.xlsx", "report-v4.xlsx"],
  ["report-v2-v3-v2.xlsx", "report-v6.xlsx"],
  ["api-v2-report-v2.xlsx", "api-v2-report-v3.xlsx"],
  ["report-v9007199254740992-v2.xlsx", "report-v9007199254740994.xlsx"],
])(
  "normalizes trailing legacy versions from %s to %s",
  async (sourceName, nextName) => {
    const directory = await spreadsheetDirectory();
    const source = path.join(directory, sourceName);
    await writeFile(source, "source");
    const published = await publishSpreadsheet({
      bytes: Buffer.from("edited"),
      path: source,
      writeMode: "versioned",
    });
    expect(published.path).toBe(path.join(directory, nextName));
    expect(await readFile(source, "utf8")).toBe("source");
  }
);

test("a new explicitly named spreadsheet keeps its requested version suffix", async () => {
  const directory = await spreadsheetDirectory();
  const requested = path.join(directory, "report-v9.json");
  const published = await publishSpreadsheet({
    bytes: Buffer.from("{}"),
    path: requested,
    writeMode: "versioned",
  });
  expect(published.path).toBe(requested);
});

test.each([
  ["10000", "10001", "10002"],
  ["20260910", "20260911", "20260912"],
  ["9007199254740992", "9007199254740993", "9007199254740994"],
  [
    "999999999999999999999999999999",
    "1000000000000000000000000000000",
    "1000000000000000000000000000001",
  ],
])(
  "advances version %s exactly past occupied destinations",
  async (version, occupiedVersion, nextVersion) => {
    const directory = await spreadsheetDirectory();
    const source = path.join(directory, `report-v${version}.xlsx`);
    const occupied = path.join(directory, `report-v${occupiedVersion}.xlsx`);
    await writeFile(source, "source");
    await writeFile(occupied, "occupied");
    const published = await publishSpreadsheet({
      bytes: Buffer.from("edited"),
      path: source,
      writeMode: "versioned",
    });
    expect(published.path).toBe(
      path.join(directory, `report-v${nextVersion}.xlsx`)
    );
    expect(await readFile(source, "utf8")).toBe("source");
    expect(await readFile(occupied, "utf8")).toBe("occupied");
    expect(await readFile(published.path, "utf8")).toBe("edited");
    expect(await readdir(directory)).toHaveLength(3);
  }
);

test("exhausted spreadsheet destinations preserve the source and clean temporary files", async () => {
  const directory = await spreadsheetDirectory();
  const source = path.join(directory, "report.xlsx");
  await writeFile(source, "source");
  for (let version = 2; version <= 10_000; version += 1) {
    await link(source, path.join(directory, `report-v${version}.xlsx`));
  }
  const before = (await readdir(directory)).sort();
  await expect(
    publishSpreadsheet({
      bytes: Buffer.from("edited"),
      path: source,
      writeMode: "versioned",
    })
  ).rejects.toThrow();
  expect(await readFile(source, "utf8")).toBe("source");
  expect((await readdir(directory)).sort()).toEqual(before);
}, 30_000);

test("concurrent spreadsheet edits publish distinct complete versions without overwriting", async () => {
  const directory = await spreadsheetDirectory();
  const source = path.join(directory, "report-v2.xlsx");
  await writeFile(source, "source");
  const contents = ["first edit", "second edit", "third edit"];
  const published = await Promise.all(
    contents.map((content) =>
      publishSpreadsheet({
        bytes: Buffer.from(content),
        path: source,
        writeMode: "versioned",
      })
    )
  );
  expect(published.map((result) => path.basename(result.path)).sort()).toEqual([
    "report-v3.xlsx",
    "report-v4.xlsx",
    "report-v5.xlsx",
  ]);
  for (const [index, result] of published.entries()) {
    expect(await readFile(result.path, "utf8")).toBe(contents[index]);
  }
  expect(await readFile(source, "utf8")).toBe("source");
  expect((await readdir(directory)).length).toBe(4);
});

test("inplace spreadsheet edits retain the versioned path and reject stale revisions", async () => {
  const directory = await spreadsheetDirectory();
  const source = path.join(directory, "report-v2-v2.xlsx");
  const original = Buffer.from("source");
  await writeFile(source, original);
  await expect(
    publishSpreadsheet({
      bytes: Buffer.from("unapproved"),
      path: source,
      writeMode: "inplace",
    })
  ).rejects.toThrow();
  expect(await readFile(source)).toEqual(original);
  const published = await publishSpreadsheet({
    bytes: Buffer.from("edited"),
    expectedRevision: spreadsheetRevision(original),
    path: source,
    writeMode: "inplace",
  });
  expect(published.path).toBe(source);
  await expect(
    publishSpreadsheet({
      bytes: Buffer.from("stale"),
      expectedRevision: spreadsheetRevision(original),
      path: source,
      writeMode: "inplace",
    })
  ).rejects.toThrow();
  expect(await readFile(source, "utf8")).toBe("edited");
  expect(await readdir(directory)).toEqual([path.basename(source)]);
});

test("spreadsheet preflight validates actual expansion before handing a ZIP to ExcelJS", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Tasks").addRow([1, 2, 3]);
  const original = new Uint8Array(await workbook.xlsx.writeBuffer());
  expect(() => inspectSpreadsheetArchive(original)).not.toThrow();
  const parts = unzipSync(original);
  parts["xl/oversized.bin"] = new Uint8Array(2 * 1024 * 1024).fill(65);
  const forged = zipSync(parts);
  const view = new DataView(
    forged.buffer,
    forged.byteOffset,
    forged.byteLength
  );
  let altered = false;
  for (let offset = 0; offset < forged.length - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02_01_4b_50) {
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(
      forged.subarray(offset + 46, offset + 46 + nameLength)
    );
    if (name === "xl/oversized.bin") {
      view.setUint32(offset + 24, 64, true);
      altered = true;
    }
  }
  expect(altered).toBe(true);
  expect(() => inspectSpreadsheetArchive(forged)).toThrow();
});
