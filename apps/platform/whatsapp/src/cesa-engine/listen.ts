import { join } from "node:path";
import { getUserConfigDir } from "@atlas/core";
import { createBaileysCesaEngine } from "./baileys";
import type { CesaWhatsAppEngine } from "./engine";
import { handleCesaWhatsAppEngineRequest } from "./http";

export const DEFAULT_CESA_WHATSAPP_ENGINE_PORT = 3318;

export function cesaWhatsAppEngineEnabled(): boolean {
  const raw = process.env.ATLAS_CESA_WHATSAPP_ENGINE?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function resolveCesaWhatsAppEngineListen(): {
  hostname: string;
  port: number;
} {
  const portRaw = process.env.ATLAS_CESA_WHATSAPP_ENGINE_PORT?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_CESA_WHATSAPP_ENGINE_PORT;
  return {
    hostname:
      process.env.ATLAS_CESA_WHATSAPP_ENGINE_HOST?.trim() || "127.0.0.1",
    port:
      Number.isInteger(port) && port > 0
        ? port
        : DEFAULT_CESA_WHATSAPP_ENGINE_PORT,
  };
}

export function cesaWhatsAppEngineRoots(configDir = getUserConfigDir()): {
  journalRoot: string;
  sessionRoot: string;
} {
  return {
    journalRoot: join(configDir, "cesa-whatsapp", "messages"),
    sessionRoot: join(configDir, "cesa-whatsapp", "sessions"),
  };
}

function isAddressInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

export async function startCesaWhatsAppEngineServer(options?: {
  engine?: CesaWhatsAppEngine;
  hostname?: string;
  port?: number;
}): Promise<{
  engine: CesaWhatsAppEngine;
  handle: (request: Request) => Promise<Response>;
  hostname: string;
  listening: boolean;
  port: number;
  stop: () => Promise<void>;
}> {
  const listen = resolveCesaWhatsAppEngineListen();
  const hostname = options?.hostname ?? listen.hostname;
  const requestedPort = options?.port ?? listen.port;
  const engine =
    options?.engine ?? createBaileysCesaEngine(cesaWhatsAppEngineRoots());
  await engine.restoreSessions();
  const handle = (request: Request) =>
    handleCesaWhatsAppEngineRequest(request, engine);

  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      fetch: handle,
      hostname,
      port: requestedPort,
    });
  } catch (error) {
    if (!isAddressInUseError(error)) {
      throw error;
    }
  }

  return {
    engine,
    handle,
    hostname,
    listening: Boolean(server),
    port: server?.port ?? requestedPort,
    stop: async () => {
      server?.stop(true);
      await engine.shutdown();
    },
  };
}
