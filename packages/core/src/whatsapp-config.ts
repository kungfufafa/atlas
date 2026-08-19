import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelAccessMode } from "./contract";
import {
  parseIni,
  pathExists,
  readTextOrNull,
  removeFile,
  writePrivateTextFile,
} from "./fs";
import { getWorkspaceChannelDir } from "./workspace-channel-paths";

export const DEFAULT_WHATSAPP_PROFILE_ID = "default";

export interface WhatsAppConfigFile {
  accessMode: ChannelAccessMode;
  allowedNumbers: string[];
  blockedNumbers: string[];
  outboundPort?: string | null;
  pairedJid: string | null;
  pairedLid: string | null;
  pairingCode: string | null;
  phoneNumber: string;
  profileId: string;
}

export interface WhatsAppSettingsPublic {
  accessMode: ChannelAccessMode;
  allowedNumbers: string[];
  blockedNumbers: string[];
  configured: boolean;
  pairedJid: string | null;
  pairingCode: string | null;
  phoneNumberMasked: string | null;
  profileId: string;
}

export interface UpdateWhatsAppSettingsInput {
  accessMode?: ChannelAccessMode;
  allowedNumbers?: string[] | string;
  blockedNumbers?: string[] | string;
  phoneNumber?: string;
  profileId?: string;
}

export function getWhatsAppConfigDir(orgId?: string | null): string {
  return orgId === undefined
    ? getWorkspaceChannelDir("whatsapp")
    : getWorkspaceChannelDir("whatsapp", orgId);
}

export function getWhatsAppConfigPath(orgId?: string | null): string {
  return join(getWhatsAppConfigDir(orgId), "config.ini");
}

export function maskPhoneNumber(phoneNumber: string): string | null {
  const trimmed = phoneNumber.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= 4) {
    return `+${"•".repeat(trimmed.length)}`;
  }

  return `+${"•".repeat(Math.min(trimmed.length - 2, 10))}${trimmed.slice(-2)}`;
}

export function generatePairingCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

export function normalizePairingCode(input: string): string {
  return input.trim().replace(/\s+/g, "").toUpperCase();
}

export function normalizePhoneNumberDigits(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) {
    return "";
  }

  // Strip all non-digits
  let digits = trimmed.replace(/\D/g, "");
  // Normalize Indonesian local format 08... to 628...
  if (digits.startsWith("08")) {
    digits = `62${digits.slice(1)}`;
  }

  return digits;
}

export function parsePhoneNumberList(raw: string | string[]): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => normalizePhoneNumberDigits(item)).filter(Boolean);
  }

  const items = new Set<string>();
  for (const part of raw.split(/[,\s\n]+/)) {
    const digits = normalizePhoneNumberDigits(part);
    if (digits) {
      items.add(digits);
    }
  }

  return [...items];
}

function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

function phoneToWhatsAppJid(phone: string): string {
  return `${phoneDigits(phone)}@s.whatsapp.net`;
}

export function whatsAppUserDigits(jid: string): string {
  return normalizePhoneNumberDigits(jid.split("@")[0]?.split(":")[0] ?? "");
}

function maskPhoneNumberFromJid(jid: string | null): string | null {
  if (!jid) {
    return null;
  }

  const digits = whatsAppUserDigits(jid);
  return digits ? maskPhoneNumber(digits) : null;
}

function whatsAppJidServer(jid: string): string {
  return jid.split("@")[1]?.trim() ?? "";
}

function normalizeWhatsAppUserJid(jid: string): string {
  const server = whatsAppJidServer(jid);
  const user = jid.split("@")[0]?.split(":")[0] ?? "";

  if (!server) {
    return user;
  }

  return `${user}@${server}`;
}

function isSameWhatsAppUserJid(left: string, right: string): boolean {
  if (!(left && right)) {
    return false;
  }

  if (normalizeWhatsAppUserJid(left) === normalizeWhatsAppUserJid(right)) {
    return true;
  }

  if (
    whatsAppJidServer(left) !== "s.whatsapp.net" ||
    whatsAppJidServer(right) !== "s.whatsapp.net"
  ) {
    return false;
  }

  const leftDigits = whatsAppUserDigits(left);
  const rightDigits = whatsAppUserDigits(right);
  return Boolean(leftDigits && leftDigits === rightDigits);
}

