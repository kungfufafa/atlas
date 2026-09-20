import { describe, expect, test } from "bun:test";
import { resolveWhatsAppSettingsStatus } from "./whatsapp-settings-status";

const idle = {
  awaitingDevicePairingCode: false,
  awaitingQr: false,
  configured: true,
  connected: false,
  linkingAfterScan: false,
  paired: false,
  running: false,
  showDevicePairingCode: false,
  showQr: false,
};

describe("resolveWhatsAppSettingsStatus", () => {
  test("marks Connected only when paired, running, and the heartbeat socket is live", () => {
    const live = resolveWhatsAppSettingsStatus({
      ...idle,
      connected: true,
      paired: true,
      running: true,
    });
    expect(live.statusBadge).toBe("Connected");
    expect(live.headerConnected).toBe(true);

    const deadSocket = resolveWhatsAppSettingsStatus({
      ...idle,
      paired: true,
      running: true,
    });
    expect(deadSocket.statusBadge).toBe("Disconnected");
    expect(deadSocket.headerConnected).toBe(false);
  });

  test("does not treat a stopped or unpaired worker as Connected", () => {
    expect(
      resolveWhatsAppSettingsStatus({
        ...idle,
        paired: true,
      }).statusBadge
    ).toBe("Bridge stopped");
    expect(
      resolveWhatsAppSettingsStatus({
        ...idle,
        running: true,
      }).statusBadge
    ).toBe("Not connected");
    expect(
      resolveWhatsAppSettingsStatus({
        ...idle,
        configured: false,
        connected: true,
        paired: true,
        running: true,
      }).statusBadge
    ).toBe("Not set up");
  });
});
