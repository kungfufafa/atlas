import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const OLLAMA_LOCAL_PORT = "11434";
const OLLAMA_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export type ProviderDiscoverySafetyErrorCode =
  | "blocked-address"
  | "credentials-not-allowed"
  | "dns-no-addresses"
  | "dns-resolution-failed"
  | "invalid-dns-address"
  | "invalid-url"
  | "insecure-credential-transport"
  | "localhost-not-allowed"
  | "redirect-limit-exceeded"
  | "redirect-missing-location"
  | "unsafe-redirect"
  | "unsupported-protocol";

export class ProviderDiscoverySafetyError extends Error {
  readonly code: ProviderDiscoverySafetyErrorCode;

  constructor(code: ProviderDiscoverySafetyErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ProviderDiscoverySafetyError";
  }
}

export interface ProviderDiscoveryDnsRecord {
  address: string;
  family?: 4 | 6;
}

export type ProviderDiscoveryDnsResolver = (
  hostname: string
) => Promise<readonly ProviderDiscoveryDnsRecord[]>;

export type ProviderDiscoveryFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

/**
 * Local discovery is denied unless the caller has already established that the
 * provider is Ollama in local mode. Even then, the exception only covers
 * Ollama's default loopback origin and never a LAN address or arbitrary port.
 */
export interface OllamaLocalDiscoveryAccess {
  kind: "ollama-local";
}

export interface OpenAiCompatibleLocalDiscoveryAccess {
  kind: "openai-compatible-local";
}

export type ProviderDiscoveryLocalAccess =
  | OllamaLocalDiscoveryAccess
  | OpenAiCompatibleLocalDiscoveryAccess;

export interface ProviderDiscoverySafetyOptions {
  localAccess?: ProviderDiscoveryLocalAccess;
  resolveDns?: ProviderDiscoveryDnsResolver;
  signal?: AbortSignal | null;
}

export interface FetchProviderDiscoveryOptions
  extends ProviderDiscoverySafetyOptions {
  fetchImpl?: ProviderDiscoveryFetch;
  maxRedirects?: number;
}

const defaultResolveDns: ProviderDiscoveryDnsResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address }));
};

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined
): Promise<T> {
  if (!signal) {
    return promise;
  }

  signal.throwIfAborted();

  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    removeAbortListener();
  }
}

function parseUrl(rawUrl: string | URL): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.toString());
  } catch {
    throw new ProviderDiscoverySafetyError(
      "invalid-url",
      "Provider discovery requires a valid absolute URL."
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderDiscoverySafetyError(
      "unsupported-protocol",
      "Provider discovery only supports HTTP and HTTPS URLs."
    );
  }

  if (!(url.hostname && url.host)) {
    throw new ProviderDiscoverySafetyError(
      "invalid-url",
      "Provider discovery URL must include a hostname."
    );
  }

  if (url.username || url.password) {
    throw new ProviderDiscoverySafetyError(
      "credentials-not-allowed",
      "Provider discovery URL must not contain credentials."
    );
  }

  return url;
}

function normalizedHostname(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isLocalhostName(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost.localdomain")
  );
}

function isAllowedOllamaLocalUrl(
  url: URL,
  localAccess: ProviderDiscoveryLocalAccess | undefined
): boolean {
  return (
    localAccess?.kind === "ollama-local" &&
    url.protocol === "http:" &&
    url.port === OLLAMA_LOCAL_PORT &&
    OLLAMA_LOCAL_HOSTS.has(normalizedHostname(url))
  );
}

function isAllowedOpenAiCompatibleLocalUrl(
  url: URL,
  localAccess: ProviderDiscoveryLocalAccess | undefined
): boolean {
  return (
    localAccess?.kind === "openai-compatible-local" &&
    url.protocol === "http:" &&
    Boolean(url.port) &&
    OLLAMA_LOCAL_HOSTS.has(normalizedHostname(url))
  );
}

function isAllowedLocalUrl(
  url: URL,
  localAccess: ProviderDiscoveryLocalAccess | undefined
): boolean {
  return (
    isAllowedOllamaLocalUrl(url, localAccess) ||
    isAllowedOpenAiCompatibleLocalUrl(url, localAccess)
  );
}

function parseIpv4Bytes(address: string): readonly number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      return null;
    }
    bytes.push(byte);
  }
  return bytes;
}

