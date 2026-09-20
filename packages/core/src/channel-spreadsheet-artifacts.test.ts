import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  type ChannelArtifactRef,
  extractSessionArtifacts,
  extractTurnDeliverableArtifacts,
} from "./channel-artifacts";
import type { ChatMessage } from "./contract";
import { spreadsheetTool } from "./tools/spreadsheet";

function spreadsheetStep(
  id: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>
): ChatMessage[] {
  return [
    {
      content: "",
      role: "assistant",
      toolCalls: [{ arguments: input, id, name: "spreadsheet" }],
    },
    {
      content: JSON.stringify(result),
      name: "spreadsheet",
      role: "tool",
      toolCallId: id,
    },
  ];
}

function createdWorkbook(filename = "domain.xlsx"): ChatMessage[] {
  return spreadsheetStep(
    `create-${filename}`,
    { action: "create", path: `artifacts/${filename}` },
    { bytesWritten: 100, path: `artifacts/${filename}` }
  );
}

function editWorkbook(
  source: string,
  destination: string,
  action = "format_range"
): ChatMessage[] {
  return spreadsheetStep(
    `edit-${destination}`,
    { action, path: `artifacts/${source}` },
    {
      bytesWritten: 200,
      path: `artifacts/${destination}`,
      sourcePath: `artifacts/${source}`,
    }
  );
}

function deliverablePaths(
  messages: ChatMessage[],
  streamed: ChannelArtifactRef[] = []
): string[] {
  return extractTurnDeliverableArtifacts(messages, streamed).map(
    (artifact) => artifact.path
  );
}

