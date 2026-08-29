import { AtlasApiError } from "@atlas/client";

export function isInvalidSessionError(error: unknown): boolean {
  return error instanceof AtlasApiError && error.status === 401;
}
