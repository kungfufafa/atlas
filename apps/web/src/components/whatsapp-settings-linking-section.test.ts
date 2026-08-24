import { describe, expect, test } from "bun:test";
import {
  formatWhatsAppDevicePairingCode,
  shouldShowWhatsAppChatAccessSection,
} from "./whatsapp-settings-linking-section";

describe("formatWhatsAppDevicePairingCode", () => {
  test("inserts a dash in an 8-character code", () => {
    expect(formatWhatsAppDevicePairingCode("abcd1234")).toBe("ABCD-1234");
    expect(formatWhatsAppDevicePairingCode("ABCD-1234")).toBe("ABCD-1234");
  });

  test("returns trimmed uppercase when the code is not 8 characters", () => {
    expect(formatWhatsAppDevicePairingCode(" ab12 ")).toBe("AB12");
  });
});

describe("shouldShowWhatsAppChatAccessSection", () => {
  test("shows chat access codes only in pairing mode", () => {
    expect(shouldShowWhatsAppChatAccessSection("pairing")).toBe(true);
    expect(shouldShowWhatsAppChatAccessSection("open")).toBe(false);
    expect(shouldShowWhatsAppChatAccessSection("allowlist")).toBe(false);
    expect(shouldShowWhatsAppChatAccessSection("denylist")).toBe(false);
  });
});
