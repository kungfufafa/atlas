import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCesaWhatsAppEngine } from "./engine";

const reasons = {
  connectionReplaced: 440,
  forbidden: 403,
  loggedOut: 401,
  multideviceMismatch: 411,
  restartRequired: 515,
};

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "atlas-cesa-engine-"));
  const sockets: Array<{ ev: EventEmitter }> = [];
  const engine = createCesaWhatsAppEngine({
    disconnectReasons: reasons,
    fetchVersion: async () => ({ version: [2, 3000, 1] }),
    journalRoot: join(root, "journal"),
    makeSocket: () => {
      const ev = new EventEmitter();
      const sock = {
        end() {},
        ev,
        sendMessage: async () => ({}),
        user: { id: "6281234567890:7@s.whatsapp.net" },
      };
      sockets.push(sock);
      return sock;
    },
    maxReconnect: 2,
    qrToDataURL: async (qr) => `data:${qr}`,
    reconnectDelay: () => 10,
    sessionRoot: join(root, "sessions"),
    useAuthState: async () => ({
      saveCreds: async () => undefined,
      state: { creds: { registered: false }, keys: {} },
    }),
  });
  return { engine, root, sockets };
}

describe("CESA WhatsApp engine reconnect", () => {
  const fixtures: Array<ReturnType<typeof createFixture>> = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await fixture.engine.shutdown();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("keeps saved credentials and reconnects after a 500 stream error", async () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    await fixture.engine.startSession("rekrutmen-1", { mode: "qr" });
    const creds = join(fixture.root, "sessions", "rekrutmen-1", "creds.json");
    mkdirSync(join(fixture.root, "sessions", "rekrutmen-1"), {
      recursive: true,
    });
    writeFileSync(creds, "{}");
    fixture.sockets[0]?.ev.emit("connection.update", { connection: "open" });
    fixture.sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });

    expect(existsSync(creds)).toBe(true);
    expect(fixture.engine.session("rekrutmen-1").status).toBe("connecting");
    await pause(25);
    expect(fixture.sockets).toHaveLength(2);
    expect(existsSync(creds)).toBe(true);
  });

  test("wipes credentials only after a terminal logout", async () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    await fixture.engine.startSession("rekrutmen-1", { mode: "qr" });
    const directory = join(fixture.root, "sessions", "rekrutmen-1");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "creds.json"), "{}");
    fixture.sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { statusCode: 401 } },
    });
    await pause(15);
    expect(existsSync(directory)).toBe(false);
    expect(fixture.engine.session("rekrutmen-1").status).toBe("disconnected");
    expect(fixture.sockets).toHaveLength(1);
  });
});
