import type { UpdateEditableArtifactRequest } from "@atlas/core";
import { AtlasApiError } from "@atlas/core";

export const ARTIFACT_EDIT_MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export async function readArtifactEditJsonBody(
  request: Request
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new AtlasApiError("Invalid Content-Length header.", 400);
    }
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength > ARTIFACT_EDIT_MAX_HTTP_BODY_BYTES
    ) {
      throw bodyTooLargeError();
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new AtlasApiError("Invalid JSON in request body.", 400);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > ARTIFACT_EDIT_MAX_HTTP_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw bodyTooLargeError();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    throw new AtlasApiError("Could not read artifact edit request body.", 400);
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new AtlasApiError("Invalid JSON in request body.", 400);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AtlasApiError("Invalid JSON in request body.", 400);
  }
}

export function parseArtifactEditRequest(
  value: unknown
): UpdateEditableArtifactRequest {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw invalidArtifactEditRequest();
  }

  const body = value as Record<string, unknown>;
  if (
    typeof body.expectedHash !== "string" ||
    !SHA256_PATTERN.test(body.expectedHash) ||
    (body.content !== undefined && typeof body.content !== "string") ||
    (body.rows !== undefined && !Array.isArray(body.rows))
  ) {
    throw invalidArtifactEditRequest();
  }

  return {
    content: body.content as string | undefined,
    expectedHash: body.expectedHash,
    rows: body.rows as string[][] | undefined,
  };
}

function bodyTooLargeError(): AtlasApiError {
  return new AtlasApiError(
    "Artifact edit request exceeds the 16 MB request limit.",
    413
  );
}

function invalidArtifactEditRequest(): AtlasApiError {
  return new AtlasApiError("Invalid artifact edit request.", 400);
}