describe("spreadsheet channel delivery", () => {
  test("delivers the final real workbook with all sheets and formatting", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "atlas-sheet-chain-"));
    try {
      const workspaceRoot = await realpath(directory);
      const messages: ChatMessage[] = [
        { content: "Buat template manajemen domain", role: "user" },
      ];
      const outputs: string[] = [];
      let currentPath = "artifacts/domain.xlsx";
      const steps = [
        { action: "create", columns: ["Domain"], sheetName: "Domains" },
        { action: "add_sheet", columns: ["Owner"], sheetName: "Owners" },
        {
          action: "format_range",
          format: { bold: true, fillColor: "#1F4E78" },
          range: "A1",
          sheetName: "Owners",
        },
      ];
      for (const step of steps) {
        const input = { ...step, path: currentPath };
        const result = (await spreadsheetTool.run(input, {
          orgId: "org_test",
          profileId: "profile_test",
          workspaceRoot,
        })) as Record<string, unknown> & { path: string };
        messages.push(...spreadsheetStep(step.action, input, result));
        currentPath = result.path;
        outputs.push(currentPath);
      }

      expect(outputs).toEqual([
        "artifacts/domain.xlsx",
        "artifacts/domain-v2.xlsx",
        "artifacts/domain-v3.xlsx",
      ]);
      expect(deliverablePaths(messages)).toEqual(["domain-v3.xlsx"]);
      expect(extractSessionArtifacts(messages)).toHaveLength(3);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(path.join(workspaceRoot, currentPath));
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
        "Domains",
        "Owners",
      ]);
      expect(workbook.getWorksheet("Owners")?.getCell("A1").font.bold).toBe(
        true
      );
      expect(workbook.getWorksheet("Owners")?.getCell("A1").fill).toEqual({
        fgColor: { argb: "FF1F4E78" },
        pattern: "solid",
        type: "pattern",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("supersedes the create source after a successful batch_edit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "atlas-sheet-batch-"));
    try {
      const workspaceRoot = await realpath(directory);
      const context = {
        orgId: "org_test",
        profileId: "profile_test",
        workspaceRoot,
      };
      const createInput = {
        action: "create",
        columns: ["Domain"],
        path: "artifacts/domain.xlsx",
        sheetName: "Domains",
      };
      const created = (await spreadsheetTool.run(
        createInput,
        context
      )) as Record<string, unknown> & { path: string };
      const editInput = {
        action: "batch_edit",
        operations: [
          {
            action: "write_range",
            range: "A2",
            values: [["example.com"]],
          },
        ],
        path: created.path,
      };
      const edited = (await spreadsheetTool.run(editInput, context)) as Record<
        string,
        unknown
      > & { path: string; sourcePath?: string };

      expect(edited.path).not.toBe(created.path);
      expect(edited.sourcePath).toBe(created.path);
      expect(
        deliverablePaths([
          { content: "Create and fill the workbook", role: "user" },
          ...spreadsheetStep("create", createInput, created),
          ...spreadsheetStep("batch", editInput, edited),
        ])
      ).toEqual([edited.path.replace(/^artifacts\//, "")]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("filters legacy stacked versions even when embedded and streamed", () => {
    const messages = [
      ...createdWorkbook(),
      ...editWorkbook("domain.xlsx", "domain-v2.xlsx", "add_sheet"),
      ...editWorkbook("domain-v2.xlsx", "domain-v2-v2.xlsx"),
    ];
    const streamed = extractSessionArtifacts(messages);
    messages.push(
      ...spreadsheetStep(
        "embedded",
        { action: "format_range", path: "artifacts/domain-v2.xlsx" },
        {
          artifacts: streamed.map((artifact) => ({
            ...artifact,
            path: `artifacts/${artifact.path}`,
          })),
          path: "artifacts/domain-v2-v2.xlsx",
          sourcePath: "artifacts/domain-v2.xlsx",
        }
      )
    );

    const artifacts = extractTurnDeliverableArtifacts(messages, streamed);
    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "domain-v2-v2.xlsx",
    ]);
    expect(artifacts[0]?.sizeBytes).toBe(200);
  });

  test("uses the current file size after an in-place edit of the final spreadsheet", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "atlas-sheet-inplace-")
    );
    try {
      const workspaceRoot = await realpath(directory);
      const context = {
        orgId: "org_test",
        profileId: "profile_test",
        workspaceRoot,
      };
      const createInput = {
        action: "create",
        data: [["Original content that will be shortened"]],
        path: "artifacts/domain.csv",
      };
      const created = (await spreadsheetTool.run(
        createInput,
        context
      )) as Record<string, unknown> & {
        path: string;
        revision: string;
      };
      const editInput = {
        action: "write_range",
        expectedRevision: created.revision,
        path: created.path,
        range: "A1",
        values: [["Short"]],
        writeMode: "inplace",
      };
      const edited = (await spreadsheetTool.run(editInput, context)) as Record<
        string,
        unknown
      >;
      const [artifact] = extractTurnDeliverableArtifacts([
        { content: "Shorten the spreadsheet in place", role: "user" },
        ...spreadsheetStep("create", createInput, created),
        ...spreadsheetStep("edit", editInput, edited),
      ]);
      const bytes = await readFile(path.join(workspaceRoot, created.path));

      expect(bytes.toString().trim()).toBe("Short");
      expect(artifact).toMatchObject({
        path: "domain.csv",
        sizeBytes: bytes.length,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test.each([
    "write_range",
    "format_range",
    "add_sheet",
    "delete_sheet",
    "import_csv",
    "recalculate",
    "batch_edit",
  ])("supersedes successful %s input", (action) => {
    expect(
      deliverablePaths([
        ...createdWorkbook(),
        ...editWorkbook("domain.xlsx", "finished.xlsx", action),
      ])
    ).toEqual(["finished.xlsx"]);
  });

  test("preserves independent creations, export formats, and edit branches", () => {
    expect(
      deliverablePaths([
        ...createdWorkbook(),
        ...editWorkbook("domain.xlsx", "domain-v2.xlsx"),
        ...editWorkbook("domain-v2.xlsx", "domain-v3.xlsx"),
        ...editWorkbook("domain-v2.xlsx", "alternative.xlsx"),
        ...editWorkbook("domain-v3.xlsx", "domain.csv", "export_csv"),
        ...editWorkbook("domain-v3.xlsx", "copy.xlsx", "export_xlsx"),
        ...editWorkbook("domain-v3.xlsx", "domain-v4.xlsx", "create"),
        ...createdWorkbook("other/domain-v9.xlsx"),
      ])
    ).toEqual([
      "domain-v3.xlsx",
      "alternative.xlsx",
      "domain.csv",
      "copy.xlsx",
      "domain-v4.xlsx",
      "other/domain-v9.xlsx",
    ]);
  });

  test.each([
    { error: "Edit failed" },
    { success: false },
    { ok: false },
    { isError: true },
  ])("keeps the last successful version after failure %j", (failure) => {
    const messages = [
      ...createdWorkbook(),
      ...editWorkbook("domain.xlsx", "domain-v2.xlsx"),
      ...spreadsheetStep(
        "failed-edit",
        { action: "format_range", path: "artifacts/domain-v2.xlsx" },
        {
          ...failure,
          artifacts: [{ path: "artifacts/failed.xlsx" }],
          path: "artifacts/failed.xlsx",
          sourcePath: "artifacts/domain-v2.xlsx",
        }
      ),
    ];
    expect(deliverablePaths(messages)).toEqual(["domain-v2.xlsx"]);
  });

  test.each(["inspect", "read_range"])(
    "%s of an intermediate workbook does not revive it",
    (action) => {
      expect(
        deliverablePaths([
          ...createdWorkbook(),
          ...editWorkbook("domain.xlsx", "domain-v2.xlsx"),
          ...editWorkbook("domain.xlsx", "domain.xlsx", action),
        ])
      ).toEqual(["domain-v2.xlsx"]);
    }
  );

  test("uses resolved provenance and falls back to explicit artifact inputs", () => {
    expect(
      deliverablePaths([
        ...createdWorkbook(),
        ...spreadsheetStep(
          "resolved-edit",
          { action: "write_range", path: "domain.xlsx" },
          {
            path: "artifacts/domain-v2.xlsx",
            sourcePath: "/workspace/artifacts/domain.xlsx",
          }
        ),
        ...spreadsheetStep(
          "legacy-edit",
          { action: "format_range", path: "./artifacts/domain-v2.xlsx" },
          { path: "artifacts/domain-v3.xlsx" }
        ),
      ])
    ).toEqual(["domain-v3.xlsx"]);
  });

  test("keeps outputs without proven edit provenance", () => {
    expect(
      deliverablePaths([
        ...createdWorkbook(),
        ...spreadsheetStep(
          "missing-action",
          { path: "artifacts/domain.xlsx" },
          {
            path: "artifacts/domain-v2.xlsx",
            sourcePath: "artifacts/domain.xlsx",
          }
        ),
        ...spreadsheetStep(
          "outside-source",
          { action: "format_range", path: "artifacts/domain.xlsx" },
          { path: "artifacts/domain-v3.xlsx", sourcePath: "domain.xlsx" }
        ),
        ...spreadsheetStep(
          "outside-output",
          { action: "format_range", path: "artifacts/domain-v3.xlsx" },
          { path: "notes/domain.xlsx", sourcePath: "artifacts/domain-v3.xlsx" }
        ),
        ...spreadsheetStep(
          "no-output",
          { action: "format_range", path: "artifacts/domain-v3.xlsx" },
          { sourcePath: "artifacts/domain-v3.xlsx" }
        ),
      ])
    ).toEqual(["domain.xlsx", "domain-v2.xlsx", "domain-v3.xlsx"]);
  });

  test("a later successful inplace edit revives its output path", () => {
    const artifacts = extractTurnDeliverableArtifacts([
      ...createdWorkbook(),
      ...editWorkbook("domain.xlsx", "domain-v2.xlsx"),
      ...editWorkbook("domain.xlsx", "domain.xlsx"),
    ]);
    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "domain.xlsx",
      "domain-v2.xlsx",
    ]);
    expect(artifacts[0]?.sizeBytes).toBe(200);
  });

  test.each(["bash", "python"])(
    "a later successful %s artifact revives its output path",
    (name) => {
      const artifacts = extractTurnDeliverableArtifacts([
        ...createdWorkbook(),
        ...editWorkbook("domain.xlsx", "domain-v2.xlsx"),
        {
          content: JSON.stringify({
            artifacts: [{ path: "artifacts/domain.xlsx", sizeBytes: 300 }],
          }),
          name,
          role: "tool",
          toolCallId: "rewrite-workbook",
        },
      ]);
      expect(artifacts.map((artifact) => artifact.path)).toEqual([
        "domain.xlsx",
        "domain-v2.xlsx",
      ]);
      expect(artifacts[0]?.sizeBytes).toBe(300);
    }
  );

  test("a later write_file updates the size of a revived workbook", () => {
    const artifacts = extractTurnDeliverableArtifacts([
      ...createdWorkbook("domain.csv"),
      ...editWorkbook("domain.csv", "domain-v2.csv"),
      {
        content: JSON.stringify({
          bytesWritten: 3,
          path: "artifacts/domain.csv",
        }),
        name: "write_file",
        role: "tool",
        toolCallId: "rewrite-workbook",
      },
    ]);

    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "domain.csv",
      "domain-v2.csv",
    ]);
    expect(artifacts[0]?.sizeBytes).toBe(3);
  });

  test("supersession is scoped to the latest turn", () => {
    expect(
      deliverablePaths([
        { content: "first turn", role: "user" },
        ...createdWorkbook(),
        ...editWorkbook("domain.xlsx", "domain-v2.xlsx"),
        { content: "second turn", role: "user" },
        ...editWorkbook("domain.xlsx", "domain.xlsx"),
      ])
    ).toEqual(["domain.xlsx"]);
  });
});
