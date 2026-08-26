import { randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  JsonSchema,
  RetryPolicy,
  ToolContext,
  ToolDefinition,
} from "@atlas/core";
import {
  getCustomToolsDir,
  pathExists,
  permissiveObjectSchema,
} from "@atlas/core";
import type { StoredToolRecord } from "@atlas/db";

const moduleCache = new Map<string, JavascriptToolModule>();
const moduleRevisions = new Map<string, number>();

const JAVASCRIPT_TOOL_RETRY_POLICY: RetryPolicy = {
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
};

export interface JavascriptToolHandlerConfig {
  modulePath: string;
  parameters?: JsonSchema;
}

interface JavascriptToolModule {
  parallelSafe?: boolean;
  parameters?: JsonSchema;
  retrySafe?: boolean;
  run: (input: unknown, context: ToolContext) => Promise<unknown>;
}

export async function loadJavascriptTool(
  record: StoredToolRecord
): Promise<ToolDefinition | null> {
  const config = readJavascriptHandlerConfig(record.handlerConfig);

  if (!config?.modulePath) {
    return createErrorTool(
      record,
      `Tool "${record.name}" is missing handlerConfig.modulePath.`
    );
  }

  let modulePath: string;

  try {
    modulePath = resolveJavascriptModulePath(config.modulePath);
  } catch (error) {
    return createErrorTool(
      record,
      error instanceof Error ? error.message : String(error)
    );
  }

  if (!(await pathExists(modulePath))) {
    return createErrorTool(
      record,
      `Tool module not found: ${config.modulePath}`
    );
  }

  try {
    const module = await importJavascriptModule(modulePath);
    const parameters =
      module.parameters ?? config.parameters ?? permissiveObjectSchema();

    return {
      description: record.description,
      name: record.name,
      parameters,
      ...(module.parallelSafe ? { parallelSafe: true } : {}),
      retryPolicy: module.retrySafe
        ? JAVASCRIPT_TOOL_RETRY_POLICY
        : { maxRetries: 0 },
      async run(input, context) {
        return module.run(input, context);
      },
    };
  } catch (error) {
    return createErrorTool(
      record,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function validateJavascriptToolModule(
  modulePath: string
): Promise<void> {
  const resolvedPath = resolveJavascriptModulePath(modulePath);

  if (!(await pathExists(resolvedPath))) {
    throw new Error(`Tool module not found: ${modulePath}`);
  }

  invalidateJavascriptModuleCache(resolvedPath);
  await importJavascriptModule(resolvedPath);
}

export function resolveJavascriptModulePath(modulePath: string): string {
  const toolsDir = path.resolve(getCustomToolsDir());
  const resolved = path.isAbsolute(modulePath)
    ? path.resolve(modulePath)
    : path.resolve(toolsDir, modulePath);

  if (!isPathInsideDirectory(resolved, toolsDir)) {
    throw new Error(`Tool module path must stay inside ${toolsDir}.`);
  }

  return resolved;
}

function readJavascriptHandlerConfig(
  handlerConfig: unknown
): JavascriptToolHandlerConfig | null {
  if (typeof handlerConfig !== "object" || handlerConfig === null) {
    return null;
  }

  const record = handlerConfig as Record<string, unknown>;
  const modulePath =
    typeof record.modulePath === "string" && record.modulePath.trim()
      ? record.modulePath.trim()
      : null;

  if (!modulePath) {
    return null;
  }

  const parameters = isJsonSchema(record.parameters)
    ? record.parameters
    : undefined;

  return { modulePath, parameters };
}

async function importJavascriptModule(
  modulePath: string
): Promise<JavascriptToolModule> {
  const cached = moduleCache.get(modulePath);

  if (cached) {
    return cached;
  }

  const revision = moduleRevisions.get(modulePath) ?? 0;
  const importPath =
    revision === 0 ? modulePath : await createReloadableModuleCopy(modulePath);
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(importPath).href);
  } finally {
    if (importPath !== modulePath) {
      await rm(importPath, { force: true });
    }
  }
  const module = normalizeJavascriptModule(imported);

  moduleCache.set(modulePath, module);
  return module;
}

async function createReloadableModuleCopy(modulePath: string): Promise<string> {
  const parsed = path.parse(modulePath);
  const reloadPath = path.join(
    parsed.dir,
    `.${parsed.name}.atlas-reload-${randomUUID()}${parsed.ext || ".js"}`
  );
  await copyFile(modulePath, reloadPath);
  return reloadPath;
}

export function invalidateJavascriptModuleCache(modulePath: string): void {
  moduleCache.delete(modulePath);
  moduleRevisions.set(modulePath, (moduleRevisions.get(modulePath) ?? 0) + 1);
}

function normalizeJavascriptModule(imported: unknown): JavascriptToolModule {
  if (typeof imported !== "object" || imported === null) {
    throw new Error("Tool module must export a run function.");
  }

  const record = imported as Record<string, unknown>;
  const defaultExport =
    typeof record.default === "object" && record.default !== null
      ? (record.default as Record<string, unknown>)
      : null;
  const source = defaultExport ?? record;
  const run = source.run;

  if (typeof run !== "function") {
    throw new Error("Tool module must export a run function.");
  }

  const parameters = isJsonSchema(source.parameters)
    ? source.parameters
    : isJsonSchema(record.parameters)
      ? record.parameters
      : undefined;
  const parallelSafe =
    source.parallelSafe === true || record.parallelSafe === true;
  const retrySafe = source.retrySafe === true || record.retrySafe === true;

  return {
    parameters,
    ...(parallelSafe ? { parallelSafe: true } : {}),
    ...(retrySafe ? { retrySafe: true } : {}),
    run: (input, context) => Promise.resolve(run(input, context)),
  };
}

function createErrorTool(
  record: StoredToolRecord,
  message: string
): ToolDefinition {
  return {
    description: record.description,
    name: record.name,
    parameters: permissiveObjectSchema(),
    async run() {
      return { error: message };
    },
  };
}

function isPathInsideDirectory(
  targetPath: string,
  directoryPath: string
): boolean {
  const relative = path.relative(directoryPath, targetPath);

  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null;
}