function parseIpv6Bytes(address: string): readonly number[] | null {
  if (address.includes("%") || isIP(address) !== 6) {
    return null;
  }

  let normalized = address.toLowerCase();
  const embeddedIpv4Match = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(
    normalized
  );
  if (embeddedIpv4Match) {
    const ipv4 = parseIpv4Bytes(embeddedIpv4Match[1] ?? "");
    if (!ipv4) {
      return null;
    }
    const high = (ipv4[0] ?? 0) * 256 + (ipv4[1] ?? 0);
    const low = (ipv4[2] ?? 0) * 256 + (ipv4[3] ?? 0);
    normalized = normalized.replace(
      embeddedIpv4Match[1] ?? "",
      `${high.toString(16)}:${low.toString(16)}`
    );
  }

  const halves = normalized.split("::");
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omittedGroups = 8 - left.length - right.length;
  if (
    omittedGroups < 0 ||
    (halves.length === 1 && omittedGroups !== 0) ||
    (halves.length === 2 && omittedGroups < 1)
  ) {
    return null;
  }

  const groups = [
    ...left,
    ...Array.from({ length: omittedGroups }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) {
    return null;
  }

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[\da-f]{1,4}$/.test(group)) {
      return null;
    }
    const value = Number.parseInt(group, 16);
    bytes.push(Math.floor(value / 256), value % 256);
  }
  return bytes;
}

function isUnsafeIpv4(bytes: readonly number[]): boolean {
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (bytes[2] ?? 0) === 0) ||
    (first === 192 && second === 0 && (bytes[2] ?? 0) === 2) ||
    (first === 192 && second === 88 && (bytes[2] ?? 0) === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && (bytes[2] ?? 0) === 100) ||
    (first === 203 && second === 0 && (bytes[2] ?? 0) === 113) ||
    first >= 224
  );
}

function allZero(bytes: readonly number[], endExclusive: number): boolean {
  for (let index = 0; index < endExclusive; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }
  return true;
}

function isUnsafeIpv6(bytes: readonly number[]): boolean {
  const isUnspecified = allZero(bytes, 16);
  const isLoopback = allZero(bytes, 15) && bytes[15] === 1;
  if (isUnspecified || isLoopback) {
    return true;
  }

  const isIpv4Mapped =
    allZero(bytes, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isIpv4Translated =
    allZero(bytes, 8) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0 &&
    bytes[11] === 0;
  const isIpv4Compatible = allZero(bytes, 12);
  if (isIpv4Translated) {
    return true;
  }
  if (isIpv4Mapped || isIpv4Compatible) {
    return isUnsafeIpv4(bytes.slice(12));
  }

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  const fourth = bytes[3] ?? 0;

  return (
    // IPv4/IPv6 translation, discard-only, and protocol-assignment ranges.
    (first === 0x00 && second === 0x64 && third === 0xff && fourth === 0x9b) ||
    (first === 0x01 && second === 0x00 && allZero(bytes.slice(2), 6)) ||
    (first === 0x01 &&
      second === 0x00 &&
      allZero(bytes.slice(2), 4) &&
      bytes[6] === 0 &&
      bytes[7] === 1) ||
    (first === 0x20 && second === 0x01 && third <= 0x01) ||
    // Documentation and transition ranges can encapsulate non-public targets.
    (first === 0x20 && second === 0x01 && third === 0x0d && fourth === 0xb8) ||
    (first === 0x20 && second === 0x02) ||
    (first === 0x3f && second === 0xff && third <= 0x0f) ||
    (first === 0x5f && second === 0x00) ||
    // Unique-local, link/site-local, and multicast.
    (first >= 0xfc && first <= 0xfd) ||
    (first === 0xfe && second >= 0x80 && second <= 0xbf) ||
    (first === 0xfe && second >= 0xc0) ||
    first === 0xff
  );
}

export function isUnsafeProviderDiscoveryAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = parseIpv4Bytes(address);
    return !bytes || isUnsafeIpv4(bytes);
  }
  if (family === 6) {
    const bytes = parseIpv6Bytes(address);
    return !bytes || isUnsafeIpv6(bytes);
  }
  return true;
}