export function isWhatsAppUserAuthorized(
  jid: string,
  config: Pick<
    WhatsAppConfigFile,
    | "accessMode"
    | "allowedNumbers"
    | "blockedNumbers"
    | "pairedJid"
    | "pairedLid"
  >
): boolean {
  const accessMode = config.accessMode || "pairing";
  const userDigits = whatsAppUserDigits(jid);

  if (accessMode === "open") {
    return true;
  }

  if (accessMode === "allowlist") {
    if (config.allowedNumbers && config.allowedNumbers.includes(userDigits)) {
      return true;
    }

    if (
      (config.pairedJid
        ? isSameWhatsAppUserJid(jid, config.pairedJid)
        : false) ||
      (config.pairedLid ? isSameWhatsAppUserJid(jid, config.pairedLid) : false)
    ) {
      return true;
    }

    return false;
  }

  if (accessMode === "denylist") {
    if (config.blockedNumbers && config.blockedNumbers.includes(userDigits)) {
      return false;
    }

    return true;
  }

  // "pairing" mode: strictly requires pairedJid / pairedLid
  if (
    (config.pairedJid ? isSameWhatsAppUserJid(jid, config.pairedJid) : false) ||
    (config.pairedLid ? isSameWhatsAppUserJid(jid, config.pairedLid) : false)
  ) {
    return true;
  }

  return false;
}

export async function loadWhatsAppConfigFile(
  orgId?: string | null
): Promise<WhatsAppConfigFile | null> {
  const raw = await readTextOrNull(getWhatsAppConfigPath(orgId));

  if (raw === null) {
    return null;
  }

  const values = parseIni(raw);
  const phoneNumber = values.phone_number?.trim() ?? "";
  const profileId = values.profile_id?.trim() || DEFAULT_WHATSAPP_PROFILE_ID;
  const pairingCode = values.pairing_code?.trim() || null;
  const pairedJid = values.paired_jid?.trim() || null;
  const pairedLid = values.paired_lid?.trim() || null;
  const outboundPort = values.outbound_port?.trim() || null;

  const accessModeRaw = values.access_mode?.trim()?.toLowerCase();
  const accessMode: ChannelAccessMode =
    accessModeRaw === "open" ||
    accessModeRaw === "allowlist" ||
    accessModeRaw === "denylist"
      ? accessModeRaw
      : "pairing";

  const allowedNumbers = values.allowed_numbers
    ? parsePhoneNumberList(values.allowed_numbers)
    : [];
  const blockedNumbers = values.blocked_numbers
    ? parsePhoneNumberList(values.blocked_numbers)
    : [];

  return {
    accessMode,
    allowedNumbers,
    blockedNumbers,
    outboundPort,
    pairedJid,
    pairedLid,
    pairingCode,
    phoneNumber,
    profileId,
  };
}

export function toWhatsAppSettingsPublic(
  file: WhatsAppConfigFile | null
): WhatsAppSettingsPublic {
  if (!file) {
    return {
      accessMode: "pairing",
      allowedNumbers: [],
      blockedNumbers: [],
      configured: false,
      pairedJid: null,
      pairingCode: null,
      phoneNumberMasked: null,
      profileId: DEFAULT_WHATSAPP_PROFILE_ID,
    };
  }

  return {
    accessMode: file.accessMode || "pairing",
    allowedNumbers: file.allowedNumbers || [],
    blockedNumbers: file.blockedNumbers || [],
    configured: true,
    pairedJid: file.pairedJid,
    pairingCode: file.pairingCode,
    phoneNumberMasked:
      maskPhoneNumber(file.phoneNumber) ??
      maskPhoneNumberFromJid(file.pairedJid),
    profileId: file.profileId,
  };
}

export async function loadWhatsAppSettingsPublic(
  orgId?: string | null
): Promise<WhatsAppSettingsPublic> {
  return toWhatsAppSettingsPublic(await loadWhatsAppConfigFile(orgId));
}

async function writeWhatsAppConfigFile(
  config: WhatsAppConfigFile,
  orgId?: string | null
): Promise<void> {
  const lines = [
    "# Atlas WhatsApp bridge",
    `profile_id=${config.profileId}`,
    `access_mode=${config.accessMode}`,
    ...(config.allowedNumbers.length > 0
      ? [`allowed_numbers=${config.allowedNumbers.join(",")}`]
      : []),
    ...(config.blockedNumbers.length > 0
      ? [`blocked_numbers=${config.blockedNumbers.join(",")}`]
      : []),
    ...(config.phoneNumber.trim()
      ? [`phone_number=${config.phoneNumber}`]
      : []),
    ...(config.pairingCode ? [`pairing_code=${config.pairingCode}`] : []),
    ...(config.pairedJid ? [`paired_jid=${config.pairedJid}`] : []),
    ...(config.pairedLid ? [`paired_lid=${config.pairedLid}`] : []),
    ...(config.outboundPort ? [`outbound_port=${config.outboundPort}`] : []),
    "",
  ];

  await writePrivateTextFile(getWhatsAppConfigPath(orgId), lines.join("\n"), {
    ensureDir: getWhatsAppConfigDir(orgId),
  });
}

