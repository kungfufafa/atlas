import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { open as openFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerLogsResponse, WorkerProcessInfo } from "@atlas/core";
import {
  createWorkspaceWorkerAuthToken,
  getUserConfigDir,
  isProcessAlive,
  listConfiguredChannelWorkspaceIds,
  type PlatformWorkerName,
  readRuntimeServerUrl,
  readWorkerDesiredState,
  setWorkerDesiredRunning,
  WORKSPACE_WORKER_AUTH_TOKEN_ENV,
} from "@atlas/core";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "@atlas/core/fs";

const WORKER_SCRIPTS: Record<string, string> = {
  automation: "apps/platform/automation/src/index.ts",
  discord: "apps/platform/discord/src/index.ts",
  telegram: "apps/platform/telegram/src/index.ts",
  whatsapp: "apps/platform/whatsapp/src/index.ts",
};

const WORKER_DIST_SCRIPTS: Partial<Record<string, string>> = {
  automation: "apps/platform/automation/dist/index.js",
  discord: "apps/platform/discord/dist/index.js",
  telegram: "apps/platform/telegram/dist/index.js",
  whatsapp: "apps/platform/whatsapp/dist/index.js",
};

const VALID_WORKERS = Object.keys(WORKER_SCRIPTS);
const WORKSPACE_WORKER_ENV_BLOCKLIST = [
  "ATLAS_DISCORD_PROFILE_ID",
  "ATLAS_TELEGRAM_PROFILE_ID",
  "ATLAS_WHATSAPP_PROFILE_ID",
  "ATLAS_LOCAL_AUTH_TOKEN",
  "atlas_LOCAL_AUTH_TOKEN",
  "DISCORD_ALLOWED_USER_IDS",
  "DISCORD_BLOCKED_USER_IDS",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_BLOCKED_USER_IDS",
  "TELEGRAM_BOT_TOKEN",
  "WHATSAPP_PHONE_NUMBER",
] as const;
const WORKSPACE_WORKER_ENV_ALLOWLIST = [
  "ALL_PROXY",
  "COMSPEC",
  // Propagate the host privacy opt-out, but never its telemetry DSN credential.
  "DO_NOT_TRACK",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "WHATSAPP_VERBOSE_LOGS",
  "WINDIR",
  "__CF_USER_TEXT_ENCODING",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
const WORKSPACE_WORKERS = ["telegram", "discord", "whatsapp"] as const;
type WorkspaceWorkerName = (typeof WORKSPACE_WORKERS)[number];

interface NativeWorkerProcessState {
  pid: number;
  processName: string;
  script: string;
  startedAt: number;
  workspaceId?: string;
}

interface NativeProcessResources {
  cpuPercent: number | null;
  memoryMb: number | null;
}

export interface LinuxCpuSample {
  aggregateTicks: number;
  cpuCount: number;
  processStartTicks: number;
  processTicks: number;
}

const MAX_NATIVE_CPU_SAMPLES = 256;
const linuxCpuSamples = new Map<number, LinuxCpuSample>();

function openPrivateWorkerLog(path: string): number {
  const fd = openSync(path, "a", PRIVATE_FILE_MODE);
  try {
    // Creation mode does not repair logs left by older workers. Restrict the
    // opened inode before handing the descriptor to a child, preserving bytes.
    fchmodSync(fd, PRIVATE_FILE_MODE);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

async function clearPrivateWorkerLog(path: string): Promise<void> {
  const file = await openFile(path, "a", PRIVATE_FILE_MODE);
  try {
    await file.chmod(PRIVATE_FILE_MODE);
    await file.truncate(0);
  } finally {
    await file.close();
  }
}

function promisifyPm2<T>(
  // pm2's typed callbacks expect a non-null Error and a specific payload
  // (Proc / ProcessDescription[]); accept the widest shape here so any pm2
  // method callback is assignable, then narrow to T on resolve.
  fn: (cb: (err: Error | null, result?: unknown) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result as T);
      }
    });
  });
}

export class WorkerManagerService {
  private pm2Module: typeof import("pm2") | null = null;
  private readonly isPm2Injected: boolean;

  constructor(
    private readonly projectRoot: string,
    pm2?: typeof import("pm2")
  ) {
    this.pm2Module = pm2 ?? null;
    this.isPm2Injected = Boolean(pm2);
  }

  private getWorkersLogDir(): string {
    const dir = join(getUserConfigDir(), "logs", "workers");
    mkdirSync(dir, { mode: PRIVATE_DIR_MODE, recursive: true });
    chmodSync(dir, PRIVATE_DIR_MODE);
    return dir;
  }

