import type { CesaWhatsAppEngine } from "./engine";
import { CesaEngineError } from "./errors";
import { validateCesaSessionId } from "./ids";

const MAX_BODY_BYTES = 1_000_000;

export const CESA_WHATSAPP_ENGINE_PREFIX = "/v1/integrations/cesa/whatsapp";
const startedAt = Date.now();

export function cesaWhatsAppEnginePath(pathname: string): string {
  if (pathname === CESA_WHATSAPP_ENGINE_PREFIX) {
    return "/";
  }
  if (pathname.startsWith(`${CESA_WHATSAPP_ENGINE_PREFIX}/`)) {
    return pathname.slice(CESA_WHATSAPP_ENGINE_PREFIX.length) || "/";
  }
  return pathname;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) {
    throw new CesaEngineError(
      "Payload terlalu besar.",
      413,
      "payload_too_large"
    );
  }
  if (raw.byteLength === 0) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new CesaEngineError("Payload JSON tidak valid.", 400, "invalid_json");
  }
}

function json(status: number, payload: unknown): Response {
  return Response.json(payload, { status });
}

export async function handleCesaWhatsAppEngineRequest(
  request: Request,
  engine: CesaWhatsAppEngine,
  pathname = new URL(request.url).pathname
): Promise<Response> {
  try {
    const path = (cesaWhatsAppEnginePath(pathname).replace(/\/+$/, "") ||
      "/") as string;

    if (request.method === "GET" && path === "/health") {
      return json(200, {
        ...engine.health(),
        pid: process.pid,
        uptime_ms: Date.now() - startedAt,
      });
    }

    if (request.method === "POST" && path === "/sessions") {
      const payload = await readJson(request);
      if (payload.mode !== "qr" && payload.mode !== "pairing") {
        throw new CesaEngineError(
          "Pilih mode QR atau pairing WhatsApp.",
          422,
          "invalid_mode"
        );
      }
      return json(
        200,
        await engine.startSession(String(payload.id ?? ""), {
          mode: payload.mode,
          phone: typeof payload.phone === "string" ? payload.phone : null,
        })
      );
    }

    const route = path.match(
      /^\/sessions\/([^/]+)(?:\/(send|messages)(?:\/([^/]+))?)?$/
    );
    if (!route) {
      throw new CesaEngineError("Not found", 404, "not_found");
    }

    let id: string;
    let key: string | null = null;
    try {
      id = decodeURIComponent(route[1] ?? "");
      key = route[3] ? decodeURIComponent(route[3]) : null;
    } catch {
      throw new CesaEngineError(
        "Parameter URL tidak valid.",
        400,
        "invalid_url"
      );
    }
    validateCesaSessionId(id);

    if (!route[2] && request.method === "GET") {
      return json(200, engine.session(id));
    }
    if (!route[2] && request.method === "DELETE") {
      const payload = await readJson(request);
      return json(200, await engine.stopSession(id, payload.logout !== false));
    }
    if (route[2] === "send" && !key && request.method === "POST") {
      const result = await engine.sendText(id, await readJson(request));
      return json(result.status === "failed" ? 409 : 200, result);
    }
    if (route[2] === "messages" && key && request.method === "GET") {
      return json(200, engine.messageStatus(id, key));
    }
    throw new CesaEngineError("Not found", 404, "not_found");
  } catch (error) {
    if (error instanceof CesaEngineError) {
      return json(error.statusCode, {
        error_code: error.errorCode,
        message: error.message,
        ok: false,
        retryable: error.retryable === true,
        status: "failed",
      });
    }
    return json(500, {
      error_code: "engine_error",
      message:
        error instanceof Error
          ? error.message
          : "Engine WhatsApp gagal memproses permintaan.",
      ok: false,
      retryable: false,
      status: "failed",
    });
  }
}
