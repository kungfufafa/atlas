import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnJsonTool } from "../src/services/custom-tool-subprocess";
import { buildServer } from "./build";

const expectedRuntimeAssets = [
  "javascript-tool-runner.js",
  "javascript-tool-sandbox-linux.c",
  "javascript-tool-sandbox-linux.js",
] as const;

describe("server production build", () => {
  let testRoot = "";

  afterEach(async () => {
    if (testRoot) {
      await rm(testRoot, { force: true, recursive: true });
      testRoot = "";
    }
  });

  test("emits and executes the adjacent custom-tool runtime assets", async () => {
    testRoot = await mkdtemp(path.join(os.tmpdir(), "atlas-production-build-"));
    const outdir = path.join(testRoot, "dist");
    await buildServer({ outdir });

    expect(await Bun.file(path.join(outdir, "index.js")).exists()).toBe(true);
    for (const assetName of expectedRuntimeAssets) {
      expect(await Bun.file(path.join(outdir, assetName)).exists()).toBe(true);
    }
    const builtIndex = await readFile(path.join(outdir, "index.js"), "utf8");
    expect(builtIndex).toContain(
      'new URL("./javascript-tool-runner.js", import.meta.url)'
    );

    const moduleDirectory = path.join(testRoot, "tools");
    const workspaceRoot = path.join(testRoot, "workspace");
    const modulePath = path.join(moduleDirectory, "production-probe.js");
    await mkdir(moduleDirectory);
    await mkdir(workspaceRoot);
    await writeFile(
      modulePath,
      `export async function run(input, context) {
  return {
    message: input.message,
    productionRunner: true,
    workspaceRoot: context.workspaceRoot,
  };
}
`,
      "utf8"
    );

    const probeOptions = {
      bin: "bun",
      context: {},
      input: { message: "ready" },
      label: "Production JavaScript tool smoke test",
      mode: "--run" as const,
      modulePath,
      runnerPath: path.join(outdir, "javascript-tool-runner.js"),
      workspaceRoot,
    };
    let result: unknown;
    try {
      result = await spawnJsonTool({
        ...probeOptions,
        requireSandbox: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nestedSandboxUnavailable =
        /sandbox_apply: Operation not permitted/i.test(message) ||
        /require Landlock ABI 3/i.test(message);
      if (!nestedSandboxUnavailable) {
        throw error;
      }
      result = await spawnJsonTool(probeOptions);
    }

    expect(result).toEqual({
      message: "ready",
      productionRunner: true,
      workspaceRoot,
    });
  }, 30_000);
});
