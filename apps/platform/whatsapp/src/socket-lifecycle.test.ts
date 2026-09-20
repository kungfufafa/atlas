import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SocketConfig } from "@whiskeysockets/baileys";
import * as baileys from "@whiskeysockets/baileys";

const sockets: Array<{
  end: ReturnType<typeof mock>;
  ev: EventEmitter;
  options: SocketConfig;
}> = [];
const startFailures: Error[] = [];
mock.module("@whiskeysockets/baileys", () => ({
  ...baileys,
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
  makeWASocket: (options: SocketConfig) => {
    const failure = startFailures.shift();
    if (failure) {
      throw failure;
    }
    const socket = { end: mock(() => {}), ev: new EventEmitter(), options };
    sockets.push(socket);
    return socket;
  },
}));
const { createWhatsAppSocket } = await import("./socket");
const handles: Array<Awaited<ReturnType<typeof createWhatsAppSocket>>> = [];
const directories: string[] = [];
const originalConfigDir = process.env.ATLAS_CONFIG_DIR;
const originalUmask = process.umask();

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.stop();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
  sockets.splice(0);
  startFailures.splice(0);
  if (originalConfigDir === undefined) {
    delete process.env.ATLAS_CONFIG_DIR;
  } else {
    process.env.ATLAS_CONFIG_DIR = originalConfigDir;
  }
  process.umask(originalUmask);
});

async function startSocket() {
  const directory = await mkdtemp(join(tmpdir(), "atlas-socket-lifecycle-"));
  directories.push(directory);
  process.env.ATLAS_CONFIG_DIR = directory;
  const handle = await createWhatsAppSocket({ onMessage: async () => {} });
  handles.push(handle);
  await handle.start();
  return handle;
}

async function closeSocket(index: number, error: unknown) {
  for (const listener of sockets[index].ev.listeners("connection.update")) {
    await listener({ connection: "close", lastDisconnect: { error } });
  }
}

describe("WhatsApp socket recovery integration", () => {
  test("a transient socket-construction failure remains in the bounded recovery loop", async () => {
    const handle = await startSocket();
    startFailures.push(new Error("temporary socket initialization failure"));
    await closeSocket(0, { statusCode: 408 });
    await Bun.sleep(1100);
    expect(handle.socket).toBeNull();
    expect(sockets).toHaveLength(1);
    await Bun.sleep(2100);
    expect(sockets).toHaveLength(2);
    expect(handle.socket).toBe(sockets[1]);
  });

  test("an unauthorized transport retires the socket and prevents automatic/manual timeout restarts", async () => {
    const handle = await startSocket();
    await closeSocket(0, { cause: { statusCode: "401" } });
    expect(handle.socket).toBeNull();
    expect(sockets[0].end).toHaveBeenCalledTimes(1);
    await handle.start();
    expect(sockets).toHaveLength(1);
  });

  test("a manual restart supersedes an old reconnect timer and retains exhausted retry counts", async () => {
    const handle = await startSocket();
    const old = sockets[0];
    old.options.msgRetryCounterCache?.set("failed-message", 5);
    await closeSocket(0, { output: { statusCode: 408 } });
    expect(handle.socket).toBeNull();
    await handle.start();
    expect(sockets).toHaveLength(2);
    expect(sockets[1].options.msgRetryCounterCache?.get("failed-message")).toBe(
      5
    );
    expect(sockets[1].options.placeholderResendCache).toBe(
      old.options.placeholderResendCache
    );
    await Bun.sleep(1100);
    expect(sockets).toHaveLength(2);
    expect(handle.socket).toBe(sockets[1]);
  });

  test("stopping during backoff cancels a scheduled reconnect", async () => {
    const handle = await startSocket();
    await closeSocket(0, { statusCode: 428 });
    await handle.stop();
    await Bun.sleep(1100);
    expect(sockets).toHaveLength(1);
    expect(handle.socket).toBeNull();
  });
});
