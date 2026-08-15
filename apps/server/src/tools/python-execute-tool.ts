import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  getProfileSoulDir,
  guardFilePath,
  jsonSchemaFromZod,
  nanoid,
  parseToolInput,
  requiredTrimmedString,
  type ToolArtifact,
  type ToolContext,
  type ToolDefinition,
} from "@atlas/core";
import { z } from "zod";

export const pythonExecuteInputSchema = z
  .object({
    code: requiredTrimmedString("code"),
    files: z.array(z.string()).optional().default([]),
    timeout: z
      .number()
      .int()
      .min(1000, "timeout must be at least 1000ms")
      .max(120_000, "timeout cannot exceed 120000ms")
      .optional()
      .default(30_000),
  })
  .strict();

export type PythonExecuteInput = z.infer<typeof pythonExecuteInputSchema>;

export interface GeneratedArtifact {
  mimeType: string;
  name: string;
  path: string;
  size: number;
}

export interface PythonExecuteOutput {
  artifacts: ToolArtifact[];
  artifactsGenerated: GeneratedArtifact[];
  exitCode: number;
  metadata?: {
    durationMs: number;
    truncated: boolean;
  };
  stderr: string;
  stdout: string;
  success: boolean;
}

const SENSITIVE_ENV_KEYS = [
  "ATLAS_",
  "DATABASE_",
  "DB_",
  "COOKIE_",
  "SESSION_",
  "API_KEY",
  "SECRET",
  "PASSWORD",
  "TOKEN",
  "AUTH",
  "PRIVATE",
  "OPENAI",
  "ANTHROPIC",
  "GEMINI",
  "FIREWORKS",
  "CEREBRAS",
  "OPENROUTER",
  "COMPOSIO",
  "AWS_",
  "AZURE_",
  "GCP_",
];

function buildSanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: process.env.PATH,
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
    TERM: "xterm-256color",
    TMPDIR: process.env.TMPDIR,
  };

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) {
      continue;
    }
    const isSensitive = SENSITIVE_ENV_KEYS.some((pattern) =>
      key.toUpperCase().includes(pattern)
    );
    if (!isSensitive) {
      env[key] = value;
    }
  }

  return env;
}

function detectArtifactMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pdf":
      return "application/pdf";
    case ".html":
      return "text/html";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

async function scanWorkspaceArtifacts(
  dir: string,
  baseDir: string
): Promise<Map<string, number>> {
  const fileMap = new Map<string, number>();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subMap = await scanWorkspaceArtifacts(fullPath, baseDir);
        for (const [p, mtime] of subMap) {
          fileMap.set(p, mtime);
        }
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        fileMap.set(path.relative(baseDir, fullPath), fileStat.mtimeMs);
      }
    }
  } catch {
    // Directory might not exist yet
  }
  return fileMap;
}

export async function runPythonExecute(
  input: unknown,
  context: ToolContext
): Promise<PythonExecuteOutput> {
  const startTime = Date.now();
  const parsed = parseToolInput(pythonExecuteInputSchema, input);
  const orgId = context.orgId?.trim();
  const profileId = context.profileId?.trim();

  if (!(orgId && profileId)) {
    throw new Error("orgId and profileId are required.");
  }

  const workspaceRoot =
    context.workspaceRoot ?? getProfileSoulDir(orgId, profileId);

  // Validate any provided input files
  if (parsed.files && parsed.files.length > 0) {
    for (const relFile of parsed.files) {
      await guardFilePath(relFile, workspaceRoot, undefined, {
        allowedDirs: [workspaceRoot],
        cwd: workspaceRoot,
      });
    }
  }

  const beforeScan = await scanWorkspaceArtifacts(workspaceRoot, workspaceRoot);

  return new Promise<PythonExecuteOutput>((resolve, reject) => {
    if (context.signal?.aborted) {
      return reject(
        new Error("Execution cancelled before starting Python process.")
      );
    }

    const child = spawn("python3", ["-c", parsed.code], {
      cwd: workspaceRoot,
      env: buildSanitizedEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutData = "";
    let stderrData = "";
    let truncated = false;
    const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutData.length < MAX_OUTPUT_BYTES) {
        stdoutData += chunk.toString("utf8");
      } else {
        truncated = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrData.length < MAX_OUTPUT_BYTES) {
        stderrData += chunk.toString("utf8");
      } else {
        truncated = true;
      }
    });

    let timedOut = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, parsed.timeout);

    const onAbort = () => {
      cancelled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 500);
    };

    context.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (context.signal?.removeEventListener) {
        context.signal.removeEventListener("abort", onAbort);
      }
      reject(new Error(`Failed to spawn Python process: ${err.message}`));
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      if (context.signal?.removeEventListener) {
        context.signal.removeEventListener("abort", onAbort);
      }

      if (cancelled) {
        return reject(new Error("Python execution was cancelled by the user."));
      }

      const exitCode = timedOut ? -1 : (code ?? 0);
      const success = !timedOut && exitCode === 0;

      let finalStderr = stderrData;
      if (timedOut) {
        finalStderr += `\nExecution timed out after ${parsed.timeout}ms.`;
      }

      const afterScan = await scanWorkspaceArtifacts(
        workspaceRoot,
        workspaceRoot
      );
      const generated: GeneratedArtifact[] = [];
      const standardArtifacts: ToolArtifact[] = [];

      for (const [relPath, mtime] of afterScan) {
        const prevMtime = beforeScan.get(relPath);
        if (prevMtime === undefined || mtime > prevMtime) {
          try {
            const fileStat = await stat(path.join(workspaceRoot, relPath));
            const mime = detectArtifactMimeType(relPath);
            const name = path.basename(relPath);
            generated.push({
              mimeType: mime,
              name,
              path: relPath,
              size: fileStat.size,
            });
            standardArtifacts.push({
              createdAt: new Date().toISOString(),
              filename: name,
              id: nanoid(12),
              mimeType: mime,
              path: relPath,
              sessionId: context.sessionId,
              sizeBytes: fileStat.size,
            });
          } catch {
            // file might have been transient
          }
        }
      }

      resolve({
        artifacts: standardArtifacts,
        artifactsGenerated: generated,
        exitCode,
        metadata: {
          durationMs: Date.now() - startTime,
          truncated,
        },
        stderr: finalStderr.trim(),
        stdout: stdoutData.trim(),
        success,
      });
    });
  });
}

export const pythonExecuteTool: ToolDefinition<
  PythonExecuteInput,
  PythonExecuteOutput
> = {
  description:
    "Execute Python code in an isolated workspace analysis sandbox. Useful for data analysis, CSV/Excel computation, statistics, data transformations, and generating artifacts/charts. stdout, stderr, and any newly generated files are captured.",
  name: "python_execute",
  parameters: jsonSchemaFromZod(pythonExecuteInputSchema),
  run(input, context) {
    return runPythonExecute(input, context);
  },
};
