import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { ServerOptions } from "../context";

const CESA_PREFIX = "/v1/integrations/cesa/whatsapp";

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) {
    return false;
  }
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function isCesaWhatsAppEngineRequest(
  method: string,
  pathname: string
): boolean {
  if (pathname !== CESA_PREFIX && !pathname.startsWith(`${CESA_PREFIX}/`)) {
    return false;
  }
  return (
    method === "GET" ||
    method === "POST" ||
    method === "DELETE" ||
    method === "HEAD"
  );
}

export function cesaWhatsAppEngineAuthorized(request: Request): boolean {
  const expected = process.env.ATLAS_CESA_WHATSAPP_TOKEN?.trim();
  const host = new URL(request.url).hostname;
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!expected) {
    return loopback;
  }
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : null;
  const header = request.headers.get("x-atlas-cesa-token")?.trim() ?? null;
  return tokenMatches(bearer, expected) || tokenMatches(header, expected);
}

export function registerCesaWhatsAppRoutes(
  app: Hono,
  options: ServerOptions
): void {
  app.all(`${CESA_PREFIX}/*`, async (c) => {
    if (!cesaWhatsAppEngineAuthorized(c.req.raw)) {
      return c.json(
        {
          error_code: "unauthorized",
          message: "CESA WhatsApp engine token is required.",
          ok: false,
          status: "failed",
        },
        401
      );
    }
    const handle = options.cesaWhatsAppEngine?.handle;
    if (!handle) {
      return c.json(
        {
          error_code: "engine_offline",
          message: "Atlas CESA WhatsApp engine is not running.",
          ok: false,
          retryable: true,
          status: "failed",
        },
        503
      );
    }
    return handle(c.req.raw);
  });

  app.all(CESA_PREFIX, async (c) => {
    if (!cesaWhatsAppEngineAuthorized(c.req.raw)) {
      return c.json(
        {
          error_code: "unauthorized",
          message: "CESA WhatsApp engine token is required.",
          ok: false,
          status: "failed",
        },
        401
      );
    }
    const handle = options.cesaWhatsAppEngine?.handle;
    if (!handle) {
      return c.json(
        {
          error_code: "engine_offline",
          message: "Atlas CESA WhatsApp engine is not running.",
          ok: false,
          retryable: true,
          status: "failed",
        },
        503
      );
    }
    return handle(c.req.raw);
  });
}
