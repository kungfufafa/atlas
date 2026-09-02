import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeToolCall } from "@atlas/agent";
import type { StoredToolRecord } from "@atlas/db";
import { spawnJsonTool } from "./custom-tool-subprocess";
import {
  invalidateJavascriptModuleCache,
  loadJavascriptTool,
  resolveJavascriptModulePath,
} from "./javascript-tool-loader";

const originalConfigDir = process.env.ATLAS_CONFIG_DIR;
const runnerPath = fileURLToPath(
  new URL("./javascript-tool-runner.js", import.meta.url)
);

async function runWithRequiredSandbox(
  options: Parameters<typeof spawnJsonTool>[0]
): Promise<unknown | null> {
  try {
    return await spawnJsonTool({ ...options, requireSandbox: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sandboxWasUnavailable =
      /sandbox_apply: Operation not permitted/i.test(message) ||
      /require Landlock ABI 3/i.test(message) ||
      /could not (?:create|restrict).*Landlock/i.test(message);
    if (!sandboxWasUnavailable) {
      throw error;
    }

    // Nested CI/container policies may prevent applying another OS sandbox.
    // The important behavior in that environment is to reject, never fall back.
    expect(message).toMatch(/sandbox|Landlock/i);
    return null;
  }
}

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

function makeRecord(
  overrides: Partial<StoredToolRecord> = {}
): StoredToolRecord {
  return {
    createdAt: new Date().toISOString(),
    description: "Custom JavaScript tool",
    handlerConfig: { modulePath: "echo.js" },
    handlerType: "javascript",
    id: "tool_javascript",
    name: "javascript_tool",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
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

  test("loads metadata and runs exported run(input) in a subprocess", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    const workspaceRoot = path.join(dir, "workspace");
    await mkdir(workspaceRoot);

    await writeFile(
      path.join(toolsDir, "echo.js"),
      `export const parameters = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
};

export async function run(input, context) {
  console.log("tool diagnostic");
  return {
    echoed: input.message,
    envRoot: process.env.ATLAS_WORKSPACE_ROOT,
    root: context.workspaceRoot,
  };
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

    const result = await tool!.run({ message: "hello" }, { workspaceRoot });
    expect(result).toEqual({
      echoed: "hello",
      envRoot: workspaceRoot,
      root: workspaceRoot,
    });
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
    const workspaceRoot = path.join(dir, "workspace");
    await mkdir(workspaceRoot);

    await writeFile(
      path.join(toolsDir, "flaky.js"),
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const retrySafe = true;
export async function run(_input, context) {
  const counterPath = path.join(context.workspaceRoot, "attempts.txt");
  const attempts = existsSync(counterPath)
    ? Number(readFileSync(counterPath, "utf8")) + 1
    : 1;
  writeFileSync(counterPath, String(attempts));
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
      { workspaceRoot }
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

    expect(result.errorCode).toBe("INTERNAL_ERROR");
    expect(result.error).toContain("side effect attempt 1");
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

  test("rejects a tool symlink that resolves outside the tools directory", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    const outsideModule = path.join(dir, "outside.js");
    await writeFile(
      outsideModule,
      "export async function run() { return 'outside'; }\n",
      "utf8"
    );
    await symlink(outsideModule, path.join(toolsDir, "escape.js"));

    const tool = await loadJavascriptTool(
      makeRecord({ handlerConfig: { modulePath: "escape.js" } })
    );
    expect(await tool!.run({}, {})).toEqual({
      error: expect.stringMatching(/must stay inside/i),
    });
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

  test("returns an error tool when the module lacks an exported run function", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    await writeFile(
      path.join(toolsDir, "no-run.js"),
      "export const value = 1;\n",
      "utf8"
    );

    const tool = await loadJavascriptTool(
      makeRecord({ handlerConfig: { modulePath: "no-run.js" } })
    );
    const result = (await tool!.run({}, {})) as { error: string };
    expect(result.error).toMatch(/export a run/i);
  });

  test("process.exit inside a tool does not affect the server process", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    await writeFile(
      path.join(toolsDir, "hostile-exit.js"),
      `export async function run() {
  process.exit(7);
}
`,
      "utf8"
    );

    const tool = await loadJavascriptTool(
      makeRecord({ handlerConfig: { modulePath: "hostile-exit.js" } })
    );
    const error = await tool!.run({}, {}).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/exit code 7/i);
    expect(process.pid).toBeGreaterThan(0);
  });

  test("runs with cwd scoped to the tool module directory", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    await writeFile(
      path.join(toolsDir, "cwd-probe.js"),
      `export async function run() {
  return { cwd: process.cwd() };
}
`,
      "utf8"
    );

    const tool = await loadJavascriptTool(
      makeRecord({ handlerConfig: { modulePath: "cwd-probe.js" } })
    );
    const result = (await tool!.run({}, {})) as { cwd: string };
    expect(realpathSync(result.cwd)).toBe(realpathSync(toolsDir));
  });

  test("does not inherit secret-shaped environment variables", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    await writeFile(
      path.join(toolsDir, "env-probe.js"),
      `export async function run() {
  return {
    configRoot: process.env.ATLAS_CONFIG_DIR ?? null,
    secret: process.env.ATLAS_TEST_CANARY_SECRET ?? null,
  };
}
`,
      "utf8"
    );

    process.env.ATLAS_TEST_CANARY_SECRET = "not-a-real-secret";
    try {
      const tool = await loadJavascriptTool(
        makeRecord({ handlerConfig: { modulePath: "env-probe.js" } })
      );
      expect(await tool!.run({}, {})).toEqual({
        configRoot: null,
        secret: null,
      });
    } finally {
      delete process.env.ATLAS_TEST_CANARY_SECRET;
    }
  });

  test("OS sandbox allows the profile workspace but blocks tenant config files", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    const workspaceRoot = path.join(dir, "workspace");
    const outsideSecret = path.join(dir, "tenant-secret.txt");
    const modulePath = path.join(toolsDir, "filesystem-probe.js");
    await mkdir(workspaceRoot);
    await writeFile(outsideSecret, "do-not-expose", "utf8");
    await writeFile(
      modulePath,
      `import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export async function run(input, context) {
  const allowedPath = path.join(context.workspaceRoot, "allowed.txt");
  writeFileSync(allowedPath, "workspace-ok", "utf8");
  let outsideError = null;
  try {
    readFileSync(input.outsideSecret, "utf8");
  } catch (error) {
    outsideError = error?.code ?? "UNKNOWN";
  }
  let procRootReadable = false;
  try {
    readFileSync(path.join("/proc/self/root", input.outsideSecret), "utf8");
    procRootReadable = true;
  } catch {
    // Expected: procfs magic links cannot bypass the underlying path rules.
  }
  return {
    configRoot: process.env.ATLAS_CONFIG_DIR ?? null,
    outsideError,
    procRootReadable,
    secretEnv: process.env.ATLAS_TEST_CANARY_SECRET ?? null,
    workspaceValue: readFileSync(allowedPath, "utf8"),
  };
}
`,
      "utf8"
    );

    process.env.ATLAS_TEST_CANARY_SECRET = "not-a-real-secret";
    try {
      const result = await runWithRequiredSandbox({
        bin: "bun",
        context: {},
        input: { outsideSecret },
        label: "JavaScript tool security probe",
        mode: "--run",
        modulePath,
        runnerPath,
        workspaceRoot,
      });
      if (result === null) {
        return;
      }
      expect(result).toEqual({
        configRoot: null,
        outsideError: expect.stringMatching(/EACCES|EPERM/),
        procRootReadable: false,
        secretEnv: null,
        workspaceValue: "workspace-ok",
      });
    } finally {
      delete process.env.ATLAS_TEST_CANARY_SECRET;
    }
  });

  test("inspection reads only a dedicated dependency tree and cannot write it", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    const moduleReadRoot = path.join(toolsDir, "isolated-tool");
    const modulePath = path.join(moduleReadRoot, "inspection-write-probe.js");
    const forbiddenPath = path.join(moduleReadRoot, "inspection-created.txt");
    const otherTenantModule = path.join(toolsDir, "other-tenant.js");
    await mkdir(moduleReadRoot);
    await writeFile(
      path.join(moduleReadRoot, "helper.js"),
      'export const marker = "helper-import-ok";\n',
      "utf8"
    );
    await writeFile(otherTenantModule, 'export const secret = "nope";\n');
    await writeFile(
      modulePath,
      `import { readFileSync, writeFileSync } from "node:fs";
import { marker } from "./helper.js";

let otherTenantReadable = false;
try {
  readFileSync(new URL("../other-tenant.js", import.meta.url), "utf8");
  otherTenantReadable = true;
} catch {
  // Expected: a dedicated tool directory cannot read a sibling tool.
}

try {
  writeFileSync(new URL("./inspection-created.txt", import.meta.url), "bad");
} catch {
  // Expected: inspection has read-only access to its dependency tree.
}

export const parameters = { marker, otherTenantReadable, type: "object" };
export async function run() { return "ok"; }
`,
      "utf8"
    );

    const result = await runWithRequiredSandbox({
      bin: "bun",
      context: {},
      input: {},
      label: "JavaScript tool inspection security probe",
      mode: "--inspect",
      modulePath,
      moduleReadRoot,
      runnerPath,
    });
    if (result === null) {
      return;
    }
    expect(result).toEqual({
      parallelSafe: false,
      parameters: {
        marker: "helper-import-ok",
        otherTenantReadable: false,
        type: "object",
      },
      retrySafe: false,
    });
    expect(await Bun.file(forbiddenPath).exists()).toBe(false);
  });

  test("terminates a custom tool after its execution budget", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    await writeFile(
      path.join(toolsDir, "stubborn.js"),
      `export async function run() {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
`,
      "utf8"
    );

    const tool = await loadJavascriptTool(
      makeRecord({ handlerConfig: { modulePath: "stubborn.js" } })
    );
    process.env.ATLAS_CUSTOM_TOOL_TIMEOUT_MS = "200";
    try {
      const error = await tool!.run({}, {}).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out/i);
    } finally {
      delete process.env.ATLAS_CUSTOM_TOOL_TIMEOUT_MS;
    }
  });

  test("parallel calls do not share JavaScript module state", async () => {
    const { configDir: dir, toolsDir } = await setupToolsDir();
    configDir = dir;
    await writeFile(
      path.join(toolsDir, "counter.js"),
      `export const parallelSafe = true;
let count = 0;
export async function run() {
  count += 1;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { count };
}
`,
      "utf8"
    );

    const tool = await loadJavascriptTool(
      makeRecord({ handlerConfig: { modulePath: "counter.js" } })
    );
    const [first, second] = await Promise.all([
      tool!.run({}, {}) as Promise<{ count: number }>,
      tool!.run({}, {}) as Promise<{ count: number }>,
    ]);

    expect(tool?.parallelSafe).toBe(true);
    expect(first.count).toBe(1);
    expect(second.count).toBe(1);
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
