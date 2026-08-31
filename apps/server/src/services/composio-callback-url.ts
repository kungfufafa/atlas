import {
  isValidBaseUrl,
  loadUserWebPublicUrl,
  normalizeBaseUrl,
  resolveWebPublicUrl,
  saveUserWebPublicUrl,
  type WebPublicUrlSettingsResponse,
} from "@atlas/core";

const COMPOSIO_OAUTH_LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);

/** Validate a Composio-hosted authorization link before it leaves the server. */
export function validateComposioOAuthRedirectUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Composio returned an invalid OAuth URL.");
  }

  const isSecure = parsed.protocol === "https:";
  const isLoopbackDevelopment =
    parsed.protocol === "http:" &&
    COMPOSIO_OAUTH_LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    !(isSecure || isLoopbackDevelopment) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error("Composio returned an unsafe OAuth URL.");
  }

  return parsed.toString();
}

function normalizePublicHttpOrigin(
  value: string | null | undefined
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }

  const normalized = trimmed.replace(/\/$/, "");
  return isValidBaseUrl(normalized) ? normalized : undefined;
}

export function resolveRequestClientOrigin(
  request?: Request,
  explicitOrigin?: string
): string | undefined {
  const explicit = normalizePublicHttpOrigin(explicitOrigin);
  if (explicit) {
    return explicit;
  }

  if (!request) {
    return;
  }

  const origin = normalizePublicHttpOrigin(request.headers.get("origin"));
  if (origin) {
    return origin;
  }

  const referer = request.headers.get("referer")?.trim();
  if (referer) {
    try {
      return normalizePublicHttpOrigin(new URL(referer).origin);
    } catch {
      // ignore invalid referer
    }
  }
}

export async function persistWebPublicUrl(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!(trimmed && isValidBaseUrl(trimmed))) {
    throw new Error("webPublicUrl must be a valid http or https URL.");
  }

  return saveUserWebPublicUrl(normalizeBaseUrl(trimmed));
}

export async function getWebPublicUrlSettings(): Promise<WebPublicUrlSettingsResponse> {
  const envOverride =
    process.env.ATLAS_WEB_PUBLIC_URL?.trim() ||
    process.env.ATLAS_PUBLIC_URL?.trim();

  return {
    envOverride: envOverride ? normalizeBaseUrl(envOverride) : null,
    webPublicUrl: await loadUserWebPublicUrl(),
  };
}

/** OAuth redirect callback host: request origin or configured public URL only. */
export function resolveComposioOAuthCallbackBaseUrl(options: {
  clientOrigin?: string;
  request: Request;
}): string {
  const configured = normalizePublicHttpOrigin(
    resolveWebPublicUrl() ?? undefined
  );
  if (configured) {
    return configured;
  }

  const requestOrigin = normalizePublicHttpOrigin(
    new URL(options.request.url).origin
  );
  const allowed = new Set(
    [requestOrigin].filter((value): value is string => Boolean(value))
  );
  const explicit = normalizePublicHttpOrigin(options.clientOrigin);
  if (explicit && allowed.has(explicit)) {
    return explicit;
  }

  const headerOrigin = normalizePublicHttpOrigin(
    options.request.headers.get("origin")
  );
  if (headerOrigin && allowed.has(headerOrigin)) {
    return headerOrigin;
  }

  return requestOrigin ?? "http://127.0.0.1:3000";
}

/**
 * Resolve a callback/share base URL. A configured operator URL wins because
 * request origins and forwarded headers are caller-controlled.
 */
export function resolveComposioCallbackBaseUrl(
  options: { clientOrigin?: string; request?: Request } = {}
): string {
  const configured = normalizePublicHttpOrigin(
    resolveWebPublicUrl() ?? undefined
  );
  if (configured) {
    return configured;
  }

  const fromBrowser = resolveRequestClientOrigin(
    options.request,
    options.clientOrigin
  );
  if (fromBrowser) {
    return fromBrowser;
  }

  if (options.request) {
    const forwardedHost = options.request.headers.get("x-forwarded-host");
    if (forwardedHost) {
      const forwardedProto =
        options.request.headers.get("x-forwarded-proto") ?? "http";
      const forwardedOrigin = normalizePublicHttpOrigin(
        `${forwardedProto}://${forwardedHost}`
      );
      if (forwardedOrigin) {
        return forwardedOrigin;
      }
    }

    const url = new URL(options.request.url);
    return `${url.protocol}//${url.host}`;
  }

  const webPort = process.env.ATLAS_WEB_PORT?.trim() || "3000";
  return `http://127.0.0.1:${webPort}`;
}

/** True when the OAuth callback host is unreachable from a phone (Telegram / WhatsApp). */
export function isLoopbackComposioCallbackBaseUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
