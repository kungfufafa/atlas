export type WhatsAppSettingsStatusInput = {
  awaitingDevicePairingCode: boolean;
  awaitingQr: boolean;
  configured: boolean;
  connected: boolean;
  linkingAfterScan: boolean;
  paired: boolean;
  running: boolean;
  showDevicePairingCode: boolean;
  showQr: boolean;
};

export type WhatsAppSettingsStatus = {
  headerConnected: boolean;
  headerSubtitle: string;
  statusBadge: string;
};

export function resolveWhatsAppSettingsStatus(
  input: WhatsAppSettingsStatusInput
): WhatsAppSettingsStatus {
  if (!input.configured) {
    return {
      headerConnected: false,
      headerSubtitle: "Choose a reply profile, then enable WhatsApp",
      statusBadge: "Not set up",
    };
  }

  if (input.paired && input.running && input.connected) {
    return {
      headerConnected: true,
      headerSubtitle: "WhatsApp is connected and ready to receive messages",
      statusBadge: "Connected",
    };
  }

  if (input.paired && input.running) {
    return {
      headerConnected: false,
      headerSubtitle: "WhatsApp is linked, but the socket is disconnected",
      statusBadge: "Disconnected",
    };
  }

  if (input.paired) {
    return {
      headerConnected: false,
      headerSubtitle:
        "WhatsApp is linked. Start the bridge to receive messages",
      statusBadge: "Bridge stopped",
    };
  }

  if (!input.running) {
    return {
      headerConnected: false,
      headerSubtitle: "Bridge stopped — start it to get a link code or QR",
      statusBadge: "Stopped",
    };
  }

  if (input.showDevicePairingCode) {
    return {
      headerConnected: false,
      headerSubtitle:
        "Enter the Linked Devices code in WhatsApp, or scan the QR code",
      statusBadge: "Awaiting link",
    };
  }

  if (input.showQr) {
    return {
      headerConnected: false,
      headerSubtitle: "Scan the QR code in WhatsApp to link this device",
      statusBadge: "Awaiting scan",
    };
  }

  if (input.linkingAfterScan) {
    return {
      headerConnected: false,
      headerSubtitle: "Connecting WhatsApp…",
      statusBadge: "Connecting",
    };
  }

  if (input.awaitingDevicePairingCode) {
    return {
      headerConnected: false,
      headerSubtitle: "Requesting link code…",
      statusBadge: "Starting…",
    };
  }

  if (input.awaitingQr) {
    return {
      headerConnected: false,
      headerSubtitle: "Preparing QR code…",
      statusBadge: "Starting…",
    };
  }

  return {
    headerConnected: false,
    headerSubtitle: "Scan the QR code in WhatsApp to connect",
    statusBadge: "Not connected",
  };
}
