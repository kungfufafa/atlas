import { afterEach, describe, expect, test } from "bun:test";
import {
  cesaWhatsAppEngineEnabled,
  startCesaWhatsAppEngineServer,
} from "./listen";

const previous = process.env.ATLAS_CESA_WHATSAPP_ENGINE;

afterEach(() => {
  if (previous === undefined) {
    delete process.env.ATLAS_CESA_WHATSAPP_ENGINE;
    return;
  }
  process.env.ATLAS_CESA_WHATSAPP_ENGINE = previous;
});

describe("CESA WhatsApp engine listener", () => {
  test("is enabled unless explicitly turned off", () => {
    delete process.env.ATLAS_CESA_WHATSAPP_ENGINE;
    expect(cesaWhatsAppEngineEnabled()).toBe(true);
    process.env.ATLAS_CESA_WHATSAPP_ENGINE = "off";
    expect(cesaWhatsAppEngineEnabled()).toBe(false);
  });

  test("serves the CESA health contract on the loopback engine port", async () => {
    const started = await startCesaWhatsAppEngineServer({
      engine: {
        health: () => ({ connected: 0, ok: true, sessions: 0 }),
        messageStatus: () => {
          throw new Error("unused");
        },
        restoreSessions: async () => undefined,
        sendText: async () => ({ ok: false, status: "failed" }),
        session: () => {
          throw new Error("unused");
        },
        shutdown: async () => undefined,
        startSession: async () => {
          throw new Error("unused");
        },
        stopSession: async () => {
          throw new Error("unused");
        },
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const response = await fetch(
        `http://${started.hostname}:${started.port}/health`
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        connected: 0,
        ok: true,
        sessions: 0,
      });
    } finally {
      await started.stop();
    }
  });
});
