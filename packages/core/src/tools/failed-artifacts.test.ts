import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractPairedTurnArtifacts,
  extractSessionArtifacts,
  extractTurnDeliverableArtifacts,
} from "../channel-artifacts";
import type { ChatMessage } from "../contract";
import { executeProtectedTool } from "./execution";

for (const failure of [
  { success: false },
  { ok: false },
  { isError: true },
  { error: "conversion failed after writing partial output" },
]) {
  test(`failed result ${JSON.stringify(failure)} cannot publish partial artifacts`, async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "atlas-failed-artifact-")
    );
    const artifact = {
      filename: "partial.csv",
      path: "artifacts/partial.csv",
      sizeBytes: 8,
    };
    try {
      const execution = await executeProtectedTool(
        {
          description: "Controlled failed conversion",
          name: "audit_conversion",
          async run() {
            await mkdir(path.join(workspaceRoot, "artifacts"));
            await writeFile(
              path.join(workspaceRoot, artifact.path),
              "ID\n00123"
            );
            return {
              ...failure,
              artifacts: [artifact],
              path: path.join(workspaceRoot, artifact.path),
            };
          },
        },
        {},
        { workspaceRoot }
      );
      expect(
        await readFile(path.join(workspaceRoot, artifact.path), "utf8")
      ).toBe("ID\n00123");
      expect(execution.artifacts).toBeUndefined();
      const messages: ChatMessage[] = [
        { content: "Create a complete document", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            {
              arguments: { path: artifact.path },
              id: "failed",
              name: "write_file",
            },
          ],
        },
        {
          content: JSON.stringify(execution.data),
          name: "write_file",
          role: "tool",
          toolCallId: "failed",
        },
      ];
      expect(extractPairedTurnArtifacts(messages)).toEqual([]);
      expect(extractSessionArtifacts(messages)).toEqual([]);
      expect(
        extractTurnDeliverableArtifacts(messages, [
          {
            filename: artifact.filename,
            mimeType: "text/csv",
            path: "partial.csv",
            savedAt: "",
            sizeBytes: 8,
          },
        ])
      ).toEqual([]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
}

test("a successful independent result remains deliverable beside a failure", () => {
  const messages: ChatMessage[] = [
    { content: "Create two reports", role: "user" },
    {
      content: JSON.stringify({
        artifacts: [{ path: "artifacts/complete.csv", sizeBytes: 3 }],
        ok: true,
      }),
      name: "report",
      role: "tool",
      toolCallId: "ok",
    },
    {
      content: JSON.stringify({
        artifacts: [{ path: "artifacts/partial.csv", sizeBytes: 1 }],
        ok: false,
      }),
      name: "report",
      role: "tool",
      toolCallId: "failed",
    },
  ];
  expect(
    extractTurnDeliverableArtifacts(messages).map((artifact) => artifact.path)
  ).toEqual(["complete.csv"]);
});

test("filesystem detection cannot redeliver a failed tool's undeclared partial output", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "atlas-failed-scan-")
  );
  try {
    const failed = await executeProtectedTool(
      {
        description: "Controlled conversion",
        name: "audit_conversion",
        async run() {
          await mkdir(path.join(workspaceRoot, "artifacts"));
          await writeFile(
            path.join(workspaceRoot, "artifacts", "partial.csv"),
            "ID\n"
          );
          return { error: "Interrupted after creating the file", ok: false };
        },
      },
      {},
      { workspaceRoot }
    );
    expect(failed.artifacts).toBeUndefined();
    const later = await executeProtectedTool(
      {
        description: "Later independent conversion",
        name: "audit_conversion",
        async run() {
          await writeFile(
            path.join(workspaceRoot, "artifacts", "complete.csv"),
            "ID\n00123\n"
          );
          return { ok: true, path: "artifacts/complete.csv" };
        },
      },
      {},
      { workspaceRoot }
    );
    expect(later.artifacts?.map((artifact) => artifact.path)).toEqual([
      "artifacts/complete.csv",
    ]);
    expect(
      await readFile(
        path.join(workspaceRoot, "artifacts", "partial.csv"),
        "utf8"
      )
    ).toBe("ID\n");
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});
