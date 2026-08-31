import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { spawnJsonTool } from "./custom-tool-subprocess";

const BUN_BIN = process.env.ATLAS_BUN_BIN ?? "bun";
const RUNNER_PATH = fileURLToPath(
  new URL("./javascript-tool-runner.js", import.meta.url)
);
const moduleMetadataCache = new Map<string, JavascriptToolMetadata>();

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

interface JavascriptToolMetadata {
  parallelSafe?: boolean;
  parameters?: JsonSchema;
  retrySafe?: boolean;
}

interface CanonicalJavascriptModule {
  modulePath: string;
  moduleReadRoot?: string;
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
    return createErrorTool(record, errorMessage(error));
  }

  if (!(await pathExists(modulePath))) {
    return createErrorTool(
      record,
      `Tool module not found: ${config.modulePath}`
    );
  }

  try {
    const canonicalModule = await canonicalizeJavascriptModulePath(modulePath);
    modulePath = canonicalModule.modulePath;
    // Inspection also happens in a child: importing an untrusted module must
    // never execute top-level code in the Atlas server process.
    const metadata = await inspectJavascriptModule(
      modulePath,
      canonicalModule.moduleReadRoot
    );
    const parameters =
      metadata.parameters ?? config.parameters ?? permissiveObjectSchema();

    return {
      description: record.description,
      name: record.name,
      parameters,
      ...(metadata.parallelSafe ? { parallelSafe: true } : {}),
      retryPolicy: metadata.retrySafe
        ? JAVASCRIPT_TOOL_RETRY_POLICY
        : { maxRetries: 0 },
      async run(input, context) {
        return runJavascriptTool(
          modulePath,
          canonicalModule.moduleReadRoot,
          input,
          context
        );
      },
    };
  } catch (error) {
    return createErrorTool(record, errorMessage(error));
  }
}

export async function validateJavascriptToolModule(
  modulePath: string
): Promise<void> {
  const resolvedPath = resolveJavascriptModulePath(modulePath);
  if (!(await pathExists(resolvedPath))) {
    throw new Error(`Tool module not found: ${modulePath}`);
  }

  const canonicalModule = await canonicalizeJavascriptModulePath(resolvedPath);
  invalidateJavascriptModuleCache(canonicalModule.modulePath);
  await inspectJavascriptModule(
    canonicalModule.modulePath,
    canonicalModule.moduleReadRoot
  );
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

export function invalidateJavascriptModuleCache(modulePath: string): void {
  moduleMetadataCache.delete(modulePath);
  try {
    moduleMetadataCache.delete(realpathSync(modulePath));
  } catch {
    // A deleted module cannot have a second canonical cache key.
  }
}

async function inspectJavascriptModule(
  modulePath: string,
  moduleReadRoot?: string
): Promise<JavascriptToolMetadata> {
  const cached = moduleMetadataCache.get(modulePath);
  if (cached) {
    return cached;
  }

  const inspected = await spawnJsonTool({
    bin: BUN_BIN,
    context: {},
    input: {},
    label: "JavaScript tool inspection",
    mode: "--inspect",
    modulePath,
    moduleReadRoot,
    runnerPath: RUNNER_PATH,
  });
  const metadata = normalizeJavascriptToolMetadata(inspected);
  moduleMetadataCache.set(modulePath, metadata);
  return metadata;
}

async function runJavascriptTool(
  modulePath: string,
  moduleReadRoot: string | undefined,
  input: unknown,
  context: ToolContext
): Promise<unknown> {
  return spawnJsonTool({
    bin: BUN_BIN,
    context,
    input,
    label: "JavaScript tool",
    mode: "--run",
    modulePath,
    moduleReadRoot,
    runnerPath: RUNNER_PATH,
    workspaceRoot: readOptionalString(context.workspaceRoot),
  });
}

async function canonicalizeJavascriptModulePath(
  modulePath: string
): Promise<CanonicalJavascriptModule> {
  const [toolsDir, canonicalModulePath] = await Promise.all([
    realpath(getCustomToolsDir()),
    realpath(modulePath),
  ]);
  if (!isPathInsideDirectory(canonicalModulePath, toolsDir)) {
    throw new Error(`Tool module path must stay inside ${toolsDir}.`);
  }
  const moduleDirectory = path.dirname(canonicalModulePath);
  return {
    modulePath: canonicalModulePath,
    // Flat modules remain single-file so one tenant's tool cannot read every
    // other flat module. A dedicated subdirectory is its read-only dependency
    // boundary and can safely contain relative imports/supporting files.
    ...(moduleDirectory === toolsDir
      ? {}
      : { moduleReadRoot: moduleDirectory }),
  };
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

function normalizeJavascriptToolMetadata(
  value: unknown
): JavascriptToolMetadata {
  if (typeof value !== "object" || value === null) {
    throw new Error("Tool module inspection returned invalid metadata.");
  }

  const record = value as Record<string, unknown>;
  return {
    ...(record.parallelSafe === true ? { parallelSafe: true } : {}),
    ...(isJsonSchema(record.parameters)
      ? { parameters: record.parameters }
      : {}),
    ...(record.retrySafe === true ? { retrySafe: true } : {}),
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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
