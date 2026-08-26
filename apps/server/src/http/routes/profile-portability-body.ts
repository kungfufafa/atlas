import { AtlasApiError } from "@atlas/core";

const PROFILE_PACK_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const PROFILE_PACK_MAX_ENCODED_ARCHIVE_BYTES =
  Math.ceil(PROFILE_PACK_MAX_ARCHIVE_BYTES / 3) * 4 + 4;
const PROFILE_PACK_JSON_OVERHEAD_BYTES = 16 * 1024;

export const PROFILE_PACK_MAX_HTTP_BODY_BYTES =
  PROFILE_PACK_MAX_ENCODED_ARCHIVE_BYTES + PROFILE_PACK_JSON_OVERHEAD_BYTES;
export const PROFILE_PACK_MAX_ACTIVE_BODY_READS = 4;
export const PROFILE_PACK_BODY_RETRY_AFTER_SECONDS = 1;

let activeBodyReads = 0;

export function tryAcquireProfilePackBodyRead(): (() => void) | null {
  if (activeBodyReads >= PROFILE_PACK_MAX_ACTIVE_BODY_READS) {
    return null;
  }

  activeBodyReads += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeBodyReads -= 1;
  };
}

export async function readProfilePackJsonBody(
  request: Request
): Promise<unknown> {
  assertContentLengthWithinLimit(request.headers.get("content-length"));

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
      if (totalBytes > PROFILE_PACK_MAX_HTTP_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw profilePackBodyTooLargeError();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    throw new AtlasApiError("Could not read profile pack request body.", 400);
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

function assertContentLengthWithinLimit(value: string | null): void {
  if (value === null) {
    return;
  }

  if (!/^\d+$/.test(value)) {
    throw new AtlasApiError("Invalid Content-Length header.", 400);
  }

  const contentLength = Number(value);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength > PROFILE_PACK_MAX_HTTP_BODY_BYTES
  ) {
    throw profilePackBodyTooLargeError();
  }
}

function profilePackBodyTooLargeError(): AtlasApiError {
  return new AtlasApiError(
    "Profile pack request exceeds the 25 MB archive limit.",
    413
  );
}
