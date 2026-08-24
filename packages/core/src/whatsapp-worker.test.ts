import { describe, expect, test } from "bun:test";
import { withTempHomedir } from "./testing/channel-config-fixtures";
import { saveWhatsAppConfig } from "./whatsapp-config";
import {
  clearWhatsAppDevicePairingCode,
  readWhatsAppDevicePairingCode,
  resolveWhatsAppWorkerStatus,
  writeWhatsAppDevicePairingCode,
} from "./whatsapp-worker";

const unpairedSettings = {
  accessMode: "pairing" as const,
  allowedNumbers: [],
  blockedNumbers: [],
  configured: true,
  pairedJid: null,
  pairingCode: null,
  phoneNumberMasked: "+••••••••90",
  profileId: "default",
};

describe("resolveWhatsAppWorkerStatus", () => {
  test("includes a device pairing code while the session is unpaired", () => {
    expect(
      resolveWhatsAppWorkerStatus(
        unpairedSettings,
        true,
        "qr-payload",
        false,
        "ABCD1234"
      )
    ).toEqual({
      configured: true,
      connected: false,
      devicePairingCode: "ABCD1234",
      ok: true,
      paired: false,
      qrCode: "qr-payload",
      running: true,
    });
  });

  test("hides the device pairing code after the session is paired", () => {
    expect(
      resolveWhatsAppWorkerStatus(
        {
          ...unpairedSettings,
          pairedJid: "6281234567890@s.whatsapp.net",
        },
        true,
        null,
        true,
        "ABCD1234"
      ).devicePairingCode
    ).toBeNull();
  });
});

describe("WhatsApp device pairing code file", () => {
  test("writes, reads, and clears the worker pairing code", async () => {
    await withTempHomedir("atlas-core-wa-pair-file-", async () => {
      await saveWhatsAppConfig({ phoneNumber: "+6281234567890" });
      await writeWhatsAppDevicePairingCode("WXYZ9876");
      expect(await readWhatsAppDevicePairingCode()).toBe("WXYZ9876");
      await clearWhatsAppDevicePairingCode();
      expect(await readWhatsAppDevicePairingCode()).toBeNull();
    });
  });
});
