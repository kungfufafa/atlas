import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWorkerDesiredState,
  setWorkerDesiredRunning,
  verifyWorkspaceWorkerAuthToken,
  WORKSPACE_WORKER_AUTH_TOKEN_ENV,
  type WorkerProcessInfo,
} from "@atlas/core";
import {
  calculateSampledCpuPercent,
  WorkerManagerService,
} from "./worker-manager-service";

function createMockPm2() {
  const mockPm2 = {
    connect: mock((cb: (err: Error | null) => void) => cb(null)),
    delete: mock((_name: string, cb: (err: Error | null) => void) => cb(null)),
    describe: mock(
      (_name: string, cb: (err: Error | null, list: unknown[]) => void) =>
        cb(null, [])
    ),
    disconnect: mock(() => {}),
    flush: mock((_name: string, cb: (err: Error | null) => void) => cb(null)),
    list: mock((cb: (err: Error | null, list: unknown[]) => void) =>
      cb(null, [])
    ),
    restart: mock((_name: string, cb: (err: Error | null) => void) => cb(null)),
    start: mock((_opts: unknown, cb: (err: Error | null) => void) => cb(null)),
    stop: mock((_name: string, cb: (err: Error | null) => void) => cb(null)),
  };

  return mockPm2 as unknown as typeof import("pm2");
}

async function readCapturedEnvironment(
  filePath: string
): Promise<Record<string, string>> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as Record<
        string,
        string
      >;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for the native worker environment.");
}

async function readWorkspaceWorkerStatusAfterStartup(
  service: WorkerManagerService,
  worker: "whatsapp",
  workspaceId: string
): Promise<WorkerProcessInfo | null> {
  let status = await service.getWorkspaceWorkerStatus(worker, workspaceId);
  if (process.platform !== "linux") {
    return status;
  }

  const deadline = Date.now() + 2000;
  while ((status?.memoryMb ?? 0) <= 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    status = await service.getWorkspaceWorkerStatus(worker, workspaceId);
  }
  return status;
}

const projectRoot = "/tmp/test-project";
let configDir: string | null = null;
let previousDoNotTrack: string | undefined;
let previousErrorTrackingDsn: string | undefined;

