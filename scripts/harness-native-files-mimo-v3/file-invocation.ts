import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileDigest, type ScheduledFileArm } from "./file-process-outcome";
import {
  type FileProcessDeadline,
  runFileProcess,
} from "./file-process-runner";

export interface FileInvocationStamp {
  monotonicMs: number;
  wallMs: number;
}
export const fileInvocationStamp = (): FileInvocationStamp => ({
  monotonicMs: performance.now(),
  wallMs: Date.now(),
});
export interface FileEvidenceReference {
  bytes: number;
  path: string;
  sha256: string;
}
export async function fileEvidenceReference(
  directory: string,
  path: string
): Promise<FileEvidenceReference> {
  const bytes = await readFile(join(directory, path));
  return { bytes: bytes.length, path, sha256: fileDigest(bytes) };
}

/** Parent-only invocation. Identity is never substituted into native output. */
export async function invokeFileNativeProcess(options: {
  args: readonly string[];
  beforeEvidencePersistence?: () => Promise<void>;
  attemptStarted: FileInvocationStamp;
  command: string;
  deadline: FileProcessDeadline;
  directory: string;
  expected: ScheduledFileArm;
  input: unknown;
  sourceAssignment: FileEvidenceReference;
}) {
  const invocationStarted = fileInvocationStamp();
  const execution = await runFileProcess({
    args: options.args,
    command: options.command,
    cwd: options.expected.nativeStateRoot,
    deadline: options.deadline,
    directory: join(options.directory, "process"),
    env: {
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      PYTHONDONTWRITEBYTECODE: "1",
      TMPDIR: "/private/tmp",
    },
    expected: options.expected,
    input: options.input,
    runtimeIdentityBytes: await readFile(
      join(options.directory, "runtime-identity.json")
    ),
  });
  const processHelperReturned = fileInvocationStamp();
  await options.beforeEvidencePersistence?.();
  const names = [
    "process/process-outcome.json",
    "process/scheduled-arm.json",
    "process/parent-process-events.jsonl",
    "process/runner-stdout.json",
    "process/runner-stderr.log",
    "process/runner-input.json",
    "runtime-identity.json",
  ] as const;
  const references = Object.fromEntries(
    await Promise.all(
      names.map(async (path) => [
        path,
        await fileEvidenceReference(options.directory, path),
      ])
    )
  );
  const invocation = {
    attemptStarted: options.attemptStarted,
    deadline: options.deadline,
    expected: options.expected,
    invocationStarted,
    processHelperElapsedMs:
      processHelperReturned.monotonicMs - invocationStarted.monotonicMs,
    processHelperElapsedWallMs:
      processHelperReturned.wallMs - invocationStarted.wallMs,
    processHelperReturned,
    references,
    schemaVersion: 3,
    sourceAssignment: options.sourceAssignment,
  };
  await writeFile(
    join(options.directory, "invocation.json"),
    JSON.stringify(invocation),
    { flag: "wx", mode: 0o600 }
  );
  // These compatibility files contain exact original bytes, never a pretty-printed
  // parsed payload or a synthetic failed native observation.
  await writeFile(
    join(options.directory, "runner-input.json"),
    await readFile(join(options.directory, "process/runner-input.json")),
    { flag: "wx", mode: 0o600 }
  );
  await writeFile(
    join(options.directory, "observation.json"),
    execution.nativeObservation
      ? await readFile(join(options.directory, "process/runner-stdout.json"))
      : "null",
    { flag: "wx", mode: 0o600 }
  );
  return {
    execution,
    invocation,
    processEvidence: {
      invocation: await fileEvidenceReference(
        options.directory,
        "invocation.json"
      ),
      nativeIdentity: execution.native.identity,
      processFailure: execution.processFailure,
      receiptComplete: execution.receiptComplete,
    },
  };
}
