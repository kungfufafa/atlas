import { afterEach, describe, expect, test } from "bun:test";
import { createMinimalHonoApp } from "../test-app-helpers";

const previousToken = process.env.ATLAS_CESA_WHATSAPP_TOKEN;

afterEach(() => {
  if (previousToken === undefined) {
    delete process.env.ATLAS_CESA_WHATSAPP_TOKEN;
    return;
  }
  process.env.ATLAS_CESA_WHATSAPP_TOKEN = previousToken;
});

describe("CESA WhatsApp engine routes", () => {
  test("forwards a loopback request when no token is configured", async () => {
    delete process.env.ATLAS_CESA_WHATSAPP_TOKEN;
    const { app } = createMinimalHonoApp({
      cesaWhatsAppEngine: {
        handle: async () =>
          Response.json({ connected: 0, ok: true, sessions: 0 }),
      },
    });

    const response = await app.fetch(
      new Request("http://127.0.0.1:4310/v1/integrations/cesa/whatsapp/health")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connected: 0,
      ok: true,
      sessions: 0,
    });
  });

  test("rejects a public host without a token", async () => {
    delete process.env.ATLAS_CESA_WHATSAPP_TOKEN;
    const { app } = createMinimalHonoApp({
      cesaWhatsAppEngine: {
        handle: async () => Response.json({ ok: true }),
      },
    });

    const response = await app.fetch(
      new Request("http://atlas.example/v1/integrations/cesa/whatsapp/health")
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error_code: "unauthorized",
      ok: false,
    });
  });

  test("accepts a bearer token on a public host", async () => {
    process.env.ATLAS_CESA_WHATSAPP_TOKEN = "cesa-secret";
    const { app } = createMinimalHonoApp({
      cesaWhatsAppEngine: {
        handle: async () => Response.json({ ok: true, routed: true }),
      },
    });

    const response = await app.fetch(
      new Request("http://atlas.example/v1/integrations/cesa/whatsapp/health", {
        headers: { Authorization: "Bearer cesa-secret" },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, routed: true });
  });

  test("returns 503 when the engine handle is not mounted", async () => {
    delete process.env.ATLAS_CESA_WHATSAPP_TOKEN;
    const { app } = createMinimalHonoApp();

    const response = await app.fetch(
      new Request("http://127.0.0.1:4310/v1/integrations/cesa/whatsapp/health")
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error_code: "engine_offline",
      ok: false,
      retryable: true,
    });
  });
});
