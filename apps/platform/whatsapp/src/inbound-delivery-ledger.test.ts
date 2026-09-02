import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboundDeliveryLedger } from "./inbound-delivery-ledger";

describe("InboundDeliveryLedger", () => {
  test("persists completed deliveries across worker restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-wa-ledger-"));
    const path = join(directory, "inbound.jsonl");

    try {
      const first = new InboundDeliveryLedger(path);
      await first.load();
      expect(first.claim("chat:sender:message-1")).toBe(true);
      await first.complete("chat:sender:message-1");

      const restarted = new InboundDeliveryLedger(path);
      await restarted.load();
      expect(restarted.claim("chat:sender:message-1")).toBe(false);
      expect(restarted.claim("chat:sender:message-2")).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("releases failed deliveries so a provider replay can retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-wa-ledger-"));
    const path = join(directory, "inbound.jsonl");

    try {
      const ledger = new InboundDeliveryLedger(path);
      expect(ledger.claim("chat:sender:message-1")).toBe(true);
      expect(ledger.claim("chat:sender:message-1")).toBe(false);
      ledger.release("chat:sender:message-1");
      expect(ledger.claim("chat:sender:message-1")).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("drops expired records while loading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-wa-ledger-"));
    const path = join(directory, "inbound.jsonl");
    let now = 1000;

    try {
      const first = new InboundDeliveryLedger(path, {
        now: () => now,
        retentionMs: 100,
      });
      expect(first.claim("old-message")).toBe(true);
      await first.complete("old-message");

      now = 1101;
      const restarted = new InboundDeliveryLedger(path, {
        now: () => now,
        retentionMs: 100,
      });
      await restarted.load();
      expect(restarted.claim("old-message")).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("bounds the persisted log when records expire during long uptime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-wa-ledger-"));
    const path = join(directory, "inbound.jsonl");
    let now = 1000;

    try {
      const ledger = new InboundDeliveryLedger(path, {
        maxCompleted: 3,
        now: () => now,
        retentionMs: 10,
      });
      for (let index = 0; index < 12; index += 1) {
        const id = `message-${index}`;
        expect(ledger.claim(id)).toBe(true);
        await ledger.complete(id);
        now += 11;
      }

      const records = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(records.length).toBeLessThanOrEqual(3);

      const restarted = new InboundDeliveryLedger(path, {
        maxCompleted: 3,
        now: () => now,
        retentionMs: 10,
      });
      await restarted.load();
      expect(restarted.claim("message-0")).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
