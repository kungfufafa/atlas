import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { builtinTools, readFileTool, writeFileTool } from "./builtin";
import { executeProtectedTool } from "./execution";
import { jsonSchemaFromZod, validateToolArguments } from "./schema";
import { spreadsheetTool } from "./spreadsheet";

test("protected real spreadsheet accepts documented defaults before its Zod handler", async () => {
  const workspaceRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "atlas-default-input-"))
  );
  const context = {
    orgId: "audit-org",
    profileId: "audit-profile",
    workspaceRoot,
  };
  try {
    const created = await executeProtectedTool(
      spreadsheetTool,
      {
        action: "create",
        data: [["00123", 7]],
        path: "artifacts/defaults.xlsx",
      },
      context
    );
    expect(created.success).toBe(true);
    const source = created.data as { path: string };
    const read = await executeProtectedTool(
      spreadsheetTool,
      { action: "read_range", path: source.path, range: "A1:B1" },
      context
    );
    expect(read.success, JSON.stringify(read)).toBe(true);
    expect(read.data).toMatchObject({ rows: [["00123", 7]] });
    const invalid = await executeProtectedTool(
      spreadsheetTool,
      {
        action: "create",
        escapeCsvFormulas: "yes",
        path: "artifacts/invalid.xlsx",
      },
      context
    );
    expect(invalid.success).toBe(false);
    expect(invalid.error?.code).toBe("INVALID_ARGUMENT");
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test.each(["  ID,Value\r\n00123,7\r\n", "", "\n\t "])(
  "write_file preserves exact text bytes including empty content: %j",
  async (content) => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "atlas-text-bytes-")
    );
    try {
      const result = await executeProtectedTool(
        writeFileTool,
        { content, path: "artifacts/bytes.csv" },
        { orgId: "audit-org", profileId: "audit-profile", workspaceRoot }
      );
      expect(result.success).toBe(true);
      expect(
        await readFile(path.join(workspaceRoot, "artifacts/bytes.csv"))
      ).toEqual(Buffer.from(content));
      expect(result.data).toMatchObject({
        bytesWritten: Buffer.byteLength(content),
      });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  }
);

test("preprocessed file inputs remain typed while omitted defaults stay optional", () => {
  expect(() =>
    validateToolArguments(readFileTool.parameters, { path: "test.txt" })
  ).not.toThrow();
  for (const args of [
    { cwd: {}, path: "test.txt" },
    { offset: "wrong", path: "test.txt" },
    { limit: false, path: "test.txt" },
  ]) {
    expect(() =>
      validateToolArguments(readFileTool.parameters, args)
    ).toThrow();
  }
});

test("builtin parameter schemas all compile; effects describe the accepted input", () => {
  for (const tool of builtinTools) {
    try {
      validateToolArguments(tool.parameters, {});
    } catch (error) {
      expect(String(error), tool.name).not.toContain(
        "schema cannot be validated"
      );
    }
  }
  const schema = jsonSchemaFromZod(
    z.object({
      enabled: z.boolean().default(true),
      value: z.string().transform((value) => value.length),
    })
  );
  expect(() => validateToolArguments(schema, { value: "value" })).not.toThrow();
  expect(() => validateToolArguments(schema, { value: 5 })).toThrow();
  expect(() => jsonSchemaFromZod(z.object({ date: z.date() }))).toThrow();
});
