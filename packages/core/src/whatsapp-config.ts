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
  pairingAssertion?: string | null;
  pairingCode: string | null;
  pairingUserId?: string | null;
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

export function whatsAppUserDigits(jid: string): string {
  if (isWhatsAppLidJid(jid)) {
    return "";
  }

  return normalizePhoneNumberDigits(jid.split("@")[0]?.split(":")[0] ?? "");
}

export interface WhatsAppAuthorizationInput {
  jid: string;
  mappedPhoneJid?: string | null;
  participantPn?: string | null;
  senderPn?: string | null;
}

export interface WhatsAppAuthIdentity {
  jid: string;
  phoneDigits: string;
  phoneJid: string | null;
}

export function isWhatsAppLidJid(jid: string): boolean {
  return whatsAppJidServer(jid).toLowerCase() === "lid";
}

export function toWhatsAppPhoneJid(
  value: string | null | undefined
): string | null {
  if (!value?.trim()) {
    return null;
  }

  const trimmed = value.trim();
  if (isWhatsAppLidJid(trimmed)) {
    return null;
  }

  const digits = trimmed.includes("@")
    ? whatsAppUserDigits(trimmed)
    : normalizePhoneNumberDigits(trimmed);

  if (!digits) {
    return null;
  }

  return `${digits}@s.whatsapp.net`;
}

export function isWhatsAppOutboundDestinationAllowed(
  config: WhatsAppConfigFile,
  destinationJid: string
): boolean {
  const destDigits = whatsAppUserDigits(destinationJid);
  if (!destDigits) {
    return false;
  }

  const ownerDigits =
    whatsAppUserDigits(config.pairedJid ?? "") ||
    normalizePhoneNumberDigits(config.phoneNumber);
  if (ownerDigits && destDigits === ownerDigits) {
    return true;
  }

  if (config.accessMode === "allowlist") {
    return config.allowedNumbers.includes(destDigits);
  }

  if (config.accessMode === "denylist") {
    return !config.blockedNumbers.includes(destDigits);
  }

  return true;
}

export function resolveWhatsAppOutboundDestination(
  config: WhatsAppConfigFile,
  to?: string | null
): { error: string } | { jid: string } {
  if (!config.pairedJid?.trim()) {
    return { error: "WhatsApp is not paired in this workspace." };
  }

  const jid = to?.trim() ? toWhatsAppPhoneJid(to) : config.pairedJid.trim();

  if (!jid) {
    return {
      error:
        "Need a WhatsApp phone number to send to (for example 6281234567890).",
    };
  }

  if (!isWhatsAppOutboundDestinationAllowed(config, jid)) {
    return {
      error:
        "That number is not on this workspace WhatsApp allowlist. Add it under Integrations → WhatsApp, then send again.",
    };
  }

  return { jid };
}

export function resolveWhatsAppAuthIdentity(
  input: WhatsAppAuthorizationInput
): WhatsAppAuthIdentity {
  const jid = input.jid.trim();
  const candidates = [
    isWhatsAppLidJid(jid) ? null : jid,
    input.senderPn,
    input.participantPn,
    input.mappedPhoneJid,
  ];

  for (const candidate of candidates) {
    const phoneJid = toWhatsAppPhoneJid(candidate);
    if (phoneJid) {
      return {
        jid,
        phoneDigits: whatsAppUserDigits(phoneJid),
        phoneJid,
      };
    }
  }

  return { jid, phoneDigits: "", phoneJid: null };
}

export function getWhatsAppLidMapPath(orgId?: string | null): string {
  return join(getWhatsAppConfigDir(orgId), "lid-map.json");
}

export function whatsAppLidMapKey(jid: string): string | null {
  if (!isWhatsAppLidJid(jid)) {
    return null;
  }

  const user = jid.split("@")[0]?.split(":")[0] ?? "";
  if (!user) {
    return null;
  }

  return `${user}@lid`;
}

export function lookupWhatsAppLidPhone(
  map: Record<string, string>,
  lid: string
): string | null {
  const key = whatsAppLidMapKey(lid);
  if (!key) {
    return null;
  }

  return map[key] ?? null;
}