beforeEach(async () => {
  previousDoNotTrack = process.env.DO_NOT_TRACK;
  previousErrorTrackingDsn = process.env.ATLAS_ERROR_TRACKING_DSN;
  configDir = await mkdtemp(join(tmpdir(), "atlas-worker-manager-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (configDir) {
    await rm(configDir, { force: true, recursive: true });
    configDir = null;
  }

  delete process.env.ATLAS_CONFIG_DIR;
  delete process.env.ATLAS_LOCAL_AUTH_TOKEN;
  delete process.env.CODEX_HOME;
  delete process.env.OPENAI_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  restoreEnvironment("DO_NOT_TRACK", previousDoNotTrack);
  restoreEnvironment("ATLAS_ERROR_TRACKING_DSN", previousErrorTrackingDsn);
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

describe("WorkerManagerService", () => {
  describe("isValidWorker", () => {
    test("returns true for telegram", () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.isValidWorker("telegram")).toBe(true);
    });

    test("returns true for whatsapp", () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.isValidWorker("whatsapp")).toBe(true);
    });

    test("returns true for automation", () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.isValidWorker("automation")).toBe(true);
    });

    test("returns true for discord", () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.isValidWorker("discord")).toBe(true);
    });

    test("returns false for unknown worker", () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.isValidWorker("foobar")).toBe(false);
    });
  });

  describe("startWorker", () => {
    test("starts an isolated worker for one workspace", async () => {
      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(projectRoot, mockPm2);
      process.env.TELEGRAM_BOT_TOKEN = "host-wide-token";
      process.env.ATLAS_LOCAL_AUTH_TOKEN = "tc_local_host_secret";
      process.env.ATLAS_ERROR_TRACKING_DSN =
        "https://worker-secret@example.com/1";
      process.env.CODEX_HOME = "/tmp/host-codex-secrets";
      process.env.DO_NOT_TRACK = "1";
      process.env.OPENAI_API_KEY = "sk-host-secret";

      await service.startWorkspaceWorker("telegram", "workspace-a");

      expect(mockPm2.stop).toHaveBeenCalledWith(
        "telegram--workspace-a",
        expect.any(Function)
      );
      const opts = (mockPm2.start as ReturnType<typeof mock>).mock.calls[0][0];
      expect(opts.name).toBe("telegram--workspace-a");
      expect(opts.env.ATLAS_WORKSPACE_ID).toBe("workspace-a");
      expect(opts.env.ATLAS_LOCAL_AUTH_TOKEN).toBeUndefined();
      expect(opts.env.ATLAS_ERROR_TRACKING_DSN).toBeUndefined();
      expect(opts.env.CODEX_HOME).toBeUndefined();
      expect(opts.env.DO_NOT_TRACK).toBe("1");
      expect(opts.env.OPENAI_API_KEY).toBeUndefined();
      expect(opts.env[WORKSPACE_WORKER_AUTH_TOKEN_ENV]).toStartWith(
        "tc_worker_v1_"
      );
      await expect(
        verifyWorkspaceWorkerAuthToken(
          opts.env[WORKSPACE_WORKER_AUTH_TOKEN_ENV]
        )
      ).resolves.toEqual({ channel: "telegram", orgId: "workspace-a" });
      expect(opts.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(opts.args).toContain("apps/platform/telegram/src/index.ts");
    });

    test("starts telegram worker with correct script path", async () => {
      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(projectRoot, mockPm2);
      process.env.ATLAS_LOCAL_AUTH_TOKEN = "tc_local_host_secret";

      await service.startWorker("telegram");

      expect(mockPm2.stop).toHaveBeenCalledWith(
        "telegram",
        expect.any(Function)
      );
      expect(mockPm2.delete).toHaveBeenCalledWith(
        "telegram",
        expect.any(Function)
      );
      expect(mockPm2.start).toHaveBeenCalledTimes(1);
      const opts = (mockPm2.start as ReturnType<typeof mock>).mock.calls[0][0];
      expect(opts.script).toBe("bun");
      expect(opts.args).toContain("apps/platform/telegram/src/index.ts");
      expect(opts.interpreter).toBeUndefined();
      expect(opts.name).toBe("telegram");
      expect(opts.env.ATLAS_LOCAL_AUTH_TOKEN).toBe("tc_local_host_secret");
      expect(opts.env[WORKSPACE_WORKER_AUTH_TOKEN_ENV]).toBeUndefined();
      expect(await readWorkerDesiredState()).toEqual({
        automation: true,
        discord: false,
        telegram: true,
        whatsapp: false,
      });
    });

    test("starts whatsapp worker", async () => {
      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(projectRoot, mockPm2);

      await service.startWorker("whatsapp");

      expect(mockPm2.start).toHaveBeenCalledTimes(1);
      const opts = (mockPm2.start as ReturnType<typeof mock>).mock.calls[0][0];
      expect(opts.name).toBe("whatsapp");
      expect(opts.script).toBe("bun");
      expect(opts.args).toContain("apps/platform/whatsapp/src/index.ts");
      expect(opts.interpreter).toBeUndefined();
    });

    test("starts automation worker", async () => {
      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(projectRoot, mockPm2);

      await service.startWorker("automation");

      expect(mockPm2.start).toHaveBeenCalledTimes(1);
      const opts = (mockPm2.start as ReturnType<typeof mock>).mock.calls[0][0];
      expect(opts.name).toBe("automation");
      expect(opts.script).toBe("bun");
      expect(opts.args).toContain("apps/platform/automation/src/index.ts");
      expect(opts.interpreter).toBeUndefined();
      expect(await readWorkerDesiredState()).toEqual({
        automation: true,
        discord: false,
        telegram: false,
        whatsapp: false,
      });
    });

    test("starts worker from dist when dist build exists", async () => {
      const tmpProjectRoot = await mkdtemp(
        join(tmpdir(), "atlas-worker-dist-")
      );
      const distFilePath = join(
        tmpProjectRoot,
        "apps/platform/whatsapp/dist/index.js"
      );
      await mkdir(join(tmpProjectRoot, "apps/platform/whatsapp/dist"), {
        recursive: true,
      });
      await writeFile(distFilePath, "console.log('ok')");

      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(tmpProjectRoot, mockPm2);

      await service.startWorker("whatsapp");

      const opts = (mockPm2.start as ReturnType<typeof mock>).mock.calls[0][0];
      expect(opts.args).toContain("apps/platform/whatsapp/dist/index.js");

      await rm(tmpProjectRoot, { force: true, recursive: true });
    });

    test("starts telegram worker from dist when dist build exists", async () => {
      const tmpProjectRoot = await mkdtemp(
        join(tmpdir(), "atlas-worker-dist-")
      );
      const distFilePath = join(
        tmpProjectRoot,
        "apps/platform/telegram/dist/index.js"
      );
      await mkdir(join(tmpProjectRoot, "apps/platform/telegram/dist"), {
        recursive: true,
      });
      await writeFile(distFilePath, "console.log('ok')");

      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(tmpProjectRoot, mockPm2);

      await service.startWorker("telegram");

      const opts = (mockPm2.start as ReturnType<typeof mock>).mock.calls[0][0];
      expect(opts.args).toContain("apps/platform/telegram/dist/index.js");

      await rm(tmpProjectRoot, { force: true, recursive: true });
    });

    test("starts automation worker from dist when dist build exists", async () => {
      const tmpProjectRoot = await mkdtemp(
        join(tmpdir(), "atlas-worker-dist-")
      );
      const distFilePath = join(
        tmpProjectRoot,
        "apps/platform/automation/dist/index.js"
      );
      await mkdir(join(tmpProjectRoot, "apps/platform/automation/dist"), {
        recursive: true,
      });
      await writeFile(distFilePath, "console.log('ok')");

      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(tmpProjectRoot, mockPm2);

      await service.startWorker("automation");

      const opts = (mockPm2.start as ReturnType<typeof mock>).mock.calls[0][0];
      expect(opts.args).toContain("apps/platform/automation/dist/index.js");

      await rm(tmpProjectRoot, { force: true, recursive: true });
    });

    test("throws for unknown worker", async () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.startWorker("foobar")).rejects.toThrow("Unknown worker");
    });

    test("throws when PM2 start fails", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.start = mock((_opts: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("PM2 start failed"))
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      expect(service.startWorker("telegram")).rejects.toThrow(
        "PM2 start failed"
      );
    });
  });

  describe("stopWorker", () => {
    test("stops worker by name", async () => {
      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(projectRoot, mockPm2);

      await service.stopWorker("telegram");

      expect(mockPm2.stop).toHaveBeenCalledWith(
        "telegram",
        expect.any(Function)
      );
      expect(await readWorkerDesiredState()).toEqual({
        automation: true,
        discord: false,
        telegram: false,
        whatsapp: false,
      });
    });

    test("throws for unknown worker", async () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.stopWorker("foobar")).rejects.toThrow("Unknown worker");
    });
  });

  describe("restartWorker", () => {
    test("restarts worker by removing from pm2 and starting fresh", async () => {
      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(projectRoot, mockPm2);

      await service.restartWorker("telegram");

      expect(mockPm2.stop).toHaveBeenCalledWith(
        "telegram",
        expect.any(Function)
      );
      expect(mockPm2.delete).toHaveBeenCalledWith(
        "telegram",
        expect.any(Function)
      );
      expect(mockPm2.restart).not.toHaveBeenCalled();
      expect(mockPm2.start).toHaveBeenCalledTimes(1);
    });

    test("throws for unknown worker", async () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.restartWorker("foobar")).rejects.toThrow("Unknown worker");
    });
  });

  describe("getWorkerStatus", () => {
    test("returns managed status for running worker", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.list = mock((cb: (err: Error | null, list: unknown[]) => void) =>
        cb(null, [
          {
            monit: { cpu: 2.5, memory: 45_000_000 },
            name: "telegram",
            pid: 1234,
            pm2_env: { pm_uptime: Date.now() - 60_000, status: "online" },
          },
        ])
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      const status = await service.getWorkerStatus("telegram");

      expect(status).toEqual({
        cpuPercent: 2.5,
        managed: true,
        memoryMb: 42.92,
        status: "online",
        uptimeSeconds: expect.any(Number),
      });
    });

    test("returns managed: true / stopped when worker not in PM2 list", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.list = mock((cb: (err: Error | null, list: unknown[]) => void) =>
        cb(null, [])
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      const status = await service.getWorkerStatus("telegram");

      expect(status).toEqual({
        cpuPercent: null,
        managed: true,
        memoryMb: null,
        status: "stopped",
        uptimeSeconds: null,
      });
    });

    test("returns managed: false when PM2 connect fails", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.connect = mock((cb: (err: Error | null) => void) =>
        cb(new Error("PM2 daemon not running"))
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      const status = await service.getWorkerStatus("telegram");

      expect(status).toEqual({
        cpuPercent: null,
        managed: false,
        memoryMb: null,
        status: null,
        uptimeSeconds: null,
      });
    });

    test("returns null for unknown worker", async () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      const status = await service.getWorkerStatus("foobar");
      expect(status).toBeNull();
    });
  });

  describe("getAllWorkerStatuses", () => {
    test("returns managed true for stopped workers when PM2 is available", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.list = mock((cb: (err: Error | null, list: unknown[]) => void) =>
        cb(null, [
          {
            monit: { cpu: 3.1, memory: 60_000_000 },
            name: "telegram",
            pm2_env: { pm_uptime: Date.now() - 120_000, status: "online" },
          },
        ])
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      const result = await service.getAllWorkerStatuses();

      expect(mockPm2.list).toHaveBeenCalledTimes(1);
      expect(result.telegram.managed).toBe(true);
      expect(result.telegram.status).toBe("online");
      expect(result.telegram.cpuPercent).toBe(3.1);
      expect(result.whatsapp.managed).toBe(true);
      expect(result.whatsapp.status).toBe("stopped");
    });

    test("returns managed: false for all when PM2 connect fails", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.connect = mock((cb: (err: Error | null) => void) =>
        cb(new Error("connect failed"))
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      const result = await service.getAllWorkerStatuses();

      expect(result.telegram.managed).toBe(false);
      expect(result.whatsapp.managed).toBe(false);
    });
  });

  describe("getWorkerLogs", () => {
    test("returns last N lines of stdout and stderr", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "atlas-logs-"));
      const outPath = join(tmpDir, "out.log");
      const errPath = join(tmpDir, "err.log");
      await writeFile(outPath, "line1\nline2\nline3\nline4\nline5\n");
      await writeFile(errPath, "err1\nerr2\nerr3\n");

      const mockPm2 = createMockPm2();
      mockPm2.describe = mock(
        (_name: string, cb: (err: Error | null, list: unknown[]) => void) =>
          cb(null, [
            {
              name: "whatsapp",
              pm2_env: {
                pm_err_log_path: errPath,
                pm_out_log_path: outPath,
              },
            },
          ])
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      const logs = await service.getWorkerLogs("whatsapp", 2);

      expect(logs.stdout).toBe("line4\nline5");
      expect(logs.stderr).toBe("err2\nerr3");

      await unlink(outPath);
      await unlink(errPath);
    });

    test("returns empty strings when log files are missing", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.describe = mock(
        (_name: string, cb: (err: Error | null, list: unknown[]) => void) =>
          cb(null, [
            {
              name: "whatsapp",
              pm2_env: {
                pm_err_log_path: "/nonexistent/err.log",
                pm_out_log_path: "/nonexistent/out.log",
              },
            },
          ])
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      const logs = await service.getWorkerLogs("whatsapp", 10);

      expect(logs.stdout).toBe("");
      expect(logs.stderr).toBe("");
    });

    test("returns empty strings when pm2_env has no log paths", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.describe = mock(
        (_name: string, cb: (err: Error | null, list: unknown[]) => void) =>
          cb(null, [
            {
              name: "whatsapp",
              pm2_env: {},
            },
          ])
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      const logs = await service.getWorkerLogs("whatsapp", 10);

      expect(logs.stdout).toBe("");
      expect(logs.stderr).toBe("");
    });

    test("throws for unknown worker", async () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.getWorkerLogs("foobar", 10)).rejects.toThrow(
        "Unknown worker"
      );
    });

    test("throws when PM2 describe fails", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.describe = mock(
        (_name: string, cb: (err: Error | null, list: unknown[]) => void) =>
          cb(new Error("PM2 describe failed"))
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      expect(service.getWorkerLogs("whatsapp", 10)).rejects.toThrow(
        "PM2 describe failed"
      );
    });
  });

  describe("recoverDesiredWorkers", () => {
    test("starts workers marked as desired when they are not online", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.list = mock((cb: (err: Error | null, list: unknown[]) => void) =>
        cb(null, [])
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      await setWorkerDesiredRunning("automation", false);
      await setWorkerDesiredRunning("telegram", true);
      await service.recoverDesiredWorkers();

      expect(mockPm2.start).toHaveBeenCalledTimes(1);
    });

    test("recovers automation worker when desired", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.list = mock((cb: (err: Error | null, list: unknown[]) => void) =>
        cb(null, [])
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      await setWorkerDesiredRunning("automation", true);
      await service.recoverDesiredWorkers();

      const calls = (mockPm2.start as ReturnType<typeof mock>).mock.calls;
      const opts = calls[0]?.[0];
      expect(opts?.name).toBe("automation");
    });

    test("skips workers that are already online", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.list = mock((cb: (err: Error | null, list: unknown[]) => void) =>
        cb(null, [
          {
            monit: { cpu: 1, memory: 1_000_000 },
            name: "telegram",
            pm2_env: { pm_uptime: Date.now(), status: "online" },
          },
        ])
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      await setWorkerDesiredRunning("automation", false);
      await setWorkerDesiredRunning("telegram", true);
      await service.recoverDesiredWorkers();

      expect(mockPm2.start).not.toHaveBeenCalled();
    });
  });

  describe("clearWorkerLogs", () => {
    test("flushes logs for a valid worker", async () => {
      const mockPm2 = createMockPm2();
      const service = new WorkerManagerService(projectRoot, mockPm2);

      await service.clearWorkerLogs("whatsapp");

      expect(mockPm2.flush).toHaveBeenCalledWith(
        "whatsapp",
        expect.any(Function)
      );
    });

    test("throws for unknown worker", async () => {
      const service = new WorkerManagerService(projectRoot, createMockPm2());
      expect(service.clearWorkerLogs("foobar")).rejects.toThrow(
        "Unknown worker"
      );
    });

    test("throws when PM2 flush fails", async () => {
      const mockPm2 = createMockPm2();
      mockPm2.flush = mock((_name: string, cb: (err: Error | null) => void) =>
        cb(new Error("PM2 flush failed"))
      );
      const service = new WorkerManagerService(projectRoot, mockPm2);

      expect(service.clearWorkerLogs("whatsapp")).rejects.toThrow(
        "PM2 flush failed"
      );
    });
  });

  describe("Native process management (without PM2)", () => {
    test("returns managed: true and stopped status by default", async () => {
      const service = new WorkerManagerService(projectRoot);

      const status = await service.getWorkerStatus("telegram");
      expect(status).toEqual({
        cpuPercent: null,
        managed: true,
        memoryMb: null,
        status: "stopped",
        uptimeSeconds: null,
      });
    });

    test("returns managed: true for all workers in getAllWorkerStatuses", async () => {
      const service = new WorkerManagerService(projectRoot);

      const statuses = await service.getAllWorkerStatuses();
      expect(statuses.telegram?.managed).toBe(true);
      expect(statuses.telegram?.status).toBe("stopped");
      expect(statuses.whatsapp?.managed).toBe(true);
      expect(statuses.automation?.managed).toBe(true);
      expect(statuses.discord?.managed).toBe(true);
    });

    test("reads and clears native logs", async () => {
      const service = new WorkerManagerService(projectRoot);
      const logDir = join(configDir!, "logs", "workers");
      await mkdir(logDir, { recursive: true });
      await writeFile(join(logDir, "telegram.out.log"), "hello\nworld\n");
      await writeFile(join(logDir, "telegram.err.log"), "warn\nerror\n");

      const logs = await service.getWorkerLogs("telegram", 5);
      expect(logs.stdout).toBe("hello\nworld");
      expect(logs.stderr).toBe("warn\nerror");

      await service.clearWorkerLogs("telegram");
      const clearedLogs = await service.getWorkerLogs("telegram", 5);
      expect(clearedLogs.stdout).toBe("");
      expect(clearedLogs.stderr).toBe("");
    });

    test("reads and clears native logs for workspace worker", async () => {
      const service = new WorkerManagerService(projectRoot);
      const logDir = join(configDir!, "logs", "workers");
      await mkdir(logDir, { recursive: true });
      await writeFile(
        join(logDir, "whatsapp--org_test.out.log"),
        "ws line 1\nws line 2\n"
      );
      await writeFile(join(logDir, "whatsapp--org_test.err.log"), "ws err 1\n");

      const logs = await service.getWorkerLogs("whatsapp", 5, "org_test");
      expect(logs.stdout).toBe("ws line 1\nws line 2");
      expect(logs.stderr).toBe("ws err 1");

      await service.clearWorkerLogs("whatsapp", "org_test");
      const clearedLogs = await service.getWorkerLogs(
        "whatsapp",
        5,
        "org_test"
      );
      expect(clearedLogs.stdout).toBe("");
      expect(clearedLogs.stderr).toBe("");
    });

    test("never falls back to legacy logs for an empty workspace log", async () => {
      const service = new WorkerManagerService(projectRoot);
      const logDir = join(configDir!, "logs", "workers");
      await mkdir(logDir, { recursive: true });
      await writeFile(join(logDir, "whatsapp.out.log"), "other workspace\n");

      const logs = await service.getWorkerLogs("whatsapp", 5, "org_empty");

      expect(logs.stdout).toBe("");
      expect(logs.stderr).toBe("");
    });

    test("normalizes invalid log line counts", async () => {
      const service = new WorkerManagerService(projectRoot);
      const logDir = join(configDir!, "logs", "workers");
      await mkdir(logDir, { recursive: true });
      const lines = Array.from({ length: 250 }, (_, index) => `line-${index}`);
      await writeFile(
        join(logDir, "telegram.out.log"),
        `${lines.join("\n")}\n`
      );

      const logs = await service.getWorkerLogs("telegram", Number.NaN);

      expect(logs.stdout.split("\n")).toHaveLength(200);
      expect(logs.stdout.startsWith("line-50\n")).toBe(true);
    });

    test("passes the host privacy opt-out without its telemetry DSN", async () => {
      const tmpProject = await mkdtemp(
        join(tmpdir(), "atlas-native-env-test-")
      );
      const scriptPath = join(
        tmpProject,
        "apps/platform/whatsapp/src/index.ts"
      );
      const capturedEnvPath = join(tmpProject, "captured-env.json");
      await mkdir(join(tmpProject, "apps/platform/whatsapp/src"), {
        recursive: true,
      });
      await writeFile(
        scriptPath,
        `await Bun.write(${JSON.stringify(capturedEnvPath)}, JSON.stringify({ doNotTrack: process.env.DO_NOT_TRACK, dsn: process.env.ATLAS_ERROR_TRACKING_DSN })); setInterval(() => undefined, 1000);`
      );
      process.env.ATLAS_ERROR_TRACKING_DSN =
        "https://worker-secret@example.com/1";
      process.env.DO_NOT_TRACK = "yes";

      const service = new WorkerManagerService(tmpProject);
      try {
        await service.startWorkspaceWorker("whatsapp", "org_privacy");
        const capturedEnv = await readCapturedEnvironment(capturedEnvPath);

        expect(capturedEnv).toEqual({ doNotTrack: "yes" });
      } finally {
        await service.stopWorkspaceWorker("whatsapp", "org_privacy");
        await rm(tmpProject, { force: true, recursive: true });
      }
    });

    test("starts, restarts and stops a workspace worker natively", async () => {
      const tmpProject = await mkdtemp(join(tmpdir(), "atlas-native-ws-test-"));
      const scriptPath = join(
        tmpProject,
        "apps/platform/whatsapp/src/index.ts"
      );
      await mkdir(join(tmpProject, "apps/platform/whatsapp/src"), {
        recursive: true,
      });
      await writeFile(scriptPath, "setTimeout(() => {}, 10000);");

      const service = new WorkerManagerService(tmpProject);
      try {
        await service.startWorkspaceWorker("whatsapp", "org_test");

        const statusRunning = await readWorkspaceWorkerStatusAfterStartup(
          service,
          "whatsapp",
          "org_test"
        );
        expect(statusRunning?.managed).toBe(true);
        expect(statusRunning?.status).toBe("online");
        if (process.platform === "linux") {
          expect(statusRunning?.memoryMb).toBeGreaterThan(0);
        }

        await service.restartWorkspaceWorker("whatsapp", "org_test");
        const statusRestarted = await service.getWorkspaceWorkerStatus(
          "whatsapp",
          "org_test"
        );
        expect(statusRestarted?.status).toBe("online");

        await service.stopWorkspaceWorker("whatsapp", "org_test");

        const statusStopped = await service.getWorkspaceWorkerStatus(
          "whatsapp",
          "org_test"
        );
        expect(statusStopped?.managed).toBe(true);
        expect(statusStopped?.status).toBe("stopped");
      } finally {
        await service.stopWorkspaceWorker("whatsapp", "org_test");
        await rm(tmpProject, { force: true, recursive: true });
      }
    });

    test("starts and stops a worker natively", async () => {
      const tmpProject = await mkdtemp(join(tmpdir(), "atlas-native-test-"));
      const scriptPath = join(
        tmpProject,
        "apps/platform/telegram/src/index.ts"
      );
      await mkdir(join(tmpProject, "apps/platform/telegram/src"), {
        recursive: true,
      });
      await writeFile(scriptPath, "setTimeout(() => {}, 10000);");

      const service = new WorkerManagerService(tmpProject);
      await service.startWorker("telegram");

      const statusRunning = await service.getWorkerStatus("telegram");
      expect(statusRunning?.managed).toBe(true);
      expect(statusRunning?.status).toBe("online");

      await service.stopWorker("telegram");

      const statusStopped = await service.getWorkerStatus("telegram");
      expect(statusStopped?.managed).toBe(true);
      expect(statusStopped?.status).toBe("stopped");

      await rm(tmpProject, { force: true, recursive: true });
    });
  });

  test("calculates native CPU from successive samples instead of process lifetime", () => {
    expect(
      calculateSampledCpuPercent(
        {
          aggregateTicks: 10_000,
          cpuCount: 4,
          processStartTicks: 100,
          processTicks: 500,
        },
        {
          aggregateTicks: 10_400,
          cpuCount: 4,
          processStartTicks: 100,
          processTicks: 525,
        }
      )
    ).toBe(25);
  });
});
