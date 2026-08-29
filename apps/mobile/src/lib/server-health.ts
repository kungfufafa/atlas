import { ATLAS_API_VERSION } from "@atlas/core/contract";
import { assertPersistableServerUrl } from "./server-url";

const HEALTH_CHECK_TIMEOUT_MS = 10_000;

export function isCompatibleAtlasHealthResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const response = value as Record<string, unknown>;
  return response.ok === true && response.apiVersion === ATLAS_API_VERSION;
}

export async function checkAtlasServer(
  serverUrl: string,
  options?: { allowInsecure?: boolean; signal?: AbortSignal }
): Promise<void> {
  const normalizedUrl = assertPersistableServerUrl(serverUrl, {
    allowInsecure: options?.allowInsecure,
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    HEALTH_CHECK_TIMEOUT_MS
  );
  const abortFromCaller = () => controller.abort();
  options?.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await fetch(`${normalizedUrl}/health`, {
      credentials: "omit",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error("This URL did not respond as an Atlas server.");
    }

    const responseUrl = response.url;
    if (
      responseUrl &&
      new URL(responseUrl).origin !== new URL(normalizedUrl).origin
    ) {
      throw new Error("The server redirected to a different origin.");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("This URL did not return a valid Atlas health response.");
    }

    if (!isCompatibleAtlasHealthResponse(payload)) {
      throw new Error(
        "This Atlas server is not compatible with this app version."
      );
    }
  } catch (error) {
    if (options?.signal?.aborted) {
      throw new Error("The server check was cancelled.");
    }
    if (controller.signal.aborted) {
      throw new Error(
        "The server took too long to respond. Check the URL and network."
      );
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Could not reach that Atlas server.");
  } finally {
    clearTimeout(timeoutId);
    options?.signal?.removeEventListener("abort", abortFromCaller);
  }
}
