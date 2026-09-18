import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

const API_PREFIXES = ["/v1/", "/health", "/docs", "/openapi.json"] as const;
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const GZIP_EXTENSIONS = new Set([".css", ".html", ".js"]);
const HTML_CACHE_CONTROL = "no-cache";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const gzipCache = new Map<
  string,
  { bytes: Uint8Array; mtimeMs: number; size: number }
>();

export function resolveWebDistDir(projectRoot: string): string | null {
  const distDir = join(projectRoot, "apps/web/dist");
  return existsSync(distDir) ? distDir : null;
}

export function tryServeStaticWeb(
  request: Request,
  distDir: string
): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  if (isApiPath(pathname)) {
    return null;
  }

  const relativePath =
    pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolveDistFile(distDir, relativePath);

  if (!filePath) {
    if (!pathname.includes(".")) {
      const indexPath = resolveDistFile(distDir, "index.html");
      if (indexPath) {
        return fileResponse(indexPath, "index.html", request);
      }
    }

    return null;
  }

  return fileResponse(filePath, relativePath, request);
}

function isApiPath(pathname: string): boolean {
  if (pathname === "/health") {
    return true;
  }

  return API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix)
  );
}

function resolveDistFile(distDir: string, relativePath: string): string | null {
  const normalized = normalize(relativePath);

  if (normalized.startsWith("..") || normalized.includes(`..${sep}`)) {
    return null;
  }

  const filePath = join(distDir, normalized);

  if (!filePath.startsWith(distDir)) {
    return null;
  }

  if (!existsSync(filePath)) {
    return null;
  }

  return filePath;
}

function requestAcceptsGzip(request: Request): boolean {
  const header = request.headers.get("Accept-Encoding");
  if (!header) {
    return false;
  }

  for (const part of header.split(",")) {
    const tokens = part.split(";").map((item) => item.trim().toLowerCase());
    const encoding = tokens[0];
    if (encoding !== "gzip" && encoding !== "x-gzip") {
      continue;
    }
    const quality = tokens.find((token) => token.startsWith("q="));
    if (quality && Number(quality.slice(2)) === 0) {
      continue;
    }
    return true;
  }

  return false;
}

function cacheControlFor(relativePath: string): string | undefined {
  if (relativePath === "index.html") {
    return HTML_CACHE_CONTROL;
  }
  if (relativePath.startsWith("assets/")) {
    return ASSET_CACHE_CONTROL;
  }
}

function gzipFile(filePath: string): Uint8Array {
  const stats = statSync(filePath);
  const cached = gzipCache.get(filePath);
  if (
    cached &&
    cached.size === stats.size &&
    cached.mtimeMs === stats.mtimeMs
  ) {
    return cached.bytes;
  }

  const bytes = Bun.gzipSync(readFileSync(filePath));
  gzipCache.set(filePath, {
    bytes,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  });
  return bytes;
}

function fileResponse(
  filePath: string,
  relativePath: string,
  request: Request
): Response {
  const file = Bun.file(filePath);
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const contentType = CONTENT_TYPES[extension] ?? file.type;
  const headers = new Headers({ "Content-Type": contentType });
  const cacheControl = cacheControlFor(relativePath);
  if (cacheControl) {
    headers.set("Cache-Control", cacheControl);
  }

  const compressible = GZIP_EXTENSIONS.has(extension);
  if (compressible) {
    headers.set("Vary", "Accept-Encoding");
  }

  if (compressible && requestAcceptsGzip(request)) {
    const gzipped = gzipFile(filePath);
    headers.set("Content-Encoding", "gzip");
    headers.set("Content-Length", String(gzipped.byteLength));
    if (request.method === "HEAD") {
      return new Response(null, { headers });
    }
    return new Response(gzipped, { headers });
  }

  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }

  return new Response(file, { headers });
}
