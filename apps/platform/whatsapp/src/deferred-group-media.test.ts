import { expect, test } from "bun:test";
import type { WAMessage } from "@whiskeysockets/baileys";
import { DeferredWhatsAppGroupMedia } from "./deferred-group-media";

const scope = {
  jid: "123@g.us",
  orgId: "org-a",
  senderJid: "123@s.whatsapp.net",
};
function message(id: string): WAMessage {
  return {
    key: { id, remoteJid: scope.jid },
    message: { documentMessage: { fileName: "report.txt" } },
  };
}

test("recovers original metadata from its warning only in the same sender, chat and workspace", () => {
  const registry = new DeferredWhatsAppGroupMedia();
  const original = message("source");
  registry.remember(scope, original);
  registry.bindWarning(scope, "source", "warning");
  expect(registry.get(scope, "warning")).toBe(original);
  expect(registry.get(scope, "source")).toBe(original);
  expect(registry.get({ ...scope, orgId: "org-b" }, "warning")).toBeUndefined();
  expect(
    registry.get({ ...scope, senderJid: "other" }, "warning")
  ).toBeUndefined();
  expect(
    registry.get({ ...scope, jid: "other@g.us" }, "warning")
  ).toBeUndefined();
});

test("expires metadata and bounds retained messages", () => {
  let now = 100;
  const registry = new DeferredWhatsAppGroupMedia(
    { maxEntries: 2, ttlMs: 100 },
    () => now
  );
  registry.remember(scope, message("one"));
  registry.remember(scope, message("two"));
  registry.remember(scope, message("three"));
  expect(registry.get(scope, "one")).toBeUndefined();
  expect(registry.get(scope, "two")).toBeDefined();
  now = 200;
  expect(registry.get(scope, "two")).toBeUndefined();
  expect(registry.get(scope, "three")).toBeUndefined();
});

test("does not retain oversized inbound metadata", () => {
  const registry = new DeferredWhatsAppGroupMedia();
  const original = message("oversized");
  original.message = { documentMessage: { fileName: "x".repeat(256 * 1024) } };
  expect(registry.remember(scope, original)).toBe(false);
  expect(registry.get(scope, "oversized")).toBeUndefined();
});