  private getWorkersRuntimeDir(): string {
    const dir = join(getUserConfigDir(), "runtime", "workers");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getProcessStatePath(processName: string): string {
    return join(this.getWorkersRuntimeDir(), `${processName}.json`);
  }

  private getLogPaths(name: string): { outPath: string; errPath: string } {
    const logDir = this.getWorkersLogDir();
    return {
      errPath: join(logDir, `${name}.err.log`),
      outPath: join(logDir, `${name}.out.log`),
    };
  }

  isValidWorker(name: string): boolean {
    return VALID_WORKERS.includes(name);
  }

  isWorkspaceWorker(name: string): name is WorkspaceWorkerName {
    return (WORKSPACE_WORKERS as readonly string[]).includes(name);
  }

  private resolveWorkerScript(name: string): string {
    const srcScript = WORKER_SCRIPTS[name];
    if (srcScript && existsSync(join(this.projectRoot, srcScript))) {
      return srcScript;
    }

    const distScript = WORKER_DIST_SCRIPTS[name];
    if (distScript && existsSync(join(this.projectRoot, distScript))) {
      return distScript;
    }

    return srcScript!;
  }

  private async ensurePm2(): Promise<NonNullable<typeof import("pm2")>> {
    if (this.pm2Module) {
      return this.pm2Module;
    }

    try {
      const mod = await import("pm2");
      const pm2 = (mod.default ?? mod) as NonNullable<typeof import("pm2")>;
      this.pm2Module = pm2;
      return pm2;
    } catch {
      throw new Error(
        "PM2 is not available. Install it with: npm install -g pm2"
      );
    }
  }

  private async withPm2<T>(
    action: (pm2: NonNullable<typeof import("pm2")>) => Promise<T>
  ): Promise<T> {
    const pm2 = await this.ensurePm2();

    await promisifyPm2<void>((cb) => pm2.connect(cb));

    try {
      return await action(pm2);
    } finally {
      pm2.disconnect();
    }
  }

  private async removeWorkerFromPm2(
    pm2: NonNullable<typeof import("pm2")>,
    name: string
  ): Promise<void> {
    await promisifyPm2<void>((cb) => pm2.stop(name, cb)).catch(() => {});
    await promisifyPm2<void>((cb) => pm2.delete(name, cb)).catch(() => {});
  }

  private async readNativeProcessState(
    processName: string
  ): Promise<NativeWorkerProcessState | null> {
    try {
      const filePath = this.getProcessStatePath(processName);
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as NativeWorkerProcessState;
      if (
        typeof parsed?.pid === "number" &&
        typeof parsed?.startedAt === "number"
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async writeNativeProcessState(
    state: NativeWorkerProcessState
  ): Promise<void> {
    const filePath = this.getProcessStatePath(state.processName);
    await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  private async clearNativeProcessState(processName: string): Promise<void> {
    const filePath = this.getProcessStatePath(processName);
    await rm(filePath, { force: true });
  }

  private async stopNativeProcess(processName: string): Promise<void> {
    const state = await this.readNativeProcessState(processName);
    if (state && isProcessAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
    }
    await this.clearNativeProcessState(processName);
  }

  private async startNativeProcess(
    processName: string,
    script: string,
    workspaceId?: string,
    workspaceChannel?: WorkspaceWorkerName
  ): Promise<void> {
    await this.stopNativeProcess(processName);

    const { outPath, errPath } = this.getLogPaths(processName);
    const outFd = openPrivateWorkerLog(outPath);
    let errFd: number | undefined;

    try {
      errFd = openPrivateWorkerLog(errPath);
      const execPath = process.execPath || "bun";
      const child = spawn(execPath, ["run", script], {
        cwd: this.projectRoot,
        detached: true,
        env: await this.workerProcessEnv(workspaceId, workspaceChannel),
        stdio: ["ignore", outFd, errFd],
      });

      child.unref();

      if (child.pid) {
        await this.writeNativeProcessState({
          pid: child.pid,
          processName,
          script,
          startedAt: Date.now(),
          workspaceId,
        });
      }
    } finally {
      closeSync(outFd);
      if (errFd !== undefined) {
        closeSync(errFd);
      }
    }
  }

  async startWorker(name: string): Promise<void> {
    if (!this.isValidWorker(name)) {
      throw new Error(`Unknown worker: ${name}`);
    }

    await setWorkerDesiredRunning(name as PlatformWorkerName, true);

    if (this.isPm2Injected) {
      await this.withPm2(async (pm2) => {
        const script = this.resolveWorkerScript(name);
        const env = await this.workerProcessEnv();
        await this.removeWorkerFromPm2(pm2, name);
        await promisifyPm2<void>((cb) =>
          pm2.start(
            {
              args: ["run", script],
              cwd: this.projectRoot,
              env,
              name,
              script: "bun",
            },
            cb
          )
        );
      });
      return;
    }

    const script = this.resolveWorkerScript(name);
    await this.startNativeProcess(name, script);
  }

  async startWorkspaceWorker(
    name: WorkspaceWorkerName,
    orgId: string
  ): Promise<void> {
    const workspaceId = validateWorkspaceId(orgId);
    const processName = workspaceWorkerProcessName(name, workspaceId);

    if (this.isPm2Injected) {
      await this.withPm2(async (pm2) => {
        const script = this.resolveWorkerScript(name);
        const env = await this.workerProcessEnv(workspaceId, name);
        await this.removeWorkerFromPm2(pm2, processName);
        await promisifyPm2<void>((cb) =>
          pm2.start(
            {
              args: ["run", script],
              cwd: this.projectRoot,
              env,
              name: processName,
              script: "bun",
            },
            cb
          )
        );
      });
      return;
    }

    const script = this.resolveWorkerScript(name);
    await this.startNativeProcess(processName, script, workspaceId, name);
  }

  async restartWorkspaceWorker(
    name: WorkspaceWorkerName,
    orgId: string
  ): Promise<void> {
    await this.startWorkspaceWorker(name, orgId);
  }

  async stopWorkspaceWorker(
    name: WorkspaceWorkerName,
    orgId: string
  ): Promise<void> {
    const processName = workspaceWorkerProcessName(
      name,
      validateWorkspaceId(orgId)
    );

    if (this.isPm2Injected) {
      await this.withPm2((pm2) => this.removeWorkerFromPm2(pm2, processName));
      return;
    }

    await this.stopNativeProcess(processName);
  }

  async stopWorker(name: string): Promise<void> {
    if (!this.isValidWorker(name)) {
      throw new Error(`Unknown worker: ${name}`);
    }

    if (this.isPm2Injected) {
      await this.withPm2(async (pm2) => {
        await promisifyPm2<void>((cb) => pm2.stop(name, cb));
      });
    } else {
      await this.stopNativeProcess(name);
    }

    await setWorkerDesiredRunning(name as PlatformWorkerName, false);
  }

  async recoverDesiredWorkers(): Promise<void> {
    const desired = await readWorkerDesiredState();
    const statuses = await this.getAllWorkerStatuses();

    for (const name of VALID_WORKERS) {
      if (!desired[name as PlatformWorkerName]) {
        continue;
      }

      if (statuses[name]?.status === "online") {
        continue;
      }

      try {
        await this.startWorker(name);
        console.log(`Recovered ${name} worker`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not recover ${name} worker: ${message}`);
      }
    }

    for (const name of WORKSPACE_WORKERS) {
      const orgIds = await listConfiguredChannelWorkspaceIds(name);
      for (const orgId of orgIds) {
        const current = await this.getWorkspaceWorkerStatus(name, orgId);
        if (current?.status === "online") {
          continue;
        }

        try {
          await this.startWorkspaceWorker(name, orgId);
          console.log(`Recovered ${name} worker for workspace ${orgId}`);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `Could not recover ${name} worker for workspace ${orgId}: ${message}`
          );
        }
      }
    }
  }

  async restartWorker(name: string): Promise<void> {
    if (!this.isValidWorker(name)) {
      throw new Error(`Unknown worker: ${name}`);
    }

    await this.startWorker(name);
  }

  private pm2ProcessToInfo(
    match: Pm2ProcessDescription | undefined
  ): WorkerProcessInfo {
    if (!match) {
      return {
        cpuPercent: null,
        managed: true,
        memoryMb: null,
        status: "stopped",
        uptimeSeconds: null,
      };
    }

    const status = match.pm2_env?.status ?? null;
    const mappedStatus: WorkerProcessInfo["status"] =
      status === "online" || status === "stopped" || status === "errored"
        ? status
        : null;

    return {
      cpuPercent: match.monit?.cpu ?? null,
      managed: true,
      memoryMb: match.monit
        ? Math.round((match.monit.memory / 1024 / 1024) * 100) / 100
        : null,
      status: mappedStatus,
      uptimeSeconds: match.pm2_env?.pm_uptime
        ? Math.round((Date.now() - match.pm2_env.pm_uptime) / 1000)
        : null,
    };
  }

  private pm2UnavailableInfo(): WorkerProcessInfo {
    return {
      cpuPercent: null,
      managed: false,
      memoryMb: null,
      status: null,
      uptimeSeconds: null,
    };
  }

  async getWorkerStatus(name: string): Promise<WorkerProcessInfo | null> {
    if (!this.isValidWorker(name)) {
      return null;
    }

    if (this.isPm2Injected) {
      try {
        const list = await this.listAllPm2Processes();
        const match = list.find((p) => p.name === name);
        return this.pm2ProcessToInfo(match);
      } catch {
        return this.pm2UnavailableInfo();
      }
    }

    const state = await this.readNativeProcessState(name);
    const alive = state ? isProcessAlive(state.pid) : false;
    const resources =
      alive && state
        ? await readNativeProcessResources(state.pid)
        : { cpuPercent: null, memoryMb: null };

    return {
      cpuPercent: resources.cpuPercent,
      managed: true,
      memoryMb: resources.memoryMb,
      status: alive ? "online" : "stopped",
      uptimeSeconds:
        alive && state?.startedAt
          ? Math.max(0, Math.round((Date.now() - state.startedAt) / 1000))
          : null,
    };
  }

  async getAllWorkerStatuses(): Promise<Record<string, WorkerProcessInfo>> {
    if (this.isPm2Injected) {
      try {
        const list = await this.listAllPm2Processes();

        return Object.fromEntries(
          VALID_WORKERS.map((name) => {
            const match = list.find((p) => p.name === name);
            return [name, this.pm2ProcessToInfo(match)];
          })
        );
      } catch {
        return Object.fromEntries(
          VALID_WORKERS.map((name) => [name, this.pm2UnavailableInfo()])
        );
      }
    }

    const entries = await Promise.all(
      VALID_WORKERS.map(async (name) => {
        const status = await this.getWorkerStatus(name);
        return [
          name,
          status ?? {
            cpuPercent: null,
            managed: true,
            memoryMb: null,
            status: "stopped",
            uptimeSeconds: null,
          },
        ] as const;
      })
    );

    return Object.fromEntries(entries);
  }

  async getWorkspaceWorkerStatus(
    name: WorkspaceWorkerName,
    orgId: string
  ): Promise<WorkerProcessInfo | null> {
    const processName = workspaceWorkerProcessName(
      name,
      validateWorkspaceId(orgId)
    );

    if (this.isPm2Injected) {
      return this.getPm2ProcessStatus(processName);
    }

    const state = await this.readNativeProcessState(processName);
    const alive = state ? isProcessAlive(state.pid) : false;
    const resources =
      alive && state
        ? await readNativeProcessResources(state.pid)
        : { cpuPercent: null, memoryMb: null };

    return {
      cpuPercent: resources.cpuPercent,
      managed: true,
      memoryMb: resources.memoryMb,
      status: alive ? "online" : "stopped",
      uptimeSeconds:
        alive && state?.startedAt
          ? Math.max(0, Math.round((Date.now() - state.startedAt) / 1000))
          : null,
    };
  }

  async getWorkerLogs(
    name: string,
    lines: number,
    orgId?: string
  ): Promise<WorkerLogsResponse> {
    if (!this.isValidWorker(name)) {
      throw new Error(`Unknown worker: ${name}`);
    }

    const processName =
      orgId && this.isWorkspaceWorker(name)
        ? workspaceWorkerProcessName(name, validateWorkspaceId(orgId))
        : name;

    if (this.isPm2Injected) {
      return this.withPm2(async (pm2) => {
        const descriptions = await promisifyPm2<Pm2ProcessDescription[]>((cb) =>
          pm2.describe(processName, cb)
        );
        const desc = descriptions[0];
        const outPath = desc?.pm2_env?.pm_out_log_path as string | undefined;
        const errPath = desc?.pm2_env?.pm_err_log_path as string | undefined;

        const [stdout, stderr] = await Promise.all([
          outPath ? readLastLines(outPath, lines) : "",
          errPath ? readLastLines(errPath, lines) : "",
        ]);

        return { stderr, stdout, worker: name };
      });
    }

    const { outPath, errPath } = this.getLogPaths(processName);
    const [stdout, stderr] = await Promise.all([
      readLastLines(outPath, lines),
      readLastLines(errPath, lines),
    ]);

    return { stderr, stdout, worker: name };
  }

  async clearWorkerLogs(name: string, orgId?: string): Promise<void> {
    if (!this.isValidWorker(name)) {
      throw new Error(`Unknown worker: ${name}`);
    }

    const processName =
      orgId && this.isWorkspaceWorker(name)
        ? workspaceWorkerProcessName(name, validateWorkspaceId(orgId))
        : name;

    if (this.isPm2Injected) {
      await this.withPm2(async (pm2) => {
        await promisifyPm2<void>((cb) => pm2.flush(processName, cb));
      });
      return;
    }

    const { outPath, errPath } = this.getLogPaths(processName);
    await Promise.all([
      clearPrivateWorkerLog(outPath).catch(() => {}),
      clearPrivateWorkerLog(errPath).catch(() => {}),
    ]);
  }

  private async listAllPm2Processes(): Promise<Pm2ProcessDescription[]> {
    return this.withPm2(async (pm2) =>
      promisifyPm2<Pm2ProcessDescription[]>((cb) => pm2.list(cb))
    );
  }

  private async getPm2ProcessStatus(
    processName: string
  ): Promise<WorkerProcessInfo | null> {
    try {
      const list = await this.listAllPm2Processes();
      return this.pm2ProcessToInfo(
        list.find((process) => process.name === processName)
      );
    } catch {
      return null;
    }
  }

  private async workerProcessEnv(
    orgId?: string,
    channel?: WorkspaceWorkerName
  ): Promise<Record<string, string>> {
    const hostEnv = process.env as Record<string, string | undefined>;
    const env: Record<string, string> = orgId
      ? pickAllowedEnvironment(hostEnv, WORKSPACE_WORKER_ENV_ALLOWLIST)
      : { ...(hostEnv as Record<string, string>) };
    env.NODE_ENV = process.env.NODE_ENV ?? "development";
    delete env[WORKSPACE_WORKER_AUTH_TOKEN_ENV];
    delete env.ATLAS_WORKSPACE_ID;

    const serverUrl =
      process.env.ATLAS_SERVER_URL?.trim() ||
      process.env.atlas_SERVER_URL?.trim() ||
      readRuntimeServerUrl() ||
      "";

    if (serverUrl) {
      env.ATLAS_SERVER_URL = serverUrl;
    }

    const configDir = process.env.ATLAS_CONFIG_DIR?.trim();
    if (configDir) {
      env.ATLAS_CONFIG_DIR = configDir;
    }

    if (orgId) {
      if (!channel) {
        throw new Error("Workspace worker channel is required.");
      }
      env.ATLAS_WORKSPACE_ID = orgId;
      for (const key of WORKSPACE_WORKER_ENV_BLOCKLIST) {
        delete env[key];
      }
      env[WORKSPACE_WORKER_AUTH_TOKEN_ENV] =
        await createWorkspaceWorkerAuthToken({ channel, orgId });
    }

    return env;
  }
}

async function readNativeProcessResources(
  pid: number
): Promise<NativeProcessResources> {
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    return { cpuPercent: null, memoryMb: null };
  }

  const procResources = await readLinuxProcResources(pid);
  if (procResources) {
    return procResources;
  }

  return readPsResources(pid);
}

async function readLinuxProcResources(
  pid: number
): Promise<NativeProcessResources | null> {
  try {
    const [processStat, processStatus, systemStat] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/status`, "utf8"),
      readFile("/proc/stat", "utf8"),
    ]);
    const closingNameIndex = processStat.lastIndexOf(")");
    if (closingNameIndex < 0) {
      return null;
    }
    const processFields = processStat
      .slice(closingNameIndex + 1)
      .trim()
      .split(/\s+/);
    const userTicks = Number(processFields[11]);
    const systemTicks = Number(processFields[12]);
    const startedAtTicks = Number(processFields[19]);
    const cpuLine = systemStat.split("\n")[0]?.trim().split(/\s+/) ?? [];
    const aggregateTicks = cpuLine
      .slice(1, 9)
      .reduce((sum, value) => sum + Number(value), 0);
    const cpuCount = Math.max(
      1,
      systemStat.split("\n").filter((line) => /^cpu\d+\s/.test(line)).length
    );
    const processTicks = userTicks + systemTicks;
    const cpuPercent = sampleLinuxCpuPercent(pid, {
      aggregateTicks,
      cpuCount,
      processStartTicks: startedAtTicks,
      processTicks,
    });
    const residentKb = Number(
      /^VmRSS:\s+(\d+)\s+kB$/m.exec(processStatus)?.[1]
    );
    const memoryMb = Number.isFinite(residentKb)
      ? roundResourceValue(residentKb / 1024)
      : null;

    return { cpuPercent, memoryMb };
  } catch {
    return null;
  }
}

function sampleLinuxCpuPercent(
  pid: number,
  current: LinuxCpuSample
): number | null {
  const previous = linuxCpuSamples.get(pid);
  linuxCpuSamples.delete(pid);
  linuxCpuSamples.set(pid, current);
  while (linuxCpuSamples.size > MAX_NATIVE_CPU_SAMPLES) {
    const oldestPid = linuxCpuSamples.keys().next().value;
    if (typeof oldestPid !== "number") {
      break;
    }
    linuxCpuSamples.delete(oldestPid);
  }

  if (!previous) {
    return null;
  }

  return calculateSampledCpuPercent(previous, current);
}

export function calculateSampledCpuPercent(
  previous: LinuxCpuSample,
  current: LinuxCpuSample
): number | null {
  if (
    previous.processStartTicks !== current.processStartTicks ||
    !Number.isFinite(current.processTicks) ||
    !Number.isFinite(current.aggregateTicks)
  ) {
    return null;
  }

  const processTickDelta = current.processTicks - previous.processTicks;
  const systemTickDelta =
    current.aggregateTicks / current.cpuCount -
    previous.aggregateTicks / previous.cpuCount;
  if (processTickDelta < 0 || systemTickDelta <= 0) {
    return null;
  }

  return roundResourceValue((processTickDelta / systemTickDelta) * 100);
}

function readPsResources(pid: number): Promise<NativeProcessResources> {
  return new Promise((resolve) => {
    try {
      execFile(
        "ps",
        ["-o", "%cpu=", "-o", "rss=", "-p", String(pid)],
        { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 2000 },
        (error, stdout) => {
          if (error) {
            resolve({ cpuPercent: null, memoryMb: null });
            return;
          }
          const [cpuRaw, residentKbRaw] = stdout.trim().split(/\s+/);
          const cpu = Number(cpuRaw);
          const residentKb = Number(residentKbRaw);
          resolve({
            cpuPercent: Number.isFinite(cpu) ? roundResourceValue(cpu) : null,
            memoryMb: Number.isFinite(residentKb)
              ? roundResourceValue(residentKb / 1024)
              : null,
          });
        }
      );
    } catch {
      resolve({ cpuPercent: null, memoryMb: null });
    }
  });
}

function roundResourceValue(value: number): number {
  return Math.round(value * 100) / 100;
}

function pickAllowedEnvironment(
  source: Record<string, string | undefined>,
  keys: readonly string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function validateWorkspaceId(orgId: string): string {
  const trimmed = orgId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error("Invalid workspace id.");
  }
  return trimmed;
}

function workspaceWorkerProcessName(
  name: WorkspaceWorkerName,
  orgId: string
): string {
  return `${name}--${orgId}`;
}

async function readLastLines(path: string, lineCount: number): Promise<string> {
  const normalizedLineCount =
    Number.isInteger(lineCount) && lineCount > 0
      ? Math.min(lineCount, 2000)
      : 200;
  const maxTailBytes = 4 * 1024 * 1024;
  const chunkBytes = 64 * 1024;
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(path, "r");
    const { size } = await handle.stat();
    let position = size;
    let bufferedBytes = 0;
    let newlineCount = 0;
    const chunks: Buffer[] = [];

    while (
      position > 0 &&
      bufferedBytes < maxTailBytes &&
      newlineCount <= normalizedLineCount
    ) {
      const bytesToRead = Math.min(
        chunkBytes,
        position,
        maxTailBytes - bufferedBytes
      );
      position -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bufferedBytes += bytesRead;
      for (const byte of chunk) {
        if (byte === 10) {
          newlineCount += 1;
        }
      }
    }

    const content = Buffer.concat(chunks, bufferedBytes).toString("utf8");
    const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
    const allLines = trimmed.split("\n");
    const lastLines = allLines.slice(-normalizedLineCount);
    return lastLines.join("\n");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface Pm2ProcessDescription {
  monit?: { cpu: number; memory: number };
  name?: string;
  pid?: number;
  pm_id?: number;
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    pm_out_log_path?: string;
    pm_err_log_path?: string;
    [key: string]: unknown;
  };
}
