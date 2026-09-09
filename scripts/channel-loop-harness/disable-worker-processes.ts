import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkerManagerService } from "../../apps/server/src/services/worker-manager-service";

const configDir = process.env.ATLAS_CONFIG_DIR;
if (
  !(
    configDir &&
    process.env.ATLAS_ENV === "e2e" &&
    process.env.NODE_ENV === "test"
  )
) {
  throw new Error(
    "The channel-loop worker boundary requires its isolated test runtime."
  );
}
const marker = JSON.parse(
  await readFile(join(configDir, ".channel-loop-mock-runtime.json"), "utf8")
) as { configDir?: string; runtime?: string };
if (
  marker.runtime !== "CHANNEL_LOOP_SYNTHETIC" ||
  marker.configDir !== configDir
) {
  throw new Error(
    "The channel-loop worker boundary requires its exact fixture marker."
  );
}

// Applied only by the explicit preload in this disposable server subprocess.
// Its real HTTP/Identity/DB/agent services remain intact. No fake bot may dial out.
WorkerManagerService.prototype.recoverDesiredWorkers = async () => {};
WorkerManagerService.prototype.startWorker = async () => {
  throw new Error(
    "Worker process starts are disabled in the mocked channel-loop harness."
  );
};
WorkerManagerService.prototype.startWorkspaceWorker = async () => {
  throw new Error(
    "Workspace worker starts are disabled in the mocked channel-loop harness."
  );
};
console.log("CHANNEL_LOOP_WORKER_PROCESSES_DISABLED");
