import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@atlas/core";
import { canRunToolCallsInParallel, executeToolCall } from "./tool-loop";

const sampleTool: ToolDefinition = {
  description: "Sample tool for tests",
  name: "sample",
  parameters: {
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
    type: "object",
  },
  run(input) {
    return Promise.resolve(input);
  },
};

describe("tool-loop", () => {
  test("canRunToolCallsInParallel requires more than one parallelSafe tool", () => {
    const parallelTool: ToolDefinition = { ...sampleTool, parallelSafe: true };
    const sequentialTool: ToolDefinition = {
      ...sampleTool,
      name: "sequential",
    };

    expect(
      canRunToolCallsInParallel(
        [parallelTool],
        [{ arguments: {}, id: "1", name: "sample" }]
      )
    ).toBe(false);
    expect(
      canRunToolCallsInParallel(
        [parallelTool],
        [
          { arguments: {}, id: "1", name: "sample" },
          { arguments: {}, id: "2", name: "sample" },
        ]
      )
    ).toBe(true);
    expect(
      canRunToolCallsInParallel(
        [parallelTool, sequentialTool],
        [
          { arguments: {}, id: "1", name: "sample" },
          { arguments: {}, id: "2", name: "sequential" },
        ]
      )
    ).toBe(false);
  });

  test("executeToolCall runs a known tool", async () => {
    const result = await executeToolCall([sampleTool], {
      arguments: { message: "hello" },
      id: "call_1",
      name: "sample",
    });

    expect(result).toEqual({ message: "hello" });
  });

  test("executeToolCall returns an error for unknown tools", async () => {
    const result = await executeToolCall([sampleTool], {
      arguments: {},
      id: "call_2",
      name: "missing",
    });

    expect(result).toEqual({ error: "Unknown tool: missing" });
  });

  test("executeToolCall catches handler errors", async () => {
    const failingTool: ToolDefinition = {
      description: "Always fails",
      name: "fail",
      async run() {
        throw new Error("boom");
      },
    };

    const result = await executeToolCall([failingTool], {
      arguments: {},
      id: "call_3",
      name: "fail",
    });

    expect(result).toEqual({
      error: "boom",
      errorCode: "INTERNAL_ERROR",
    });
  });

  test("keeps detected artifacts when a tool returns plain text", async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "atlas-agent-tool-artifact-")
    );
    const fileTool: ToolDefinition<Record<string, never>, string> = {
      description: "Create a file and return plain text",
      name: "plain_file_tool",
      async run() {
        const artifactsDir = path.join(workspaceRoot, "artifacts");
        await mkdir(artifactsDir, { recursive: true });
        await writeFile(path.join(artifactsDir, "result.csv"), "a,b\n1,2\n");
        return "created";
      },
    };

    try {
      const result = await executeToolCall(
        [fileTool],
        { arguments: {}, id: "call_file", name: "plain_file_tool" },
        { workspaceRoot }
      );

      expect(result).toEqual({
        artifacts: [
          expect.objectContaining({
            filename: "result.csv",
            path: "artifacts/result.csv",
            sizeBytes: 8,
          }),
        ],
        result: "created",
      });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
