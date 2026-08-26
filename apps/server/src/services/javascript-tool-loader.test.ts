import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeToolCall } from "@atlas/agent";
import type { StoredToolRecord } from "@atlas/db";
import {
  invalidateJavascriptModuleCache,
  loadJavascriptTool,
  resolveJavascriptModulePath,
} from "./javascript-tool-loader";

const originalConfigDir = process.env.ATLAS_CONFIG_DIR;

async function setupToolsDir(): Promise<{
  configDir: string;
  toolsDir: string;
}> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "atlas-config-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
  const toolsDir = path.join(configDir, "tools");
  await mkdir(toolsDir, { recursive: true });
  return { configDir, toolsDir };
}

describe("javascript tool loader", () => {
  let configDir = "";

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = originalConfigDir;
    }

    if (configDir) {
      await rm(configDir, { force: true, recursive: true });
      configDir = "";
    }
  });

  test("loads a module and runs exported run(input)", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;

    await writeFile(
      path.join(toolsDir, "echo.js"),
      `export const parameters = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
};

export async function run(input) {
  return { echoed: input.message };
}
`,
      "utf8"
    );

    const record: StoredToolRecord = {
      createdAt: new Date().toISOString(),
      description: "Echo a message",
      handlerConfig: { modulePath: "echo.js" },
      handlerType: "javascript",
      id: "tool_echo",
      name: "echo",
      updatedAt: new Date().toISOString(),
    };

    const tool = await loadJavascriptTool(record);

    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("echo");
    expect(tool?.parameters?.required).toEqual(["message"]);

    const result = await tool!.run({ message: "hello" }, {});
    expect(result).toEqual({ echoed: "hello" });
  });

  test("loads parallelSafe when the module exports it", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;

    await writeFile(
      path.join(toolsDir, "parallel-echo.js"),
      `export const parallelSafe = true;

export async function run(input) {
  return { echoed: input.message };
}
`,
      "utf8"
    );

    const record: StoredToolRecord = {
      createdAt: new Date().toISOString(),
      description: "Parallel-safe echo",
      handlerConfig: { modulePath: "parallel-echo.js" },
      handlerType: "javascript",
      id: "tool_parallel_echo",
      name: "parallel_echo",
      updatedAt: new Date().toISOString(),
    };

    const tool = await loadJavascriptTool(record);

    expect(tool?.parallelSafe).toBe(true);
  });

  test("retries transient JavaScript failures at the protected tool boundary", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;

    await writeFile(
      path.join(toolsDir, "flaky.js"),
      `export const retrySafe = true;
let attempts = 0;
export async function run() {
  attempts += 1;
  if (attempts < 3) throw new Error("transient custom failure");
  return { attempts, ok: true };
}
`,
      "utf8"
    );

    const tool = await loadJavascriptTool({
      createdAt: new Date().toISOString(),
      description: "Flaky custom tool",
      handlerConfig: { modulePath: "flaky.js" },
      handlerType: "javascript",
      id: "tool_flaky",
      name: "flaky_custom_tool",
      updatedAt: new Date().toISOString(),
    });

    expect(tool?.retryPolicy).toEqual({
      backoffFactor: 2,
      initialDelayMs: 500,
      jitter: false,
      maxRetries: 2,
      retryableCodes: [
        "INTERNAL_ERROR",
        "NETWORK_ERROR",
        "PROVIDER_ERROR",
        "RESOURCE_LIMIT",
        "TIMEOUT",
      ],
    });

    // Keep the integration test fast while retaining the production policy
    // assertion above. Execution still flows through tool-loop -> protected tool.
    tool!.retryPolicy = { ...tool!.retryPolicy, initialDelayMs: 1 };
    const result = await executeToolCall(
      [tool!],
      { arguments: {}, id: "call_flaky", name: tool!.name },
      {}
    );

    expect(result).toEqual({ attempts: 3, ok: true });
  });

  test("does not retry an unmarked custom tool that may have side effects", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;

    await writeFile(
      path.join(toolsDir, "side-effect.js"),
      `let attempts = 0;
export async function run() {
  attempts += 1;
  throw new Error(\`side effect attempt \${attempts}\`);
}
`,
      "utf8"
    );

    const tool = await loadJavascriptTool({
      createdAt: new Date().toISOString(),
      description: "Potentially mutating custom tool",
      handlerConfig: { modulePath: "side-effect.js" },
      handlerType: "javascript",
      id: "tool_side_effect",
      name: "custom_operation",
      updatedAt: new Date().toISOString(),
    });

    expect(tool?.retryPolicy).toEqual({ maxRetries: 0 });
    const result = await executeToolCall(
      [tool!],
      { arguments: {}, id: "call_side_effect", name: tool!.name },
      {}
    );

    expect(result).toEqual({
      error: "side effect attempt 1",
      errorCode: "INTERNAL_ERROR",
    });
  });

  test("revokes retry opt-in immediately after a module reload", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    const modulePath = path.join(toolsDir, "reloadable.js");
    const record: StoredToolRecord = {
      createdAt: new Date().toISOString(),
      description: "Reloadable custom tool",
      handlerConfig: { modulePath: "reloadable.js" },
      handlerType: "javascript",
      id: "tool_reloadable",
      name: "reloadable_custom_tool",
      updatedAt: new Date().toISOString(),
    };

    await writeFile(
      modulePath,
      `export const retrySafe = true;
export async function run() { return "first"; }
`,
      "utf8"
    );
    expect((await loadJavascriptTool(record))?.retryPolicy?.maxRetries).toBe(2);

    await writeFile(
      modulePath,
      `export async function run() { return "second"; }
`,
      "utf8"
    );
    invalidateJavascriptModuleCache(modulePath);

    const reloaded = await loadJavascriptTool(record);
    expect(reloaded?.retryPolicy).toEqual({ maxRetries: 0 });
    expect(await reloaded?.run({}, {})).toBe("second");
  });

  test("rejects module paths outside the tools directory", async () => {
    const { configDir: dir } = await setupToolsDir();
    configDir = dir;

    expect(() => resolveJavascriptModulePath("../escape.js")).toThrow(
      /must stay inside/i
    );
  });

  test("returns an error tool when the module file is missing", async () => {
    const { configDir: dir } = await setupToolsDir();
    configDir = dir;

    const record: StoredToolRecord = {
      createdAt: new Date().toISOString(),
      description: "Missing module",
      handlerConfig: { modulePath: "missing.js" },
      handlerType: "javascript",
      id: "tool_missing",
      name: "missing",
      updatedAt: new Date().toISOString(),
    };

    const tool = await loadJavascriptTool(record);
    const result = await tool!.run({}, {});

    expect(result).toEqual({ error: "Tool module not found: missing.js" });
  });
});

