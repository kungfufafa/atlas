import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assessFileNativeOutput,
  fileDigest,
  fileRecord,
  type ScheduledFileArm,
} from "./file-process-outcome";

interface Stamp {
  monotonicMs: number;
  wallMs: number;
}
const stamp = (): Stamp => ({
  monotonicMs: performance.now(),
  wallMs: Date.now(),
});
const code = (error: unknown): string =>
  fileRecord(error) && typeof error.code === "string"
    ? error.code
    : error instanceof Error
      ? error.name
      : "unknown_error";
export interface FileProcessDeadline {
  readonly atMonotonicMs: number;
  readonly atWallMs: number;
  readonly scope: "scheduled_attempt" | "process_invocation";
}
export function createFileProcessDeadline(
  milliseconds: number,
  scope: FileProcessDeadline["scope"]
): FileProcessDeadline {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error("Positive finite process budget required.");
  }
  const now = stamp();
  return Object.freeze({
    atMonotonicMs: now.monotonicMs + milliseconds,
    atWallMs: now.wallMs + milliseconds,
    scope,
  });
}
interface Event extends Stamp {
  event: string;
  [key: string]: unknown;
}
interface Capture {
  bytesObserved: number;
  bytesStored: number;
  chunks: Buffer[];
  ended: boolean;
  overflow: boolean;
}
interface FileProcessOptions {
  args: readonly string[];
  command: string;
  cwd: string;
  deadline: FileProcessDeadline;
  directory: string;
  env: NodeJS.ProcessEnv;
  expected: ScheduledFileArm;
  input: unknown;
  limits?: {
    stdoutBytes?: number;
    stderrBytes?: number;
    inputBytes?: number;
    termGraceMs?: number;
    closeGraceMs?: number;
    drainGraceMs?: number;
  };
  runtimeIdentityBytes: Uint8Array;
}
function bounded(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) {
    throw new Error("Invalid runner capture or timing bound.");
  }
  return n;
}
function durableExclusive(path: string, bytes: string | Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Trusted parent runner. Cooperative timing; not an independent host-stall watchdog. */
export async function runFileProcess(options: FileProcessOptions) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("POSIX process groups required.");
  }
  const started = stamp();
  const expected = Object.freeze({ ...options.expected });
  const deadline = Object.freeze({ ...options.deadline });
  if (
    !(
      Number.isFinite(deadline.atMonotonicMs) &&
      Number.isFinite(deadline.atWallMs)
    )
  ) {
    throw new Error("Invalid parent deadline.");
  }
  for (const value of [
    expected.attemptId,
    expected.pairId,
    expected.transportId,
    expected.nativeStateRoot,
  ]) {
    if (typeof value !== "string" || !value) {
      throw new Error("Explicit expected arm identity required.");
    }
  }
  if (
    !(
      /^[a-f0-9]{64}$/.test(expected.identitySha256) &&
      ["atlas", "hermes"].includes(expected.harness)
    )
  ) {
    throw new Error("Invalid expected arm binding.");
  }
  const args = [...options.args],
    env = { ...options.env },
    cwd = options.cwd,
    command = options.command,
    directory = options.directory;
  const limits = {
    closeGraceMs: bounded(options.limits?.closeGraceMs, 1000, 5000),
    drainGraceMs: bounded(options.limits?.drainGraceMs, 250, 5000),
    inputBytes: bounded(options.limits?.inputBytes, 2_000_000, 2_000_000),
    stderrBytes: bounded(options.limits?.stderrBytes, 2_000_000, 2_000_000),
    stdoutBytes: bounded(options.limits?.stdoutBytes, 20_000_000, 20_000_000),
    termGraceMs: bounded(options.limits?.termGraceMs, 2000, 5000),
  };
  const failures: string[] = [];
  let parentBinding: "bound" | "conflict" | "unavailable" = "unavailable";
  let identityBytes: Buffer | null = null;
  try {
    identityBytes = Buffer.from(options.runtimeIdentityBytes);
    if (identityBytes.length > 65_536) {
      identityBytes = null;
      failures.push("runtime_identity_oversize");
    } else {
      const identity: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(identityBytes)
      );
      if (
        !fileRecord(identity) ||
        fileDigest(identityBytes) !== expected.identitySha256 ||
        (
          [
            "attemptId",
            "pairId",
            "harness",
            "nativeStateRoot",
            "transportId",
          ] as const
        ).some((key) => identity[key] !== expected[key])
      ) {
        parentBinding = "conflict";
        failures.push("runtime_identity_conflict");
      } else {
        parentBinding = "bound";
      }
    }
  } catch {
    failures.push("runtime_identity_unavailable");
  }

  if (cwd !== expected.nativeStateRoot) {
    parentBinding = "conflict";
    failures.push("launch_directory_identity_conflict");
  }
  let inputBytes: Buffer | null = null;
  try {
    const serialized = JSON.stringify(options.input);
    if (serialized === undefined) {
      throw new Error("Unserializable input");
    }
    inputBytes = Buffer.from(serialized);
    if (inputBytes.length > limits.inputBytes) {
      inputBytes = null;
      failures.push("input_oversize");
    } else {
      const parsed: unknown = JSON.parse(serialized);
      if (!fileRecord(parsed) || parsed.runId !== expected.transportId) {
        parentBinding = "conflict";
        failures.push("input_identity_conflict");
      }
    }
  } catch {
    failures.push("input_serialization_failed");
  }
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const scheduled = {
    deadline,
    expected,
    inputSha256: inputBytes ? fileDigest(inputBytes) : null,
    launch: {
      argsSha256: fileDigest(JSON.stringify(args)),
      command,
      cwd,
      environmentSha256: fileDigest(
        JSON.stringify(
          Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
        )
      ),
    },
    limits,
    origin: "parent_scheduled_arm",
    schemaVersion: 3,
    started,
  };
  durableExclusive(
    join(directory, "scheduled-arm.json"),
    JSON.stringify(scheduled, null, 2)
  );
  if (identityBytes) {
    durableExclusive(
      join(directory, "parent-runtime-identity.json"),
      identityBytes
    );
  }
  if (inputBytes) {
    durableExclusive(join(directory, "runner-input.json"), inputBytes);
  }
  const journalFd = openSync(
    join(directory, "parent-process-events.jsonl"),
    "wx",
    0o600
  );
  const events: Event[] = [];
  const persistenceErrors: string[] = [];
  let finished = false;
  const record = (event: string, detail: Record<string, unknown> = {}) => {
    if (finished) {
      return;
    }
    const row = { event, ...stamp(), ...detail };
    events.push(row);
    try {
      writeFileSync(journalFd, JSON.stringify(row) + "\n");
      fsyncSync(journalFd);
    } catch (error) {
      persistenceErrors.push(code(error));
    }
  };
  record("scheduled_receipt_persisted", {
    scheduledSha256: fileDigest(JSON.stringify(scheduled, null, 2)),
  });
  const stdout: Capture = {
    bytesObserved: 0,
    bytesStored: 0,
    chunks: [],
    ended: false,
    overflow: false,
  };
  const stderr: Capture = {
    bytesObserved: 0,
    bytesStored: 0,
    chunks: [],
    ended: false,
    overflow: false,
  };
  let child: ChildProcessWithoutNullStreams | undefined;
  let pid: number | null = null;
  const lifecycle: {
    exit: {
      code: number | null;
      signal: NodeJS.Signals | null;
      at: Stamp;
    } | null;
  } = { exit: null };
  let closed = false,
    timedOut = false,
    drainExpired = false;
  let processGroupProbe:
    | "not_started"
    | "absent_at_probe"
    | "present_at_probe"
    | "unknown" = "not_started";
  const signals: Array<{
    signal: NodeJS.Signals;
    scope: string;
    result: string;
    at: Stamp;
  }> = [];
  const terminate = (signal: NodeJS.Signals) => {
    if (!pid) {
      return;
    }
    let result = "sent";
    try {
      process.kill(-pid, signal);
    } catch (error) {
      result = code(error);
    }
    const attempt = {
      at: stamp(),
      result,
      scope: "detached_process_group",
      signal,
    };
    signals.push(attempt);
    record("signal_attempt", attempt);
  };
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    failures.push(reason);
    record("stop_requested", { reason });
    terminate("SIGTERM");
    timers.push(setTimeout(() => terminate("SIGKILL"), limits.termGraceMs));
    timers.push(
      setTimeout(() => {
        record("close_wait_exhausted");
        terminate("SIGKILL");
        resolveDone();
      }, limits.termGraceMs + limits.closeGraceMs)
    );
  };
  const capture = (
    state: Capture,
    name: string,
    limit: number,
    data: Buffer
  ) => {
    if (finished) {
      return;
    }
    state.bytesObserved += data.length;
    const keep = data.subarray(0, Math.max(0, limit - state.bytesStored));
    if (keep.length) {
      state.chunks.push(Buffer.from(keep));
      state.bytesStored += keep.length;
    }
    if (state.bytesObserved > limit && !state.overflow) {
      state.overflow = true;
      record("capture_overflow", { limit, stream: name });
      stop(`${name}_overflow`);
    }
  };
  try {
    if (persistenceErrors.length) {
      failures.push("parent_journal_failed");
    }
    if (performance.now() >= deadline.atMonotonicMs) {
      timedOut = true;
      failures.push("deadline_before_spawn");
      record("deadline_before_spawn");
    }
    if (!failures.length) {
      timers.push(
        setTimeout(
          () => {
            timedOut = true;
            record("deadline_fired", {
              overshootMs: Math.max(
                0,
                performance.now() - deadline.atMonotonicMs
              ),
            });
            stop("process_deadline");
          },
          Math.max(1, deadline.atMonotonicMs - performance.now())
        )
      );
      record("spawn_call");
      child = spawn(command, args, {
        cwd,
        detached: true,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      pid = child.pid ?? null;
      record("spawn_returned", { pid });
      child.once("spawn", () => record("spawn_event", { pid }));
      child.once("error", (error) => {
        record("child_error", { code: code(error) });
        stop("spawn_or_process_error");
      });
      child.once("exit", (exitCode, signal) => {
        lifecycle.exit = { at: stamp(), code: exitCode, signal };
        record("exit", { code: exitCode, signal });
        timers.push(
          setTimeout(() => {
            if (!closed) {
              drainExpired = true;
              record("drain_wait_exhausted");
              stop("drain_timeout");
            }
          }, limits.drainGraceMs)
        );
      });
      child.once("close", (exitCode, signal) => {
        closed = true;
        record("close", { code: exitCode, signal });
        resolveDone();
      });
      child.stdout.on("data", (data) =>
        capture(stdout, "stdout", limits.stdoutBytes, Buffer.from(data))
      );
      child.stderr.on("data", (data) =>
        capture(stderr, "stderr", limits.stderrBytes, Buffer.from(data))
      );
      child.stdout.once("end", () => {
        stdout.ended = true;
        record("stdout_end");
      });
      child.stderr.once("end", () => {
        stderr.ended = true;
        record("stderr_end");
      });
      child.stdout.once("error", (error) => {
        record("stdout_error", { code: code(error) });
        stop("stdout_error");
      });
      child.stderr.once("error", (error) => {
        record("stderr_error", { code: code(error) });
        stop("stderr_error");
      });
      child.stdin.once("error", (error) => {
        record("stdin_error", { code: code(error) });
        stop("stdin_error");
      });
      if (performance.now() >= deadline.atMonotonicMs) {
        timedOut = true;
        record("deadline_passed_on_spawn_return");
        stop("process_deadline");
      } else {
        child.stdin.end(inputBytes!);
      }
      if (persistenceErrors.length) {
        stop("parent_journal_failed");
      }
      await done;
    }
  } catch (error) {
    record("parent_error", { code: code(error) });
    failures.push("parent_process_error");
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    terminate("SIGKILL");
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    child?.unref();
    if (pid) {
      try {
        process.kill(-pid, 0);
        processGroupProbe = "present_at_probe";
      } catch (error) {
        processGroupProbe =
          code(error) === "ESRCH" ? "absent_at_probe" : "unknown";
      }
      record("group_probe", { result: processGroupProbe });
    }
  }
  if (!closed && pid) {
    failures.push("child_close_unobserved");
  }
  if (lifecycle.exit?.code !== 0) {
    failures.push(pid ? "child_exit_not_zero" : "child_not_started");
  }
  if (pid && !stderr.ended) {
    failures.push("stderr_capture_incomplete");
  }
  const stdoutBytes = Buffer.concat(stdout.chunks),
    stderrBytes = Buffer.concat(stderr.chunks);
  const complete = closed && stdout.ended && !stdout.overflow;
  const native = assessFileNativeOutput(stdoutBytes, complete, expected);
  if (native.identity !== "bound") {
    failures.push(`native_${native.reason}`);
  }
  if (native.observation && native.observation.status !== "completed") {
    failures.push("native_reported_failure");
  }
  const captureFacts = (state: Capture, bytes: Buffer) => ({
    bytesAfterCaptureEnd: "unknown",
    bytesObserved: state.bytesObserved,
    bytesStored: state.bytesStored,
    complete: closed && state.ended && !state.overflow,
    overflow: state.overflow,
    sha256: fileDigest(bytes),
    streamEndObserved: state.ended,
  });
  if (performance.now() > deadline.atMonotonicMs) {
    timedOut = true;
    failures.push("deadline_exceeded_at_observation");
    record("deadline_exceeded_at_observation");
  }
  record("process_receipt_finalizing");
  finished = true;
  try {
    closeSync(journalFd);
  } catch (error) {
    persistenceErrors.push(code(error));
  }
  if (persistenceErrors.length) {
    failures.push("parent_journal_failed");
  }
  const observedEvidence = native.observation?.evidence;
  const receipt = {
    cleanup: {
      allDescendantsGone: "unproved",
      directChildCloseObserved: closed,
      directChildExitObserved: lifecycle.exit !== null,
      nativeReport: fileRecord(observedEvidence)
        ? {
            authority: "native_report_only",
            nativeCleanup:
              fileRecord(observedEvidence.nativeCleanup) &&
              typeof observedEvidence.nativeCleanup.completed === "boolean"
                ? { completed: observedEvidence.nativeCleanup.completed }
                : null,
            supervisorCleanup:
              fileRecord(observedEvidence.supervisorCleanup) &&
              typeof observedEvidence.supervisorCleanup.completed === "boolean"
                ? { completed: observedEvidence.supervisorCleanup.completed }
                : null,
          }
        : null,
      processGroupProbe,
    },
    closed,
    deadline,
    drainExpired,
    elapsedMonotonicMs: performance.now() - started.monotonicMs,
    elapsedWallMs: Date.now() - started.wallMs,
    events,
    exit: lifecycle.exit,
    expected,
    failures: [...new Set(failures)],
    native: {
      identity: native.identity,
      observationFile: native.observation
        ? {
            bytes: stdoutBytes.length,
            path: "runner-stdout.json",
            sha256: fileDigest(stdoutBytes),
          }
        : null,
      observedIdentity: native.observedIdentity,
      reason: native.reason,
      reportedStatus: native.observation?.status ?? null,
    },
    parentBinding,
    persistenceErrors,
    pid,
    processFailure: failures.length > 0,
    processObservedAt: stamp(),
    receiptComplete: persistenceErrors.length === 0,
    scheduledSha256: fileDigest(JSON.stringify(scheduled, null, 2)),
    schemaVersion: 3,
    signals,
    started,
    stderr: captureFacts(stderr, stderrBytes),
    stdout: captureFacts(stdout, stdoutBytes),
    timedOut,
    usage: {
      inferZeroFromProcessFailure: false,
      reportedCounts: null,
      status: "not_collected_by_process_runner",
    },
  };
  durableExclusive(join(directory, "runner-stdout.json"), stdoutBytes);
  durableExclusive(join(directory, "runner-stderr.log"), stderrBytes);
  durableExclusive(
    join(directory, "process-outcome.json"),
    JSON.stringify(receipt)
  );
  return { ...receipt, nativeObservation: native.observation };
}