export async function loadWhatsAppLidMap(
  orgId?: string | null
): Promise<Record<string, string>> {
  const raw = await readTextOrNull(getWhatsAppLidMapPath(orgId));
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const map: Record<string, string> = {};
    for (const [lid, phone] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (typeof phone !== "string") {
        continue;
      }

      const lidKey = whatsAppLidMapKey(lid);
      const phoneJid = toWhatsAppPhoneJid(phone);
      if (lidKey && phoneJid) {
        map[lidKey] = phoneJid;
      }
    }

    return map;
  } catch {
    return {};
  }
}

const whatsAppLidMapLocks = new Map<string, Promise<unknown>>();

export async function rememberWhatsAppLidPhone(
  lid: string,
  phone: string,
  orgId?: string | null
): Promise<string | null> {
  const lidKey = whatsAppLidMapKey(lid);
  const phoneJid = toWhatsAppPhoneJid(phone);
  if (!(lidKey && phoneJid)) {
    return null;
  }

  const lockKey = orgId ?? "";
  const previous = whatsAppLidMapLocks.get(lockKey) ?? Promise.resolve();
  const next = previous.then(async () => {
    const current = await loadWhatsAppLidMap(orgId);
    if (current[lidKey] === phoneJid) {
      return phoneJid;
    }

    current[lidKey] = phoneJid;
    await writePrivateTextFile(
      getWhatsAppLidMapPath(orgId),
      `${JSON.stringify(current, null, 2)}\n`,
      { ensureDir: getWhatsAppConfigDir(orgId) }
    );
    return phoneJid;
  });

  whatsAppLidMapLocks.set(
    lockKey,
    next.then(
      () => undefined,
      () => undefined
    )
  );

  return next;
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

export function normalizeWhatsAppUserJid(jid: string): string {
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

function isWhatsAppOwnerIdentity(
  identity: WhatsAppAuthIdentity,
  config: Pick<WhatsAppConfigFile, "pairedJid" | "pairedLid">
): boolean {
  const jid = identity.jid;

  if (config.pairedJid && isSameWhatsAppUserJid(jid, config.pairedJid)) {
    return true;
  }

  if (config.pairedLid && isSameWhatsAppUserJid(jid, config.pairedLid)) {
    return true;
  }

  return Boolean(
    identity.phoneJid &&
      config.pairedJid &&
      isSameWhatsAppUserJid(identity.phoneJid, config.pairedJid)
  );
}

export function isWhatsAppUserAuthorized(
  jidOrIdentity: string | WhatsAppAuthorizationInput,
  config: Pick<WhatsAppConfigFile, "pairedJid" | "pairedLid"> &
    Partial<
      Pick<
        WhatsAppConfigFile,
        "accessMode" | "allowedNumbers" | "blockedNumbers"
      >
    >
): boolean {
  const identity =
    typeof jidOrIdentity === "string"
      ? resolveWhatsAppAuthIdentity({ jid: jidOrIdentity })
      : resolveWhatsAppAuthIdentity(jidOrIdentity);
  const accessMode = config.accessMode || "pairing";
  const phoneDigits = identity.phoneDigits;

  if (accessMode === "open") {
    return true;
  }

  const isOwner = isWhatsAppOwnerIdentity(identity, config);

  if (accessMode === "allowlist") {
    if (phoneDigits && config.allowedNumbers?.includes(phoneDigits)) {
      return true;
    }

    return isOwner;
  }

  if (accessMode === "denylist") {
    if (phoneDigits && config.blockedNumbers?.includes(phoneDigits)) {
      return false;
    }

    if (isOwner) {
      return true;
    }

    if (!phoneDigits && isWhatsAppLidJid(identity.jid)) {
      return false;
    }

    return true;
  }

  return isOwner;
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
  const pairingAssertion = values.pairing_assertion?.trim() || null;
  const pairingUserId = values.pairing_user_id?.trim() || null;
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
    pairingAssertion,
    pairingCode,
    pairingUserId,
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
    pairingCode:
      (file.accessMode || "pairing") === "pairing" ? file.pairingCode : null,
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
    ...(config.pairingUserId
      ? [`pairing_user_id=${config.pairingUserId}`]
      : []),
    ...(config.pairingAssertion
      ? [`pairing_assertion=${config.pairingAssertion}`]
      : []),
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
  accessMode: ChannelAccessMode
): string | null {
  if (accessMode !== "pairing") {
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
    pairingAssertion: existing?.pairingAssertion ?? null,
    pairingCode: resolvePairingCode(existing, accessMode),
    pairingUserId: existing?.pairingUserId ?? null,
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

  const devicePairingCodePath = join(
    getWhatsAppConfigDir(orgId),
    "worker-pairing-code.txt"
  );
  if (await pathExists(devicePairingCodePath)) {
    await removeFile(devicePairingCodePath);
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
  orgId?: string | null,
  pairingUserId?: string | null,
  pairingAssertion?: string | null
): Promise<WhatsAppSettingsPublic> {
  const existing = await loadWhatsAppConfigFile(orgId);

  if (!existing) {
    throw new Error("Enable WhatsApp before generating a chat access code.");
  }

  if ((existing.accessMode || "pairing") !== "pairing") {
    throw new Error(
      "Chat access codes are only used when access mode is Chat access code."
    );
  }

  const issuer = pairingUserId?.trim() || null;
  if (!issuer) {
    throw new Error(
      "Canonical principal is required to generate a pairing code."
    );
  }

  const next: WhatsAppConfigFile = {
    ...existing,
    pairingAssertion: pairingAssertion?.trim() || null,
    pairingCode: generatePairingCode(),
    pairingUserId: issuer,
  };

  await writeWhatsAppConfigFile(next, orgId);
  return toWhatsAppSettingsPublic(next);
}

const whatsAppPairLocks = new Map<string, Promise<unknown>>();

function runSerializedWhatsAppPair<T>(
  orgId: string | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const key = orgId ?? "";
  const previous = whatsAppPairLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  whatsAppPairLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

export async function verifyAndPairWhatsAppUser(
  pairingCodeInput: string,
  jid: string,
  orgId?: string | null
): Promise<
  | { ok: true; message: string; pairingAssertion: string | null }
  | { ok: false; message: string }
> {
  return runSerializedWhatsAppPair(orgId, async () => {
    const config = await loadWhatsAppConfigFile(orgId);

    if (!config) {
      return {
        message: "WhatsApp is not configured on the server yet.",
        ok: false,
      };
    }

    if (isWhatsAppUserAuthorized(jid, config)) {
      return {
        message: "This chat is already authorized.",
        ok: true,
        pairingAssertion: config.pairingAssertion ?? null,
      };
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
    const sameAsPairedJid = Boolean(
      config.pairedJid && isSameWhatsAppUserJid(jid, config.pairedJid)
    );
    const sameAsPairedLid = Boolean(
      config.pairedLid && isSameWhatsAppUserJid(jid, config.pairedLid)
    );

    const pairingAssertion = config.pairingAssertion ?? null;

    await writeWhatsAppConfigFile(
      {
        ...config,
        pairedJid: isLid ? (sameAsPairedJid ? config.pairedJid : null) : jid,
        pairedLid: isLid ? jid : sameAsPairedLid ? config.pairedLid : null,
        pairingAssertion,
        pairingCode: null,
        phoneNumber: phoneFromJid || config.phoneNumber,
      },
      orgId
    );

    return {
      message: "Chat authorized. Send a message to start chatting with Atlas.",
      ok: true,
      pairingAssertion,
    };
  });
}

export async function clearWhatsAppPairingAssertion(
  orgId?: string | null
): Promise<void> {
  const config = await loadWhatsAppConfigFile(orgId);
  if (!config?.pairingAssertion) {
    return;
  }
  await writeWhatsAppConfigFile(
    {
      ...config,
      pairingAssertion: null,
      pairingUserId: config.pairingCode ? config.pairingUserId : null,
    },
    orgId
  );
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
    pairingCode: config.pairingCode,
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
    pairingAssertion: file?.pairingAssertion ?? null,
    pairingCode:
      (file?.accessMode ?? "pairing") === "pairing"
        ? (file?.pairingCode ?? null)
        : null,
    pairingUserId: file?.pairingUserId ?? null,
    phoneNumber: envPhone || file?.phoneNumber?.trim() || "",
    profileId:
      (allowEnvCredentials
        ? env.ATLAS_WHATSAPP_PROFILE_ID?.trim()
        : undefined) ||
      file?.profileId?.trim() ||
      DEFAULT_WHATSAPP_PROFILE_ID,
  };
}