export async function assertSafeProviderDiscoveryUrl(
  rawUrl: string | URL,
  options: ProviderDiscoverySafetyOptions = {}
): Promise<URL> {
  const url = parseUrl(rawUrl);
  if (isAllowedLocalUrl(url, options.localAccess)) {
    return url;
  }

  const hostname = normalizedHostname(url);
  if (isLocalhostName(hostname)) {
    throw new ProviderDiscoverySafetyError(
      "localhost-not-allowed",
      "Provider discovery does not allow localhost endpoints."
    );
  }

  if (isIP(hostname)) {
    if (isUnsafeProviderDiscoveryAddress(hostname)) {
      throw new ProviderDiscoverySafetyError(
        "blocked-address",
        "Provider discovery does not allow private or reserved addresses."
      );
    }
    return url;
  }

  const resolveDns = options.resolveDns ?? defaultResolveDns;
  let records: readonly ProviderDiscoveryDnsRecord[];
  try {
    records = await awaitWithAbort(resolveDns(hostname), options.signal);
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    throw new ProviderDiscoverySafetyError(
      "dns-resolution-failed",
      "Provider discovery hostname could not be resolved."
    );
  }

  if (records.length === 0) {
    throw new ProviderDiscoverySafetyError(
      "dns-no-addresses",
      "Provider discovery hostname did not resolve to an address."
    );
  }

  for (const record of records) {
    if (!isIP(record.address)) {
      throw new ProviderDiscoverySafetyError(
        "invalid-dns-address",
        "Provider discovery hostname resolved to an invalid address."
      );
    }
    if (isUnsafeProviderDiscoveryAddress(record.address)) {
      throw new ProviderDiscoverySafetyError(
        "blocked-address",
        "Provider discovery hostname resolved to a private or reserved address."
      );
    }
  }

  return url;
}

export async function assertSafeProviderDiscoveryRedirect(
  currentUrl: string | URL,
  location: string,
  options: ProviderDiscoverySafetyOptions = {}
): Promise<URL> {
  const current = parseUrl(currentUrl);
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw new ProviderDiscoverySafetyError(
      "unsafe-redirect",
      "Provider discovery received an invalid redirect URL."
    );
  }

  const validatedTarget = await assertSafeProviderDiscoveryUrl(target, options);
  if (validatedTarget.origin !== current.origin) {
    throw new ProviderDiscoverySafetyError(
      "unsafe-redirect",
      "Provider discovery does not follow cross-origin redirects."
    );
  }
  return validatedTarget;
}

function assertMaxRedirects(maxRedirects: number): void {
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError("maxRedirects must be a non-negative integer.");
  }
}

function hasSensitiveRequestHeaders(headers: HeadersInit | undefined): boolean {
  if (!headers) {
    return false;
  }
  const normalized = new Headers(headers);
  return (
    normalized.has("authorization") ||
    normalized.has("proxy-authorization") ||
    normalized.has("x-api-key") ||
    normalized.has("api-key")
  );
}

function assertSafeCredentialTransport(
  url: URL,
  init: RequestInit,
  localAccess: ProviderDiscoveryLocalAccess | undefined
): void {
  if (
    hasSensitiveRequestHeaders(init.headers) &&
    url.protocol !== "https:" &&
    !isAllowedLocalUrl(url, localAccess)
  ) {
    throw new ProviderDiscoverySafetyError(
      "insecure-credential-transport",
      "Provider discovery credentials require HTTPS."
    );
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function fetchSafeProviderDiscoveryEndpoint(
  rawUrl: string | URL,
  init: RequestInit = {},
  options: FetchProviderDiscoveryOptions = {}
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertMaxRedirects(maxRedirects);

  const fetchImpl = options.fetchImpl ?? fetch;
  const safetyOptions: ProviderDiscoverySafetyOptions = {
    localAccess: options.localAccess,
    resolveDns: options.resolveDns,
    signal: init.signal,
  };
  let current = await assertSafeProviderDiscoveryUrl(rawUrl, safetyOptions);
  assertSafeCredentialTransport(current, init, options.localAccess);
  let redirectCount = 0;

  while (true) {
    const response = await fetchImpl(current, {
      ...init,
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      await discardResponseBody(response);
      throw new ProviderDiscoverySafetyError(
        "redirect-missing-location",
        "Provider discovery redirect did not include a Location header."
      );
    }
    if (redirectCount >= maxRedirects) {
      await discardResponseBody(response);
      throw new ProviderDiscoverySafetyError(
        "redirect-limit-exceeded",
        "Provider discovery exceeded the redirect limit."
      );
    }

    let next: URL;
    try {
      next = await assertSafeProviderDiscoveryRedirect(
        current,
        location,
        safetyOptions
      );
    } finally {
      await discardResponseBody(response);
    }
    current = next;
    redirectCount += 1;
  }
}
