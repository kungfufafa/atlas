import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolContext } from "@atlas/core";
import { pythonExecuteTool, runPythonExecute } from "./python-execute-tool";

describe("python_execute tool", () => {
  async function withTempWorkspace<T>(
    fn: (workspaceRoot: string, context: ToolContext) => Promise<T>
  ): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-py-test-"));
    const context: ToolContext = {
      orgId: "org_test",
      profileId: "profile_test",
      workspaceRoot: dir,
    };
    try {
      return await fn(dir, context);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }

  test("executes basic Python script and captures stdout", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      const res = await runPythonExecute(
        {
          code: "print('Hello from Python!')\nprint(12500 * 17.5 / 7)",
        },
        context
      );
      expect(res.success).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Hello from Python!");
      expect(res.stdout).toContain("31250.0");
      expect(res.stderr).toBe("");
    });
  });

  test("processes input CSV file and generates an artifact", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      const csvContent =
        "item,price,qty\napple,2.5,10\nbanana,1.0,20\norange,3.0,5\n";
      await writeFile(path.join(workspaceRoot, "sales.csv"), csvContent);

      const code = `
import csv

total = 0
with open('sales.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        total += float(row['price']) * int(row['qty'])

print(f"TOTAL_REVENUE: {total}")

with open('summary.txt', 'w') as f:
    f.write(f"Total Revenue: {total}\\n")
`;

      const res = await runPythonExecute(
        {
          code,
          files: ["sales.csv"],
        },
        context
      );

      expect(res.success).toBe(true);
      expect(res.stdout).toContain("TOTAL_REVENUE: 60.0");
      expect(res.artifactsGenerated.length).toBeGreaterThanOrEqual(1);
      const summaryArtifact = res.artifactsGenerated.find(
        (a) => a.name === "summary.txt"
      );
      expect(summaryArtifact).toBeDefined();
      expect(summaryArtifact?.path).toBe("summary.txt");
    });
  });

  test("captures stderr on Python syntax or runtime error", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      const res = await runPythonExecute(
        {
          code: "raise ValueError('Custom analysis error')",
        },
        context
      );
      expect(res.success).toBe(false);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain("ValueError: Custom analysis error");
    });
  });

  test("handles execution timeout safely", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      const res = await runPythonExecute(
        {
          code: "import time\ntime.sleep(5)",
          timeout: 1000,
        },
        context
      );
      expect(res.success).toBe(false);
      expect(res.stderr).toContain("timed out");
    });
  });

  test("cancels execution immediately when AbortSignal fires", async () => {
    await withTempWorkspace(async (_workspaceRoot, context) => {
      const controller = new AbortController();
      const cancelContext: ToolContext = {
        ...context,
        signal: controller.signal,
      };

      setTimeout(() => {
        controller.abort();
      }, 50);

      try {
        await runPythonExecute(
          {
            code: "import time\ntime.sleep(10)",
            timeout: 30_000,
          },
          cancelContext
        );
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(String(err)).toContain("cancelled");
      }
    });
  });

  test("pythonExecuteTool matches ToolDefinition interface", () => {
    expect(pythonExecuteTool.name).toBe("python_execute");
    expect(pythonExecuteTool.parameters).toBeDefined();
    expect(pythonExecuteTool.description).toBeDefined();
  });
});
