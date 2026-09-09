import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  getProfileSoulDir,
  getUserConfigDir,
  guardFilePath,
  inferArtifactMimeType,
  jsonSchemaFromZod,
  nanoid,
  parseToolInput,
  requiredTrimmedString,
  type ToolArtifact,
  type ToolContext,
  type ToolDefinition,
  withProtectedProfileSkillTree,
} from "@atlas/core";
import { z } from "zod";
import {
  createProcessToolPreparer,
  type ProcessToolAdmissionPolicy,
  type ProcessToolPreparer,
} from "../services/process-tool-admission";
import { resolvePythonReadRoots } from "../services/python-runtime-roots";
import { prepareRestrictedProcess } from "../services/restricted-process";
import { boundedPythonText, createPythonOutputCapture } from "./python-output";

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

export function resolvePythonRuntime(): string {
  const configured = process.env.ATLAS_PYTHON_PATH?.trim();
  if (configured) {
    if (!(path.isAbsolute(configured) && existsSync(configured))) {
      throw new Error(
        "ATLAS_PYTHON_PATH must name an existing absolute Python executable. Run scripts/setup-file-runtime.sh on the Atlas host."
      );
    }
    return configured;
  }
  const managed = path.join(
    getUserConfigDir(),
    "runtime",
    "python",
    "bin",
    "python3"
  );
  return existsSync(managed) ? managed : "python3";
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
  return runPythonWithPreparer(input, context, prepareRestrictedProcess);
}

/** Capture trusted host admission once; model input cannot replace it. */
export function createPythonExecutor(
  policy: ProcessToolAdmissionPolicy
): typeof runPythonExecute {
  const prepareProcess = createProcessToolPreparer(policy);
  return (input, context) =>
    runPythonWithPreparer(input, context, prepareProcess);
}

async function runPythonWithPreparer(
  input: unknown,
  context: ToolContext,
  prepareProcess: ProcessToolPreparer
): Promise<PythonExecuteOutput> {
  const startTime = Date.now();
  const parsed = parseToolInput(pythonExecuteInputSchema, input);
  const pythonRuntime = resolvePythonRuntime();
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

  const runtime = await resolvePythonReadRoots(pythonRuntime);
  const prepared = await prepareProcess({
    args: ["-I", "-u", "-c", parsed.code],
    bin: runtime.bin,
    readRoots: runtime.readRoots,
    workspaceRoot,
  });
  try {
    return await withProtectedProfileSkillTree(
      context,
      workspaceRoot,
      () =>
        new Promise<PythonExecuteOutput>((resolve, reject) => {
          if (context.signal?.aborted) {
            return reject(
              new Error("Execution cancelled before starting Python process.")
            );
          }

          const child = spawn(prepared.bin, prepared.args, {
            cwd: prepared.cwd,
            detached: process.platform !== "win32",
            env: prepared.env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.stdin.end();

          const stdoutCapture = createPythonOutputCapture();
          const stderrCapture = createPythonOutputCapture();
          child.stdout.on("data", (chunk: Buffer) =>
            stdoutCapture.append(chunk)
          );
          child.stderr.on("data", (chunk: Buffer) =>
            stderrCapture.append(chunk)
          );

          let timedOut = false;
          let cancelled = false;
          let forceKill: ReturnType<typeof setTimeout> | undefined;
          const stopTree = (signal: NodeJS.Signals) => {
            if (process.platform !== "win32" && child.pid) {
              try {
                process.kill(-child.pid, signal);
                return;
              } catch {
                // The group may already have exited. Fall back to the child handle.
              }
            }
            child.kill(signal);
          };

          const timer = setTimeout(() => {
            timedOut = true;
            stopTree("SIGKILL");
          }, parsed.timeout);

          const onAbort = () => {
            cancelled = true;
            clearTimeout(timer);
            stopTree("SIGTERM");
            forceKill = setTimeout(() => {
              stopTree("SIGKILL");
            }, 500);
          };

          context.signal?.addEventListener("abort", onAbort, { once: true });

          child.on("error", (err: Error) => {
            clearTimeout(timer);
            clearTimeout(forceKill);
            if (context.signal?.removeEventListener) {
              context.signal.removeEventListener("abort", onAbort);
            }
            reject(new Error(`Failed to spawn Python process: ${err.message}`));
          });

          child.on("close", async (code) => {
            clearTimeout(timer);
            // Background descendants must not mutate a later turn's workspace
            // after this tool has emitted its completion receipt.
            stopTree("SIGKILL");
            clearTimeout(forceKill);
            if (context.signal?.removeEventListener) {
              context.signal.removeEventListener("abort", onAbort);
            }

            if (cancelled) {
              return reject(
                new Error("Python execution was cancelled by the user.")
              );
            }

            const exitCode = timedOut ? -1 : (code ?? -1);
            const success = !timedOut && exitCode === 0;

            const stdout = stdoutCapture.read();
            const stderr = stderrCapture.read();
            const finalStderr = boundedPythonText(
              timedOut
                ? `Execution timed out after ${parsed.timeout}ms.\n${stderr.text}`
                : stderr.text
            );

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
                  const fileStat = await stat(
                    path.join(workspaceRoot, relPath)
                  );
                  const mime = inferArtifactMimeType(relPath);
                  const name = path.basename(relPath);
                  generated.push({
                    mimeType: mime,
                    name,
                    path: relPath,
                    size: fileStat.size,
                  });
                  const publicPath = relPath.split(path.sep).join("/");
                  if (
                    success &&
                    publicPath.startsWith("artifacts/") &&
                    !publicPath
                      .split("/")
                      .some((segment) => segment.startsWith(".")) &&
                    !name.endsWith(".atlas-meta.json")
                  ) {
                    standardArtifacts.push({
                      createdAt: new Date().toISOString(),
                      filename: name,
                      id: nanoid(12),
                      mimeType: mime,
                      path: relPath,
                      sessionId: context.sessionId,
                      sizeBytes: fileStat.size,
                    });
                  }
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
                truncated:
                  stdout.truncated || stderr.truncated || finalStderr.truncated,
              },
              stderr: finalStderr.text.trim(),
              stdout: stdout.text.trim(),
              success,
            });
          });
        })
    );
  } finally {
    await prepared.cleanup();
  }
}

export const pythonExecuteTool: ToolDefinition<
  PythonExecuteInput,
  PythonExecuteOutput
> = {
  description:
    "Execute Python with required OS filesystem isolation in the active profile workspace using Atlas's configured runtime (ATLAS_PYTHON_PATH), managed file runtime, or installed python3. Use for data transformations and generating files. Inspect installed modules before relying on them; Docker bundles pandas, openpyxl, python-docx, python-pptx, pypdf, reportlab. Save deliverables under artifacts/. stdout, stderr and generated files are captured. Host home and other profiles are inaccessible; execution fails if the sandbox is unavailable.",
  name: "python_execute",
  parameters: jsonSchemaFromZod(pythonExecuteInputSchema),
  run(input, context) {
    return runPythonExecute(input, context);
  },
};
