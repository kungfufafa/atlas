import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCesaWhatsAppEngine } from "./engine";
import { handleCesaWhatsAppEngineRequest } from "./http";

const reasons = {
  connectionReplaced: 440,
  forbidden: 403,
  loggedOut: 401,
  multideviceMismatch: 411,
  restartRequired: 515,
};

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "atlas-cesa-wa-"));
  const sockets: Array<{
    ev: EventEmitter;
    sendMessage: (
      jid: string,
      content: { text: string },
      options: { messageId: string }
    ) => Promise<unknown>;
  }> = [];
  const sent: Array<{ jid: string; text: string }> = [];
  const engine = createCesaWhatsAppEngine({
    disconnectReasons: reasons,
    fetchVersion: async () => ({ version: [2, 3000, 1] }),
    journalRoot: join(root, "journal"),
    makeSocket: () => {
      const ev = new EventEmitter();
      const sock = {
        end() {},
        ev,
        sendMessage: async (
          jid: string,
          content: { text: string },
          _options: { messageId: string }
        ) => {
          sent.push({ jid, text: content.text });
          return {};
        },
        user: { id: "6281234567890:7@s.whatsapp.net" },
      };
      sockets.push(sock);
      return sock;
    },
    qrToDataURL: async (qr) => `data:image/png;base64,${qr}`,
    sessionRoot: join(root, "sessions"),
    useAuthState: async () => ({
      saveCreds: async () => undefined,
      state: { creds: { registered: false }, keys: {} },
    }),
  });
  return { engine, root, sent, sockets };
}

describe("CESA WhatsApp engine HTTP contract", () => {
  const fixtures: Array<ReturnType<typeof createFixture>> = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await fixture.engine.shutdown();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("lets CESA connect, send once, and reuse the idempotency key", async () => {
    const fixture = createFixture();
    fixtures.push(fixture);

    const health = await handleCesaWhatsAppEngineRequest(
      new Request("http://127.0.0.1:3318/health"),
      fixture.engine
    );
    expect(health.status).toBe(200);
    const healthJson = (await health.json()) as {
      connected: number;
      ok: boolean;
      sessions: number;
      uptime_ms: number;
    };
    expect(healthJson).toMatchObject({
      connected: 0,
      ok: true,
      sessions: 0,
    });
    expect(healthJson.uptime_ms).toBeGreaterThanOrEqual(0);

    const started = await handleCesaWhatsAppEngineRequest(
      new Request("http://127.0.0.1:3318/sessions", {
        body: JSON.stringify({ id: "rekrutmen-1", mode: "qr" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      fixture.engine
    );
    expect(started.status).toBe(200);
    fixture.sockets
      .at(-1)
      ?.ev.emit("connection.update", { connection: "open" });

    const session = await handleCesaWhatsAppEngineRequest(
      new Request("http://127.0.0.1:3318/sessions/rekrutmen-1"),
      fixture.engine
    );
    expect(await session.json()).toMatchObject({
      id: "rekrutmen-1",
      ok: true,
      phone: "6281234567890",
      status: "connected",
    });

    const body = {
      idempotency_key: "delivery-1",
      phone: "081234567890",
      text: "Jadwal wawancara",
    };
    const first = await handleCesaWhatsAppEngineRequest(
      new Request("http://127.0.0.1:3318/sessions/rekrutmen-1/send", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      fixture.engine
    );
    const firstJson = (await first.json()) as { status: string };
    expect(first.status).toBe(200);
    expect(firstJson.status).toBe("sent");
    expect(fixture.sent).toEqual([
      { jid: "6281234567890@s.whatsapp.net", text: "Jadwal wawancara" },
    ]);

    const replay = await handleCesaWhatsAppEngineRequest(
      new Request("http://127.0.0.1:3318/sessions/rekrutmen-1/send", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      fixture.engine
    );
    expect(((await replay.json()) as { status: string }).status).toBe("sent");
    expect(fixture.sent).toHaveLength(1);

    const prefixed = await handleCesaWhatsAppEngineRequest(
      new Request(
        "http://atlas.test/v1/integrations/cesa/whatsapp/sessions/rekrutmen-1"
      ),
      fixture.engine,
      "/v1/integrations/cesa/whatsapp/sessions/rekrutmen-1"
    );
    expect(((await prefixed.json()) as { status: string }).status).toBe(
      "connected"
    );
  });

  test("returns a retryable failed send before the session is connected", async () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    const response = await handleCesaWhatsAppEngineRequest(
      new Request("http://127.0.0.1:3318/sessions/rekrutmen-1/send", {
        body: JSON.stringify({
          idempotency_key: "delivery-1",
          phone: "081234567890",
          text: "Jadwal wawancara",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      fixture.engine
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      retryable: true,
      status: "failed",
    });
  });

  test("rejects an unknown session id the same way CESA does", async () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    const response = await handleCesaWhatsAppEngineRequest(
      new Request("http://127.0.0.1:3318/sessions/not-cesa"),
      fixture.engine
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error_code: "invalid_session",
      ok: false,
    });
  });
});
