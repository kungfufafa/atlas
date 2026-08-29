const KNOWN_APP_PATHS = new Set(["", "chat", "login", "setup", "v1"]);
const SERVER_ID_PREFIX = "atlas-server-v2-";
const IPV6_LITERAL_PATTERN = /^[0-9a-f:]+$/i;
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)";
const LOOPBACK_IPV4_PATTERN = new RegExp(`^127(?:\\.${IPV4_OCTET}){3}$`);
const CLASS_A_PRIVATE_IPV4_PATTERN = new RegExp(`^10(?:\\.${IPV4_OCTET}){3}$`);
const CLASS_C_PRIVATE_IPV4_PATTERN = new RegExp(
  `^192\\.168(?:\\.${IPV4_OCTET}){2}$`
);
const CLASS_B_PRIVATE_IPV4_PATTERN = new RegExp(
  `^172\\.(1[6-9]|2\\d|3[0-1])(?:\\.${IPV4_OCTET}){2}$`
);
const LINK_LOCAL_IPV4_PATTERN = new RegExp(
  `^169\\.254(?:\\.${IPV4_OCTET}){2}$`
);

export type ServerConnectionDecision =
  | { status: "invalid"; url: "" }
  | { status: "needs-insecure-confirmation"; url: string }
  | { status: "ready"; url: string };

export function canonicalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = canonicalizeHostname(hostname);
  if (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  if (LOOPBACK_IPV4_PATTERN.test(host)) {
    return true;
  }
  if (CLASS_A_PRIVATE_IPV4_PATTERN.test(host)) {
    return true;
  }
  if (CLASS_C_PRIVATE_IPV4_PATTERN.test(host)) {
    return true;
  }
  if (CLASS_B_PRIVATE_IPV4_PATTERN.test(host)) {
    return true;
  }
  if (LINK_LOCAL_IPV4_PATTERN.test(host)) {
    return true;
  }

  if (host.includes(":") && IPV6_LITERAL_PATTERN.test(host)) {
    const firstIpv6Hextet = Number.parseInt(host.split(":")[0] ?? "", 16);
    if (
      Number.isFinite(firstIpv6Hextet) &&
      ((firstIpv6Hextet >= 0xfc_00 && firstIpv6Hextet <= 0xfd_ff) ||
        (firstIpv6Hextet >= 0xfe_80 && firstIpv6Hextet <= 0xfe_bf))
    ) {
      return true;
    }
  }

  return false;
}

export function coerceServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return "";
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return "";
  }

  if (
    hasScheme &&
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    return "";
  }

  const hostname = canonicalizeHostname(parsed.hostname);
  if (!hostname) {
    return "";
  }

  const protocol = hasScheme
    ? parsed.protocol
    : isPrivateOrLocalHostname(hostname)
      ? "http:"
      : "https:";
  if (protocol === "http:" && !isPrivateOrLocalHostname(hostname)) {
    return "";
  }
  const isDefaultPort =
    (protocol === "http:" && parsed.port === "80") ||
    (protocol === "https:" && parsed.port === "443");
  const port = parsed.port && !isDefaultPort ? `:${parsed.port}` : "";
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  const origin = `${protocol}//${host}${port}`;

  const path = parsed.pathname.replace(/\/+$/, "");
  const appPath = path.startsWith("/") ? path.slice(1).toLowerCase() : path;
  if (KNOWN_APP_PATHS.has(appPath)) {
    return origin;
  }

  return `${origin}${path}`;
}

export function normalizeServerUrl(input: string): string {
  return coerceServerUrl(input);
}

export function isValidServerUrl(input: string): boolean {
  const url = coerceServerUrl(input);
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export function isInsecureServerUrl(input: string): boolean {
  return normalizeServerUrl(input).startsWith("http://");
}

export function evaluateServerConnection(
  input: string,
  options?: { insecureConfirmed?: boolean }
): ServerConnectionDecision {
  const url = coerceServerUrl(input);
  if (!isValidServerUrl(url)) {
    return { status: "invalid", url: "" };
  }
  if (isInsecureServerUrl(url) && options?.insecureConfirmed !== true) {
    return { status: "needs-insecure-confirmation", url };
  }
  return { status: "ready", url };
}

export function assertPersistableServerUrl(
  input: string,
  options?: { allowInsecure?: boolean }
): string {
  const decision = evaluateServerConnection(input, {
    insecureConfirmed: options?.allowInsecure,
  });
  if (decision.status === "invalid") {
    throw new Error("Enter a valid http or https server URL.");
  }
  if (decision.status === "needs-insecure-confirmation") {
    throw new Error(
      "HTTP is only allowed for a local or private Atlas server after confirmation."
    );
  }
  return decision.url;
}

export function serverIdFromUrl(url: string): string {
  const normalized = normalizeServerUrl(url);
  if (!normalized) {
    throw new Error("A valid server URL is required to create a server ID.");
  }

  return `${SERVER_ID_PREFIX}${normalized
    .split("")
    .map((character) => character.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("")}`;
}

export function displayNameFromUrl(url: string): string {
  try {
    const parsed = new URL(normalizeServerUrl(url));
    return parsed.host;
  } catch {
    return normalizeServerUrl(url);
  }
}
