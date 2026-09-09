import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { HarnessTask, HarnessToolEvent } from "./types";

const numericToken = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const whitespace = /^\s+/;

/** Small arithmetic parser: no executable JavaScript or property access. */
export function calculate(expression: string): number {
  if (expression.length > 2000) {
    throw new Error("Expression exceeds 2000 characters.");
  }
  let position = 0;
  let depth = 0;
  const skip = () => {
    position += expression.slice(position).match(whitespace)?.[0].length ?? 0;
  };
  const primary = (): number => {
    skip();
    if (++depth > 50) {
      throw new Error("Expression nesting limit exceeded.");
    }
    let value: number;
    const next = expression[position];
    if (next === "+" || next === "-") {
      position++;
      value = primary() * (next === "-" ? -1 : 1);
    } else if (next === "(") {
      position++;
      value = sum();
      skip();
      if (expression[position++] !== ")") {
        throw new Error("Missing closing parenthesis.");
      }
    } else {
      const token = expression.slice(position).match(numericToken)?.[0];
      if (!token) {
        throw new Error("Expected a number or parenthesized expression.");
      }
      position += token.length;
      value = Number(token);
    }
    depth--;
    return value;
  };
  const product = (): number => {
    let value = primary();
    skip();
    while (["*", "/", "%"].includes(expression[position] ?? "")) {
      const operator = expression[position++];
      const right = primary();
      if (operator === "*") {
        value *= right;
      } else if (operator === "/") {
        value /= right;
      } else {
        value %= right;
      }
      skip();
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    skip();
    while (["+", "-"].includes(expression[position] ?? "")) {
      const operator = expression[position++];
      const right = product();
      value += operator === "+" ? right : -right;
      skip();
    }
    return value;
  };
  const result = sum();
  skip();
  if (position !== expression.length || !Number.isFinite(result)) {
    throw new Error("Invalid or non-finite arithmetic result.");
  }
  return result;
}

function schema(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
) {
  return {
    function: {
      description,
      name,
      parameters: {
        additionalProperties: false,
        properties,
        required,
        type: "object",
      },
    },
    type: "function",
  };
}

const pathProperty = {
  description: "Path relative to this task's workspace.",
  type: "string",
};
export const toolSchemas = [
  schema(
    "read_file",
    "Read a UTF-8 file in this task workspace. Return its exact content or a structured error.",
    { path: pathProperty },
    ["path"]
  ),
  schema(
    "write_file",
    "Write exact UTF-8 content to a task workspace file, creating parent directories. Overwrites an existing file.",
    { content: { type: "string" }, path: pathProperty },
    ["path", "content"]
  ),
  schema(
    "list_files",
    "List all file paths beneath a task workspace directory. Omit path to list the whole workspace.",
    { path: pathProperty },
    []
  ),
  schema(
    "calculate",
    "Compute finite arithmetic using decimal numbers, parentheses and + - * / % operators.",
    { expression: { type: "string" } },
    ["expression"]
  ),
  schema(
    "fetch_document",
    "Retrieve an identified source document from this task's bounded research collection; includes source URL and content. This does not search the live web.",
    { id: { type: "string" } },
    ["id"]
  ),
];

async function workspacePath(root: string, input: string): Promise<string> {
  if (isAbsolute(input) || input.includes("\0")) {
    throw new Error("Only workspace-relative paths are allowed.");
  }
  const target = resolve(root, input);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith("../")) {
    throw new Error("Path leaves task workspace.");
  }
  let current = root;
  for (const segment of ["", ...fromRoot.split("/").filter(Boolean)]) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(
          "Symlinks are not permitted in the synthetic workspace."
        );
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        break;
      }
      throw error;
    }
  }
  return target;
}

export async function snapshotFiles(
  root: string
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Unexpected symlink in synthetic workspace.");
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files[relative(root, path)] = await readFile(path, "utf8");
      }
    }
  };
  await visit(root);
  return files;
}

export async function initializeFiles(
  root: string,
  files: Record<string, string>
): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const destination = await workspacePath(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

function stringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Argument ${key} must be a string.`);
  }
  return value;
}

export async function executeSharedTool(
  root: string,
  task: Pick<HarnessTask, "documents">,
  name: string,
  args: Record<string, unknown>
): Promise<HarnessToolEvent> {
  const event: HarnessToolEvent = { arguments: args, name };
  try {
    const declaration = toolSchemas.find(
      (entry) => entry.function.name === name
    );
    if (!declaration) {
      throw new Error("Unknown shared tool.");
    }
    if (
      Object.keys(args).some(
        (key) => !Object.hasOwn(declaration.function.parameters.properties, key)
      )
    ) {
      throw new Error("Unexpected tool argument.");
    }
    switch (name) {
      case "read_file": {
        const path = stringArgument(args, "path");
        event.result = {
          content: await readFile(await workspacePath(root, path), "utf8"),
          path,
        };
        break;
      }
      case "write_file": {
        const path = stringArgument(args, "path");
        const content = stringArgument(args, "content");
        if (Buffer.byteLength(content) > 1_000_000) {
          throw new Error("Output exceeds 1 MB task limit.");
        }
        const target = await workspacePath(root, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        event.result = { bytes: Buffer.byteLength(content), path };
        break;
      }
      case "list_files": {
        const path =
          args.path === undefined ? "" : stringArgument(args, "path");
        const target = await workspacePath(root, path);
        const files = await snapshotFiles(target);
        event.result = {
          files: Object.keys(files)
            .map((file) => relative(root, resolve(target, file)))
            .sort(),
        };
        break;
      }
      case "calculate":
        event.result = { value: calculate(stringArgument(args, "expression")) };
        break;
      case "fetch_document": {
        const id = stringArgument(args, "id");
        const document =
          task.documents && Object.hasOwn(task.documents, id)
            ? task.documents[id]
            : undefined;
        if (!document) {
          throw new Error("Document ID not found in this task collection.");
        }
        event.result = { id, ...document };
        break;
      }
      default:
        throw new Error("Unknown shared tool.");
    }
  } catch (error) {
    event.isError = true;
    const message = error instanceof Error ? error.message : "Tool failed.";
    event.result = {
      error: {
        code: "tool_error",
        message: message.replaceAll(root, "<workspace>"),
      },
      success: false,
    };
  }
  return event;
}
