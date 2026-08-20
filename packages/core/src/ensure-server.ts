import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATLAS_API_VERSION } from "./contract";
import { loadLocalAuthToken } from "./local-auth";
import { resolveServerUrl } from "./runtime";

const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;
const HEALTH_CHECK_TIMEOUT_MS = 2000;

export interface EnsureServerResult {
  serverUrl: string;
  spawnedChild: Bun.Subprocess | null;
}

export async function ensureServerRunning(): Promise<EnsureServerResult> {
  const serverUrl = resolveServerUrl();

  if (await isServerHealthy(serverUrl)) {
    return { serverUrl, spawnedChild: null };
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

  const readyUrl = await waitForServer(STARTUP_TIMEOUT_MS);

  if (!readyUrl) {
    stopSpawnedServer(child);
    throw new Error(
      `Server failed to start within ${STARTUP_TIMEOUT_MS / 1000}s (${serverUrl})`
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

const REQUIRED_BUILTIN_TOOLS = [
  "write_file",
  "delete_file",
  "edit_file",
  "read_file",
  "search_files",
  "web_search",
] as const;

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

    if (payload.ok !== true || payload.apiVersion !== ATLAS_API_VERSION) {
      return false;
    }

    if (!(await serverHasTaskChat(serverUrl, controller.signal))) {
      return false;
    }

    return await serverHasRequiredBuiltinTools(serverUrl, controller.signal);
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function serverHasRequiredBuiltinTools(
  serverUrl: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const authHeaders = await localAuthHeaders();
    if (!authHeaders) {
      return false;
    }

    let toolsResponse = await fetch(`${serverUrl}/v1/tools`, {
      headers: authHeaders,
      signal,
    });

    if (toolsResponse.status === 400) {
      const orgId = await resolveLocalClientOrgId(
        serverUrl,
        authHeaders,
        signal
      );
      if (!orgId) {
        return false;
      }

      toolsResponse = await fetch(`${serverUrl}/v1/tools`, {
        headers: {
          ...authHeaders,
          "X-Org-Id": orgId,
        },
        signal,
      });
    }

    if (!toolsResponse.ok) {
      return false;
    }

    const toolsPayload = (await toolsResponse.json()) as {
      tools?: Array<{ name?: string }>;
    };
    const toolNames = new Set(
      (toolsPayload.tools ?? [])
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === "string")
    );

    return REQUIRED_BUILTIN_TOOLS.every((name) => toolNames.has(name));
  } catch {
    return false;
  }
}

async function localAuthHeaders(): Promise<Record<string, string> | null> {
  const token = await loadLocalAuthToken();
  if (!token) {
    return null;
  }

  return { Authorization: `Bearer ${token}` };
}

async function resolveLocalClientOrgId(
  serverUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<string | null> {
  const response = await fetch(`${serverUrl}/v1/auth/orgs`, {
    headers,
    signal,
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    orgs?: Array<{ id?: string }>;
  };

  const orgId = payload.orgs?.find(
    (org) => typeof org.id === "string" && org.id.trim().length > 0
  )?.id;

  return orgId?.trim() || null;
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
