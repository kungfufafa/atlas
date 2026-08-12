import { createClient } from "@atlas/client";
import { formatClientError } from "@atlas/core/api-error";

export const client = createClient({ baseUrl: "" });

export function formatError(error: unknown): string {
  return formatClientError(error);
}