function resolvePhoneNumber(
  input: UpdateWhatsAppSettingsInput,
  existing: WhatsAppConfigFile | null
): string {
  return input.phoneNumber === undefined
    ? (existing?.phoneNumber ?? "")
    : input.phoneNumber.trim();
}

function resolveProfileId(
  input: UpdateWhatsAppSettingsInput,
  existing: WhatsAppConfigFile | null
): string {
  return (
    input.profileId?.trim() ||
    existing?.profileId ||
    DEFAULT_WHATSAPP_PROFILE_ID
  );
}

function resolvePairingCode(
  existing: WhatsAppConfigFile | null,
  pairedJid: string | null
): string | null {
  if (pairedJid) {
    return null;
  }

  return existing?.pairingCode ?? null;
}

function buildSavedWhatsAppConfig(
  input: UpdateWhatsAppSettingsInput,
  existing: WhatsAppConfigFile | null
): WhatsAppConfigFile {
  const phoneNumber = resolvePhoneNumber(input, existing);
  const pairedJid = existing?.pairedJid ?? null;
  const accessMode = input.accessMode ?? existing?.accessMode ?? "pairing";
  const allowedNumbers =
    input.allowedNumbers === undefined
      ? (existing?.allowedNumbers ?? [])
      : parsePhoneNumberList(input.allowedNumbers);
  const blockedNumbers =
    input.blockedNumbers === undefined
      ? (existing?.blockedNumbers ?? [])
      : parsePhoneNumberList(input.blockedNumbers);

  return {
    accessMode,
    allowedNumbers,
    blockedNumbers,
    outboundPort: existing?.outboundPort ?? null,
    pairedJid,
    pairedLid: existing?.pairedLid ?? null,
    pairingCode: resolvePairingCode(existing, pairedJid),
    phoneNumber,
    profileId: resolveProfileId(input, existing),
  };
}

export async function saveWhatsAppConfig(
  input: UpdateWhatsAppSettingsInput,
  orgId?: string | null
): Promise<WhatsAppSettingsPublic> {
  const existing = await loadWhatsAppConfigFile(orgId);
  const next = buildSavedWhatsAppConfig(input, existing);
  await writeWhatsAppConfigFile(next, orgId);
  return toWhatsAppSettingsPublic(next);
}

export function getWhatsAppAuthDir(orgId?: string | null): string {
  return join(getWhatsAppConfigDir(orgId), "auth");
}

// ponytail: filename mirrors whatsapp-worker.ts QR_CODE_FILENAME
function getWhatsAppQrCodePath(orgId?: string | null): string {
  return join(getWhatsAppConfigDir(orgId), "worker-qr.txt");
}

export async function resetWhatsAppSessionForReconnect(
  orgId?: string | null
): Promise<WhatsAppSettingsPublic> {
  const existing = await loadWhatsAppConfigFile(orgId);

  if (!existing) {
    throw new Error("Enable WhatsApp in Integrations before reconnecting.");
  }

  if (await pathExists(getWhatsAppAuthDir(orgId))) {
    await rm(getWhatsAppAuthDir(orgId), { force: true, recursive: true });
  }

  const qrPath = getWhatsAppQrCodePath(orgId);
  if (await pathExists(qrPath)) {
    await removeFile(qrPath);
  }

  const next: WhatsAppConfigFile = {
    ...existing,
    pairedJid: null,
    pairedLid: null,
    pairingCode: null,
  };

  await writeWhatsAppConfigFile(next, orgId);
  return toWhatsAppSettingsPublic(next);
}

export async function regenerateWhatsAppPairingCode(
  orgId?: string | null
): Promise<WhatsAppSettingsPublic> {
  const existing = await loadWhatsAppConfigFile(orgId);

  if (!existing) {
    throw new Error("Enable WhatsApp before generating a chat access code.");
  }

  const next: WhatsAppConfigFile = {
    ...existing,
    pairingCode: generatePairingCode(),
  };

  await writeWhatsAppConfigFile(next, orgId);
  return toWhatsAppSettingsPublic(next);
}

