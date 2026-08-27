import type { ChannelAccessMode } from "@atlas/core/contract";

export function formatWhatsAppDevicePairingCode(code: string): string {
  const compactCode = code.replace(/[\s-]/g, "").toUpperCase();
  if (compactCode.length === 8) {
    return `${compactCode.slice(0, 4)}-${compactCode.slice(4)}`;
  }

  return code.trim().toUpperCase();
}

export function shouldShowWhatsAppChatAccessSection(
  accessMode: ChannelAccessMode
): boolean {
  return accessMode === "pairing";
}
