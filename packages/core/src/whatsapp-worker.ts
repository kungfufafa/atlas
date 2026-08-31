import { join } from "node:path";
import type { WhatsAppWorkerStatus } from "./contract";
import {
  pathExists,
  readTextOrNull,
  removeFile,
  writePrivateTextFile,
} from "./fs";
import {
  getWhatsAppConfigDir,
  loadWhatsAppSettingsPublic,
  type WhatsAppSettingsPublic,
} from "./whatsapp-config";

export interface WhatsAppWorkerHeartbeat {
  connected?: boolean;
  pid: number;
  updatedAt: string;
}

const DEFAULT_HEARTBEAT_MAX_AGE_MS = 45_000;
const DEVICE_PAIRING_CODE_FILENAME = "worker-pairing-code.txt";
const HEARTBEAT_FILENAME = "worker-heartbeat.json";
const QR_CODE_FILENAME = "worker-qr.txt";

export function getWhatsAppWorkerHeartbeatPath(orgId?: string | null): string {
  return join(getWhatsAppConfigDir(orgId), HEARTBEAT_FILENAME);
}

export function getWhatsAppQrCodePath(orgId?: string | null): string {
  return join(getWhatsAppConfigDir(orgId), QR_CODE_FILENAME);
}

export function getWhatsAppDevicePairingCodePath(
  orgId?: string | null
): string {
  return join(getWhatsAppConfigDir(orgId), DEVICE_PAIRING_CODE_FILENAME);
}

export function resolveWhatsAppWorkerStatus(
  settings: WhatsAppSettingsPublic,
  running: boolean,
  qrCode: string | null,
  connected = false,
  devicePairingCode: string | null = null
): WhatsAppWorkerStatus {
  const configured = settings.configured;
  const paired = settings.pairedJid !== null;
  const bridgeConnected = running && connected;
  const ok = !configured || (running && (!paired || bridgeConnected));

  return {
    configured,
    connected: bridgeConnected,
    devicePairingCode: paired ? null : devicePairingCode,
    ok,
    paired,
    qrCode,
    running,
  };
}

export function isWhatsAppProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isWhatsAppHeartbeatAlive(
  heartbeat: WhatsAppWorkerHeartbeat | null,
  maxAgeMs = DEFAULT_HEARTBEAT_MAX_AGE_MS
): boolean {
  if (!heartbeat) {
    return false;
  }

  const updatedAt = Date.parse(heartbeat.updatedAt);

  if (!Number.isFinite(updatedAt)) {
    return false;
  }

  if (Date.now() - updatedAt > maxAgeMs) {
    return false;
  }

  return isWhatsAppProcessAlive(heartbeat.pid);
}

export function parseWhatsAppWorkerHeartbeat(
  raw: string
): WhatsAppWorkerHeartbeat | null {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as WhatsAppWorkerHeartbeat).pid !== "number" ||
      typeof (parsed as WhatsAppWorkerHeartbeat).updatedAt !== "string"
    ) {
      return null;
    }

    return parsed as WhatsAppWorkerHeartbeat;
  } catch {
    return null;
  }
}

export async function writeWhatsAppWorkerHeartbeat(
  pid = process.pid,
  updatedAt = new Date().toISOString(),
  connected = false
): Promise<void> {
  const payload: WhatsAppWorkerHeartbeat = { connected, pid, updatedAt };

  await writePrivateTextFile(
    getWhatsAppWorkerHeartbeatPath(),
    `${JSON.stringify(payload)}\n`,
    { ensureDir: getWhatsAppConfigDir() }
  );
}

export async function clearWhatsAppWorkerHeartbeat(): Promise<void> {
  const path = getWhatsAppWorkerHeartbeatPath();

  if (await pathExists(path)) {
    await removeFile(path);
  }
}

export async function writeWhatsAppQrCode(qr: string): Promise<void> {
  await writePrivateTextFile(getWhatsAppQrCodePath(), qr, {
    ensureDir: getWhatsAppConfigDir(),
  });
}

export async function clearWhatsAppQrCode(): Promise<void> {
  const path = getWhatsAppQrCodePath();

  if (await pathExists(path)) {
    await removeFile(path);
  }
}

export async function readWhatsAppQrCode(): Promise<string | null> {
  const raw = await readTextOrNull(getWhatsAppQrCodePath());
  return raw?.trim() || null;
}

export async function writeWhatsAppDevicePairingCode(
  code: string
): Promise<void> {
  await writePrivateTextFile(getWhatsAppDevicePairingCodePath(), code, {
    ensureDir: getWhatsAppConfigDir(),
  });
}

export async function clearWhatsAppDevicePairingCode(): Promise<void> {
  const path = getWhatsAppDevicePairingCodePath();

  if (await pathExists(path)) {
    await removeFile(path);
  }
}

export async function readWhatsAppDevicePairingCode(): Promise<string | null> {
  const raw = await readTextOrNull(getWhatsAppDevicePairingCodePath());
  return raw?.trim() || null;
}

export async function readWhatsAppWorkerHeartbeat(): Promise<WhatsAppWorkerHeartbeat | null> {
  const raw = await readTextOrNull(getWhatsAppWorkerHeartbeatPath());

  if (raw === null) {
    return null;
  }

  return parseWhatsAppWorkerHeartbeat(raw.trim());
}

export async function isWhatsAppWorkerRunning(
  maxAgeMs = DEFAULT_HEARTBEAT_MAX_AGE_MS
): Promise<boolean> {
  return isWhatsAppHeartbeatAlive(
    await readWhatsAppWorkerHeartbeat(),
    maxAgeMs
  );
}

export async function getWhatsAppWorkerStatus(
  orgId?: string | null
): Promise<WhatsAppWorkerStatus> {
  const settings = await loadWhatsAppSettingsPublic(orgId);
  const heartbeatRaw = await readTextOrNull(
    getWhatsAppWorkerHeartbeatPath(orgId)
  );
  const heartbeat =
    heartbeatRaw === null
      ? null
      : parseWhatsAppWorkerHeartbeat(heartbeatRaw.trim());
  const running = isWhatsAppHeartbeatAlive(heartbeat);
  const qrRaw = await readTextOrNull(getWhatsAppQrCodePath(orgId));
  const qrCode = qrRaw?.trim() || null;
  const pairingRaw = await readTextOrNull(
    getWhatsAppDevicePairingCodePath(orgId)
  );
  const devicePairingCode = pairingRaw?.trim() || null;
  const connected = heartbeat?.connected === true;

  return resolveWhatsAppWorkerStatus(
    settings,
    running,
    qrCode,
    connected,
    devicePairingCode
  );
}