export async function verifyAndPairWhatsAppUser(
  pairingCodeInput: string,
  jid: string,
  orgId?: string | null
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const config = await loadWhatsAppConfigFile(orgId);

  if (!config) {
    return {
      message: "WhatsApp is not configured on the server yet.",
      ok: false,
    };
  }

  if (isWhatsAppUserAuthorized(jid, config)) {
    return { message: "This chat is already authorized.", ok: true };
  }

  const expected = config.pairingCode;

  if (!expected) {
    return {
      message:
        "No chat access code is active. Generate one in Integrations → WhatsApp, then send it here.",
      ok: false,
    };
  }

  if (
    normalizePairingCode(pairingCodeInput) !== normalizePairingCode(expected)
  ) {
    return {
      message:
        "That chat access code is invalid. Copy the current code from Integrations → WhatsApp and try again.",
      ok: false,
    };
  }

  const isLid = jid.endsWith("@lid");
  const phoneFromJid = isLid ? "" : whatsAppUserDigits(jid);
  const pairedLid = isLid ? jid : config.pairedLid;
  const pairedJid = isLid
    ? (config.pairedJid ??
      (config.phoneNumber ? phoneToWhatsAppJid(config.phoneNumber) : null))
    : jid;

  await writeWhatsAppConfigFile(
    {
      ...config,
      pairedJid,
      pairedLid,
      pairingCode: null,
      phoneNumber: phoneFromJid || config.phoneNumber,
    },
    orgId
  );

  return {
    message: "Chat authorized. Send a message to start chatting with Atlas.",
    ok: true,
  };
}

/** After QR link, pair the owner and store their LID for inbound routing. */
export async function syncWhatsAppOwnerPairing(options: {
  ownerJid: string;
  ownerLid?: string | null;
  forceLidUpdate?: boolean;
  orgId?: string | null;
}): Promise<void> {
  const config = await loadWhatsAppConfigFile(options.orgId);

  if (!config) {
    return;
  }

  const isPhoneJid = whatsAppJidServer(options.ownerJid) === "s.whatsapp.net";
  const ownerPhone = isPhoneJid ? whatsAppUserDigits(options.ownerJid) : "";
  const ownerLid = options.ownerLid?.trim() || null;
  const pairedLid = options.forceLidUpdate
    ? (ownerLid ?? config.pairedLid)
    : (config.pairedLid ?? ownerLid);

  const next: WhatsAppConfigFile = {
    ...config,
    pairedJid: config.pairedJid ?? options.ownerJid,
    // Preserve an existing chat LID unless forceLidUpdate is true.
    pairedLid,
    pairingCode: null,
    phoneNumber: ownerPhone || config.phoneNumber,
  };

  if (
    next.pairedJid === config.pairedJid &&
    next.pairedLid === config.pairedLid &&
    next.pairingCode === config.pairingCode
  ) {
    return;
  }

  await writeWhatsAppConfigFile(next, options.orgId);
}

export async function saveWhatsAppOutboundPort(
  port: number,
  orgId?: string | null
): Promise<void> {
  const config = await loadWhatsAppConfigFile(orgId);
  if (!config) {
    return;
  }

  await writeWhatsAppConfigFile(
    { ...config, outboundPort: String(port) },
    orgId
  );
}

export function resolveWhatsAppConfigFromSources(options: {
  allowEnvCredentials?: boolean;
  env?: Record<string, string | undefined>;
  file?: WhatsAppConfigFile | null;
}): WhatsAppConfigFile | null {
  const env = options.env ?? process.env;
  const file = options.file ?? null;
  const allowEnvCredentials = options.allowEnvCredentials !== false;
  const envPhone = allowEnvCredentials
    ? env.WHATSAPP_PHONE_NUMBER?.trim()
    : undefined;

  if (!(file || envPhone)) {
    return null;
  }

  return {
    accessMode: file?.accessMode ?? "pairing",
    allowedNumbers: file?.allowedNumbers ?? [],
    blockedNumbers: file?.blockedNumbers ?? [],
    pairedJid: file?.pairedJid ?? null,
    pairedLid: file?.pairedLid ?? null,
    pairingCode: file?.pairingCode ?? null,
    phoneNumber: envPhone || file?.phoneNumber?.trim() || "",
    profileId:
      (allowEnvCredentials
        ? env.ATLAS_WHATSAPP_PROFILE_ID?.trim()
        : undefined) ||
      file?.profileId?.trim() ||
      DEFAULT_WHATSAPP_PROFILE_ID,
  };
}