describe("tool resolver", () => {
  let configDir = "";

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = originalConfigDir;
    }

    if (configDir) {
      await rm(configDir, { force: true, recursive: true });
      configDir = "";
    }
  });

  test("resolves javascript tools from storage", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;

    await writeFile(
      path.join(toolsDir, "adder.js"),
      `export async function run(input) {
  return { sum: Number(input.a) + Number(input.b) };
}
`,
      "utf8"
    );

    const { resolveToolsFromStorage } = await import("./tool-resolver");
    const tools = await resolveToolsFromStorage([
      {
        createdAt: new Date().toISOString(),
        description: "Add two numbers",
        handlerConfig: { modulePath: "adder.js" },
        handlerType: "javascript",
        id: "tool_adder",
        name: "adder",
        updatedAt: new Date().toISOString(),
      },
    ]);

    expect(tools).toHaveLength(1);
    expect(await tools[0]!.run({ a: 2, b: 3 }, {})).toEqual({ sum: 5 });
  });

  test("skips unsupported handler types", async () => {
    const { resolveToolsFromStorage } = await import("./tool-resolver");
    const tools = await resolveToolsFromStorage([
      {
        createdAt: new Date().toISOString(),
        description: "Unsupported tool",
        handlerConfig: {},
        handlerType: "custom",
        id: "tool_legacy_custom",
        name: "legacy-custom",
        updatedAt: new Date().toISOString(),
      },
    ]);

    expect(tools).toHaveLength(0);
  });
});
