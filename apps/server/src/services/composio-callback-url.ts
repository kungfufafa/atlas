import {
  isValidBaseUrl,
  loadUserWebPublicUrl,
  normalizeBaseUrl,
  resolveWebPublicUrl,
  saveUserWebPublicUrl,
  type WebPublicUrlSettingsResponse,
} from "@atlas/core";

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
  const requestOrigin = normalizePublicHttpOrigin(
    new URL(options.request.url).origin
  );
  const configured = normalizePublicHttpOrigin(
    resolveWebPublicUrl() ?? undefined
  );
  const allowed = new Set(
    [requestOrigin, configured].filter((value): value is string =>
      Boolean(value)
    )
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

  if (configured) {
    return configured;
  }

  return requestOrigin ?? "http://127.0.0.1:3000";
}

/** OAuth callback base URL — prefers the browser origin from the active request. */
export function resolveComposioCallbackBaseUrl(
  options: { clientOrigin?: string; request?: Request } = {}
): string {
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

  const configured = resolveWebPublicUrl();
  if (configured) {
    return configured;
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
