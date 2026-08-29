import type { AtlasClient } from "@atlas/client";
import { createClient } from "@atlas/client";

export function createAtlasClient(options: {
  authToken?: string | null;
  baseUrl: string;
}): AtlasClient {
  return createClient({
    authToken: options.authToken ?? undefined,
    baseUrl: options.baseUrl,
    clientOrigin: options.baseUrl,
    redirect: "error",
    tokenAuth: true,
  });
}
