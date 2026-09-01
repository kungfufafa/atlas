import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./types";

const CORS_MAX_AGE_SECONDS = 600;

const CORS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Atlas-Auth-Mode",
  "X-CSRF-Token",
  "X-Org-Id",
];

const CORS_ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

const CORS_EXPOSED_HEADERS = ["Content-Disposition"];

export function createCorsMiddleware(
  allowedOrigins: readonly string[]
): MiddlewareHandler<AppEnv> {
  return cors({
    allowHeaders: CORS_ALLOWED_HEADERS,
    allowMethods: CORS_ALLOWED_METHODS,
    credentials: false,
    exposeHeaders: CORS_EXPOSED_HEADERS,
    maxAge: CORS_MAX_AGE_SECONDS,
    origin: [...allowedOrigins],
  });
}

export function parseCorsAllowedOrigins(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  const origins = new Set<string>();

  for (const entry of value.split(",")) {
    const candidate = entry.trim();
    if (!candidate) {
      throw new Error(
        "ATLAS_CORS_ORIGINS must contain comma-separated HTTP(S) origins."
      );
    }

    origins.add(parseCorsOrigin(candidate));
  }

  return [...origins];
}

function parseCorsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ATLAS_CORS_ORIGINS entry: ${value}`);
  }

  const hasUnsupportedParts =
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0;
  const hasSupportedProtocol =
    url.protocol === "http:" || url.protocol === "https:";

  if (!hasSupportedProtocol || hasUnsupportedParts) {
    throw new Error(
      `ATLAS_CORS_ORIGINS entries must be HTTP(S) origins without paths, credentials, queries, or fragments: ${value}`
    );
  }

  return url.origin;
}
