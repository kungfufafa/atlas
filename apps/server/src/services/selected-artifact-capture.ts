import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { resolvePythonRuntime } from "../tools/python-execute-tool";
import { resolveRestrictedExecutable } from "./restricted-process";
import { SELECTED_ARTIFACT_CAPTURE_SCRIPT } from "./selected-artifact-capture-worker";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_STDOUT = Math.ceil(MAX_BYTES / 3) * 4 + 65_536;
const MAX_STDERR = 8192;
const MAX_ACTIVE = 2;
const INVALID_BASE64 = /[^A-Za-z0-9+/]/;
const BASE64_PADDING = /[=]{1,2}$/;
const DIGITS = /^\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
let active = 0;

const rootIdentity = z
  .object({ device: z.string().regex(DIGITS), inode: z.string().regex(DIGITS) })
  .strict();
const evidenceSchema = z
  .object({
    file: rootIdentity
      .extend({
        ctimeNs: z.string().regex(/^-?\d+$/),
        linkCount: z.literal(1),
        mtimeNs: z.string().regex(/^-?\d+$/),
        sizeBytes: z.number().int().min(0).max(MAX_BYTES),
      })
      .strict(),
    kind: z.literal("selected_workspace_capture"),
    observedMetadataStable: z.literal(true),
    reader: z.literal("posix_dirfd_nofollow"),
    rootIdentity,
    sha256: z.string().regex(SHA256),
    sizeBytes: z.number().int().min(0).max(MAX_BYTES),
    sourcePath: z.string(),
    version: z.literal(1),
  })
  .strict();

/** Captured existing bytes, never a claim that a tool/session generated the file. */
export type SelectedArtifactCaptureEvidence = z.infer<typeof evidenceSchema>;
export interface SelectedArtifactCapture {
  /** Explicit selection only. This capability is server-only and never enters ToolContext/tool JSON. */
  capture(
    sourcePath: string,
    signal?: AbortSignal
  ): Promise<{
    bytes: Buffer;
    evidence: SelectedArtifactCaptureEvidence;
  }>;
}

function selectedPath(sourcePath: string): void {
  const parts = sourcePath.split("/");
  if (
    sourcePath.length > 4096 ||
    parts.length < 2 ||
    parts.length > 64 ||
    parts[0] !== "artifacts" ||
    parts.some(
      (part) =>
        !part ||
        part.startsWith(".") ||
        part.includes("\\") ||
        CONTROL.test(part)
    ) ||
    parts.at(-1)!.toLowerCase().endsWith(".atlas-meta.json")
  ) {
    throw new Error("Select a canonical visible artifacts/ file.");
  }
}

async function worker(input: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      "Selected artifact capture requires supported POSIX directory descriptor operations."
    );
  }
  if (active >= MAX_ACTIVE) {
    throw new Error("Selected artifact capture capacity is busy.");
  }
  const request = JSON.stringify(input);
  if (Buffer.byteLength(request) > 16_384) {
    throw new Error("Selected artifact capture request exceeds its bound.");
  }
  active += 1;
  try {
    const runtime = await resolveRestrictedExecutable(resolvePythonRuntime());
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn(
        runtime,
        ["-I", "-S", "-u", "-c", SELECTED_ARTIFACT_CAPTURE_SCRIPT],
        {
          cwd: "/",
          env: { LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
      let failure: Error | undefined;
      const output: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const abort = () =>
        stop(new Error("Selected artifact capture cancelled."));
      const timer = setTimeout(
        () =>
          stop(new Error("Selected artifact capture exceeded its deadline.")),
        10_000
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT) {
          stop(
            new Error("Selected artifact capture response exceeds its bound.")
          );
        } else if (!failure) {
          output.push(chunk);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR) {
          stop(
            new Error(
              "Selected artifact capture diagnostics exceed their bound."
            )
          );
        }
      });
      child.stdin.on("error", (error) => stop(error));
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        cleanup();
        if (failure) {
          reject(failure);
          return;
        }
        try {
          const response: unknown = JSON.parse(
            Buffer.concat(output).toString("utf8")
          );
          if (code !== 0) {
            const error = z
              .object({
                error: z.object({ code: z.string().max(64) }).strict(),
              })
              .strict()
              .parse(response);
            reject(
              new Error(
                `Selected artifact capture rejected: ${error.error.code}`
              )
            );
            return;
          }
          resolve(response);
        } catch {
          reject(
            new Error("Selected artifact capture returned an invalid response.")
          );
        }
      });
      child.stdin.end(request);
      if (signal?.aborted) {
        abort();
      }
    });
  } finally {
    active -= 1;
  }
}

/**
 * The host supplies an already authorized, canonical profile root. Initial anchor
 * acquisition and every capture traverse all parents with directory descriptors
 * and no-follow opens. Later root replacement never refreshes this authority.
 * This is a trusted static worker, not execution of arbitrary profile Python.
 */
export async function createSelectedArtifactCapture(
  authorizedProfileRoot: string,
  signal?: AbortSignal
): Promise<SelectedArtifactCapture> {
  if (
    !path.isAbsolute(authorizedProfileRoot) ||
    path.normalize(authorizedProfileRoot) !== authorizedProfileRoot ||
    authorizedProfileRoot === "/" ||
    authorizedProfileRoot.endsWith("/") ||
    CONTROL.test(authorizedProfileRoot)
  ) {
    throw new Error("An authorized canonical profile root is required.");
  }
  const anchor = z
    .object({ rootIdentity })
    .strict()
    .parse(
      await worker(
        {
          operation: "anchor",
          root: authorizedProfileRoot,
        },
        signal
      )
    );
  const expectedRoot = Object.freeze({ ...anchor.rootIdentity });
  signal?.throwIfAborted();
  return Object.freeze({
    async capture(sourcePath: string, captureSignal?: AbortSignal) {
      selectedPath(sourcePath);
      const response = z
        .object({
          bytesBase64: z.string().max(Math.ceil(MAX_BYTES / 3) * 4),
          evidence: evidenceSchema,
        })
        .strict()
        .parse(
          await worker(
            {
              expectedRoot,
              operation: "capture",
              root: authorizedProfileRoot,
              sourcePath,
            },
            captureSignal
          )
        );
      if (
        response.bytesBase64.length % 4 !== 0 ||
        INVALID_BASE64.test(response.bytesBase64.replace(BASE64_PADDING, "")) ||
        response.evidence.sourcePath !== sourcePath ||
        response.evidence.rootIdentity.device !== expectedRoot.device ||
        response.evidence.rootIdentity.inode !== expectedRoot.inode
      ) {
        throw new Error(
          "Selected artifact capture evidence does not match the selection."
        );
      }
      const bytes = Buffer.from(response.bytesBase64, "base64");
      if (
        bytes.length > MAX_BYTES ||
        bytes.toString("base64") !== response.bytesBase64 ||
        bytes.length !== response.evidence.sizeBytes ||
        bytes.length !== response.evidence.file.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !==
          response.evidence.sha256
      ) {
        throw new Error(
          "Selected artifact captured bytes do not match their evidence."
        );
      }
      captureSignal?.throwIfAborted();
      return { bytes, evidence: response.evidence };
    },
  });
}
