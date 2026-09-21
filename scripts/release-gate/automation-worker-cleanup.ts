import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SNAPSHOT_PATTERN =
  /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;
const AUTOMATION_SCRIPTS = new Set([
  "apps/platform/automation/src/index.ts",
  "apps/platform/automation/dist/index.js",
]);

interface WorkerRecord {
  pid: number;
  script: string;
  startedAt: number;
}

interface ProcessIdentity {
  command: string;
  executable: string;
  parentPid: number;
  startedAt: string;
}

export interface OwnedAutomationWorker {
  identity: ProcessIdentity;
  record: WorkerRecord;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw new Error("Could not inspect the recorded automation worker");
  }
}

async function readRecord(configDir: string): Promise<WorkerRecord> {
  const actualConfigDir = await realpath(configDir);
  const developerConfigDir = await realpath(join(homedir(), ".atlas")).catch(
    () => resolve(homedir(), ".atlas")
  );
  const fromDeveloperConfig = relative(developerConfigDir, actualConfigDir);
  if (
    fromDeveloperConfig === "" ||
    !(
      fromDeveloperConfig === ".." ||
      fromDeveloperConfig.startsWith(`..${sep}`) ||
      isAbsolute(fromDeveloperConfig)
    )
  ) {
    throw new Error("Refusing worker cleanup in the developer Atlas directory");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(
        join(actualConfigDir, "runtime/workers/automation.json"),
        "utf8"
      )
    );
  } catch {
    // Health can become ready before the worker's asynchronous startup finishes.
    // An absent record does not prove that no detached worker was spawned.
    throw new Error(
      "Automation worker startup ownership is unverified: no readable record"
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("processName" in value) ||
    value.processName !== "automation" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    !("script" in value) ||
    typeof value.script !== "string" ||
    !AUTOMATION_SCRIPTS.has(value.script) ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "number" ||
    !Number.isFinite(value.startedAt)
  ) {
    throw new Error("Automation worker record cannot establish ownership");
  }
  return { pid: value.pid, script: value.script, startedAt: value.startedAt };
}

async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  if (!isAlive(pid)) {
    return null;
  }
  try {
    const options = {
      encoding: "utf8" as const,
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 65_536,
      timeout: 1000,
    };
    const snapshot = await execFileAsync(
      "/bin/ps",
      [
        "-ww",
        "-p",
        String(pid),
        "-o",
        "ppid=",
        "-o",
        "lstart=",
        "-o",
        "command=",
      ],
      options
    );
    const match = SNAPSHOT_PATTERN.exec(snapshot.stdout);
    if (!match) {
      throw new Error("Unrecognized process identity");
    }
    let executable: string;
    if (process.platform === "linux") {
      executable = await realpath(`/proc/${pid}/exe`);
    } else if (process.platform === "darwin") {
      const command = await execFileAsync(
        "/bin/ps",
        ["-p", String(pid), "-o", "comm="],
        options
      );
      executable = await realpath(command.stdout.trim());
    } else {
      throw new Error("Unsupported process identity platform");
    }
    return {
      command: match[3]!,
      executable,
      parentPid: Number(match[1]),
      startedAt: match[2]!.replace(/\s+/g, " "),
    };
  } catch {
    if (!isAlive(pid)) {
      return null;
    }
    // Never include raw process arguments or inspection output in diagnostics.
    throw new Error("Could not verify automation worker process identity");
  }
}

export async function captureOwnedAutomationWorker(
  configDir: string,
  apiPid: number
): Promise<OwnedAutomationWorker> {
  const record = await readRecord(configDir);
  const identity = await inspectProcess(record.pid);
  if (
    !identity ||
    identity.parentPid !== apiPid ||
    identity.executable !== (await realpath(process.execPath)) ||
    identity.command !== `${process.execPath} run ${record.script}`
  ) {
    throw new Error(
      "Recorded automation worker is not a verified child of this Atlas server"
    );
  }
  return { identity, record };
}

async function signalOwnedWorker(
  worker: OwnedAutomationWorker,
  signal: "SIGTERM" | "SIGKILL"
): Promise<void> {
  const current = await inspectProcess(worker.record.pid);
  if (!current) {
    return;
  }
  if (JSON.stringify(current) !== JSON.stringify(worker.identity)) {
    throw new Error(
      "Automation worker identity changed; refusing to signal it"
    );
  }
  try {
    process.kill(worker.record.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw new Error("Could not signal the verified automation worker");
    }
  }
}

async function waitForWorkerExit(
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
}

export async function stopOwnedAutomationWorker(
  worker: OwnedAutomationWorker,
  timeoutMs: number
): Promise<void> {
  await signalOwnedWorker(worker, "SIGTERM");
  if (await waitForWorkerExit(worker.record.pid, timeoutMs)) {
    return;
  }
  await signalOwnedWorker(worker, "SIGKILL");
  if (!(await waitForWorkerExit(worker.record.pid, timeoutMs))) {
    throw new Error("Verified automation worker did not exit after SIGKILL");
  }
}

export async function assertAutomationWorkerExited(
  configDir: string,
  worker: OwnedAutomationWorker | null
): Promise<void> {
  const record = await readRecord(configDir);
  if (
    !worker ||
    record.pid !== worker.record.pid ||
    record.script !== worker.record.script ||
    record.startedAt !== worker.record.startedAt
  ) {
    throw new Error(
      "Automation worker record changed or ownership remained unknown after API teardown"
    );
  }
  if (isAlive(record.pid)) {
    throw new Error("Automation worker is still alive after API teardown");
  }
}
