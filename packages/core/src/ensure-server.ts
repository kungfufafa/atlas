import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATLAS_API_VERSION } from "./contract";
import { resolveServerUrl } from "./runtime";

const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;
const HEALTH_CHECK_TIMEOUT_MS = 2000;

export interface EnsureServerResult {
  serverUrl: string;
  spawnedChild: Bun.Subprocess | null;
}

export async function ensureServerRunning(
  options: { autoStart?: boolean; timeoutMs?: number } = {}
): Promise<EnsureServerResult> {
  const serverUrl = resolveServerUrl();

  if (await isServerHealthy(serverUrl)) {
    return { serverUrl, spawnedChild: null };
  }

  const timeoutMs = options.timeoutMs ?? STARTUP_TIMEOUT_MS;
  if (options.autoStart === false) {
    const readyUrl = await waitForServer(timeoutMs);
    if (!readyUrl) {
      throw new Error(
        `Atlas API is unavailable at ${serverUrl}. Start or repair the Atlas server; channel workers do not start an API process.`
      );
    }
    return { serverUrl: readyUrl, spawnedChild: null };
  }

  // An HTTP response proves something already owns this endpoint. Authentication,
  // deployment/version mismatch, or temporary readiness must never spawn a rival API.
  if (await serverEndpointResponds(serverUrl)) {
    throw new Error(
      `An unavailable or incompatible server already responds at ${serverUrl}. Check the existing Atlas server before retrying.`
    );
  }

  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const serverEntry = join(projectRoot, "apps/server/src/index.ts");
  const child = Bun.spawn(["bun", "run", serverEntry], {
    cwd: projectRoot,
    env: process.env,
    stderr: "inherit",
    stdin: "ignore",
    stdout: "inherit",
  });

  console.warn("Starting Atlas server...");

  const readyUrl = await waitForServer(timeoutMs);

  if (!readyUrl) {
    stopSpawnedServer(child);
    throw new Error(
      `Server failed to start within ${timeoutMs / 1000}s (${serverUrl})`
    );
  }

  if (child.exitCode !== null) {
    return { serverUrl: readyUrl, spawnedChild: null };
  }

  return { serverUrl: readyUrl, spawnedChild: child };
}

export function stopSpawnedServer(child: Bun.Subprocess | null): void {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill();
}

export async function serverHasTaskChat(
  serverUrl: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetch(
      `${serverUrl}/v1/tasks/__capability_probe__/messages`,
      {
        signal,
      }
    );

    if (response.status !== 404) {
      return false;
    }

    const payload = (await response.json()) as { error?: string };
    return payload.error === "Task not found.";
  } catch {
    return false;
  }
}

export async function isServerHealthy(serverUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    HEALTH_CHECK_TIMEOUT_MS
  );

  try {
    const response = await fetch(`${serverUrl}/health`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      apiVersion?: number;
    };

    // Readiness is public. Protected routes and per-org catalogs are not liveness
    // probes: worker credentials intentionally cannot enumerate global tools.
    return payload.ok === true && payload.apiVersion === ATLAS_API_VERSION;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function serverEndpointResponds(serverUrl: string): Promise<boolean> {
  try {
    await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const serverUrl = resolveServerUrl();

    if (await isServerHealthy(serverUrl)) {
      return serverUrl;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  return null;
}
