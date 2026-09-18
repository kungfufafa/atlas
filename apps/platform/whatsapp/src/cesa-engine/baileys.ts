import { join } from "node:path";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
} from "@whiskeysockets/baileys";
import { usePrivateMultiFileAuthState } from "../auth-state";
import { createBaileysLogger } from "../baileys-logger";
import { type CesaWhatsAppEngine, createCesaWhatsAppEngine } from "./engine";

interface QrCodeModule {
  toDataURL: (
    text: string,
    options: { margin: number; width: number }
  ) => Promise<string>;
}

async function qrToDataURL(qr: string): Promise<string> {
  const qrcode = (await import("qrcode")) as QrCodeModule;
  return qrcode.toDataURL(qr, { margin: 1, width: 280 });
}

export function createBaileysCesaEngine(roots: {
  journalRoot: string;
  sessionRoot: string;
}): CesaWhatsAppEngine {
  const logger = createBaileysLogger();
  return createCesaWhatsAppEngine({
    disconnectReasons: {
      connectionReplaced: DisconnectReason.connectionReplaced,
      forbidden: DisconnectReason.forbidden,
      loggedOut: DisconnectReason.loggedOut,
      multideviceMismatch: DisconnectReason.multideviceMismatch,
      restartRequired: DisconnectReason.restartRequired,
    },
    fetchVersion: () => fetchLatestBaileysVersion(),
    journalRoot: roots.journalRoot,
    logger: {
      error: (fields, message) => logger.error(fields, message),
      warn: (fields, message) => logger.warn(fields, message),
    },
    makeSocket: (configuration) =>
      makeWASocket({
        auth: {
          creds: configuration.auth.creds as never,
          keys: configuration.auth.keys as never,
        },
        browser: ["Ubuntu", "Chrome", "22.04.4"],
        connectTimeoutMs: 30_000,
        emitOwnEvents: false,
        keepAliveIntervalMs: 15_000,
        logger,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        retryRequestDelayMs: 500,
        syncFullHistory: false,
        ...(configuration.version ? { version: configuration.version } : {}),
      }) as never,
    qrToDataURL,
    sessionRoot: roots.sessionRoot,
    useAuthState: (directory) => usePrivateMultiFileAuthState(directory),
  });
}

export function defaultCesaWhatsAppEngineRoots(configDir: string): {
  journalRoot: string;
  sessionRoot: string;
} {
  return {
    journalRoot: join(configDir, "cesa-whatsapp", "messages"),
    sessionRoot: join(configDir, "cesa-whatsapp", "sessions"),
  };
}
