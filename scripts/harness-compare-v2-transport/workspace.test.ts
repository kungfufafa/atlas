import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startComparisonProxy as startOriginalProxy } from "../harness-compare/proxy";
import type { HarnessTask } from "../harness-compare/types";
import { comparisonModel, startComparisonProxy } from "./proxy";

const task: HarnessTask = {
  category: "file_transformation",
  expected: { artifacts: [], finalFacts: {} },
  family: "private-study-label",
  id: "private-study-label-development-90210",
  initialFiles: { "input.txt": "Keep these exact fixture bytes.\n" },
  prompt: "Read the supplied file.",
  seed: 90_210,
  split: "development",
  turns: ["Read the supplied file."],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "broker-workspace-"));
  const keyFile = join(root, "fake-key");
  await writeFile(keyFile, "synthetic-workspace-test-key", { mode: 0o600 });
  const bodies: unknown[] = [];
  const options = {
    async fetchUpstream(_url: string, init: RequestInit) {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "done", role: "assistant" },
          },
        ],
        model: comparisonModel,
        usage: { completion_tokens: 3, prompt_tokens: 7 },
      });
    },
  };
  const proxy = await startComparisonProxy(keyFile, options);
  return { bodies, keyFile, options, proxy, root };
}

for (const harness of ["atlas", "hermes"] as const) {
  test(`${harness}: explicit workspace preserves fixtures and tool effects outside descriptive trace paths`, async () => {
    const f = await fixture();
    try {
      const directory = join(f.root, task.id, "wire");
      const workspaceRoot = join(f.root, "neutral", "workspace");
      const run = await f.proxy.register(
        "opaque-arm",
        harness,
        task,
        directory,
        { workspaceRoot }
      );
      expect(run.workspace).toBe(workspaceRoot);
      expect(run.workspace).not.toContain(task.family);
      expect(await f.proxy.snapshot(run)).toEqual(task.initialFiles);
      const response = await fetch(
        `${f.proxy.url}/runs/opaque-arm/tools/write_file`,
        {
          body: JSON.stringify({
            content: "Actual stored result.\n",
            path: "result.txt",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        bytes: Buffer.byteLength("Actual stored result.\n"),
        path: "result.txt",
      });
      expect(await readFile(join(workspaceRoot, "result.txt"), "utf8")).toBe(
        "Actual stored result.\n"
      );
      expect(await f.proxy.snapshot(run)).toEqual({
        ...task.initialFiles,
        "result.txt": "Actual stored result.\n",
      });
      expect(
        await Bun.file(join(directory, "workspace", "input.txt")).exists()
      ).toBe(false);
      expect(
        await Bun.file(join(directory, "tool-events.jsonl")).exists()
      ).toBe(true);
      expect(f.bodies).toHaveLength(0);
    } finally {
      await f.proxy.close();
      await rm(f.root, { force: true, recursive: true });
    }
  });
}

test("an explicit empty or relative workspace is rejected before writing fixtures", async () => {
  const f = await fixture();
  try {
    for (const workspaceRoot of ["", "relative-workspace"]) {
      const directory = join(f.root, workspaceRoot || "empty", "trace");
      await expect(
        f.proxy.register("opaque-arm", "atlas", task, directory, {
          workspaceRoot,
        })
      ).rejects.toThrow();
      expect(
        await Bun.file(join(directory, "workspace", "input.txt")).exists()
      ).toBe(false);
    }
    expect(f.bodies).toHaveLength(0);
  } finally {
    await f.proxy.close();
    await rm(f.root, { force: true, recursive: true });
  }
});

test("neutral workspace registration leaves generation controls and messages unchanged from the frozen broker", async () => {
  const f = await fixture();
  const original = await startOriginalProxy(f.keyFile, f.options);
  try {
    const amendedRun = await f.proxy.register(
      "opaque-new",
      "hermes",
      task,
      join(f.root, "new-traces"),
      { workspaceRoot: join(f.root, "neutral-workspace") }
    );
    const originalRun = await original.register(
      "opaque-old",
      "hermes",
      task,
      join(f.root, "original-traces")
    );
    const input = {
      max_tokens: 80,
      messages: [{ content: "Generate the requested result.", role: "user" }],
      model: comparisonModel,
      response_format: { type: "json_object" },
      temperature: 0.8,
    };
    for (const [proxy, run] of [
      [original, originalRun],
      [f.proxy, amendedRun],
    ] as const) {
      const response = await fetch(
        `${proxy.url}/runs/${run.id}/v1/chat/completions`,
        {
          body: JSON.stringify(input),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        usage: { completion_tokens: 3, prompt_tokens: 7 },
      });
      expect(run).toMatchObject({
        generatedTokens: 3,
        promptTokens: 7,
        providerRequests: 1,
        providerStatuses: [200],
      });
    }
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[0]).toEqual(f.bodies[1]);
    expect(await f.proxy.snapshot(amendedRun)).toEqual(
      await original.snapshot(originalRun)
    );
  } finally {
    await original.close();
    await f.proxy.close();
    await rm(f.root, { force: true, recursive: true });
  }
});
