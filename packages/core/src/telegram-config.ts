import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ChannelAccessMode } from "./contract";
import { parseIni, readTextOrNull, writePrivateTextFile } from "./fs";
import { getWorkspaceChannelDir } from "./workspace-channel-paths";

export const DEFAULT_TELEGRAM_PROFILE_ID = "default";

export interface TelegramConfigFile {
  accessMode: ChannelAccessMode;
  allowedUserIds: number[];
  blockedUserIds: number[];
  botToken: string;
  /** Single-use server assertion consumed when binding the channel identity. */
  handshakeAssertion?: string | null;
  handshakeCode: string | null;
  /** Atlas user who generated the active handshake; used to bind ExternalPrincipal. */
  handshakeUserId: string | null;
  pairedUserIds: number[];
  profileId: string;
}

export interface TelegramSettingsPublic {
  accessMode: ChannelAccessMode;
  allowedUserIds: number[];
  blockedUserIds: number[];
  botTokenMasked: string | null;
  configured: boolean;
  handshakeCode: string | null;
  pairedUserIds: number[];
  profileId: string;
}

export interface UpdateTelegramSettingsInput {
  accessMode?: ChannelAccessMode;
  allowedUserIds?: string;
  blockedUserIds?: string;
  botToken?: string;
  profileId?: string;
}

export function getTelegramConfigDir(orgId?: string | null): string {
  return orgId === undefined
    ? getWorkspaceChannelDir("telegram")
    : getWorkspaceChannelDir("telegram", orgId);
}

export function getTelegramConfigPath(orgId?: string | null): string {
  return join(getTelegramConfigDir(orgId), "config.ini");
}

export function maskBotToken(token: string): string | null {
  const trimmed = token.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= 8) {
    return "••••••••";
  }

  return `${"•".repeat(Math.min(trimmed.length - 4, 12))}${trimmed.slice(-4)}`;
}

export function generateHandshakeCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

export function normalizeHandshakeInput(input: string): string {
  return input.trim().replace(/\s+/g, "").toUpperCase();
}

export function parseAllowedUserIds(raw: string): number[] {
  const ids = new Set<number>();

  for (const part of raw.split(",")) {
    const trimmed = part.trim();

    if (!trimmed) {
      continue;
    }

    const id = Number(trimmed);

    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid Telegram user ID: ${trimmed}`);
    }

    ids.add(id);
  }

  return [...ids];
}

export function isTelegramUserAuthorized(
  userId: number,
  config: Pick<
    TelegramConfigFile,
    "accessMode" | "pairedUserIds" | "allowedUserIds" | "blockedUserIds"
  >
): boolean {
  const accessMode = config.accessMode || "pairing";

  if (accessMode === "open") {
    return true;
  }

  if (accessMode === "allowlist") {
    return (
      (config.allowedUserIds?.includes(userId) ?? false) ||
      (config.pairedUserIds?.includes(userId) ?? false)
    );
  }

  if (accessMode === "denylist") {
    if (config.blockedUserIds?.includes(userId)) {
      return false;
    }
    return true;
  }

  // "pairing" mode
  return (
    (config.pairedUserIds?.includes(userId) ?? false) ||
    (config.allowedUserIds?.includes(userId) ?? false)
  );
}

export async function loadTelegramConfigFile(
  orgId?: string | null
): Promise<TelegramConfigFile | null> {
  const raw = await readTextOrNull(getTelegramConfigPath(orgId));

  if (raw === null) {
    return null;
  }

  const values = parseIni(raw);
  const botToken = values.bot_token?.trim() ?? "";
  const profileId = values.profile_id?.trim() || DEFAULT_TELEGRAM_PROFILE_ID;
  const handshakeCode = values.handshake_code?.trim() || null;
  const handshakeAssertion = values.handshake_assertion?.trim() || null;
  const handshakeUserId = values.handshake_user_id?.trim() || null;
  const pairedRaw = values.paired_user_ids?.trim() ?? "";
  const allowlistRaw = values.allowed_user_ids?.trim() ?? "";
  const denylistRaw = values.blocked_user_ids?.trim() ?? "";

  const accessModeRaw = values.access_mode?.trim()?.toLowerCase();
  const accessMode: ChannelAccessMode =
    accessModeRaw === "open" ||
    accessModeRaw === "allowlist" ||
    accessModeRaw === "denylist"
      ? accessModeRaw
      : "pairing";

  if (!botToken) {
    return null;
  }

  return {
    accessMode,
    allowedUserIds: allowlistRaw ? parseAllowedUserIds(allowlistRaw) : [],
    blockedUserIds: denylistRaw ? parseAllowedUserIds(denylistRaw) : [],
    botToken,
    handshakeAssertion,
    handshakeCode,
    handshakeUserId,
    pairedUserIds: pairedRaw ? parseAllowedUserIds(pairedRaw) : [],
    profileId,
  };
}

export function toTelegramSettingsPublic(
  file: TelegramConfigFile | null
): TelegramSettingsPublic {
  if (!file) {
    return {
      accessMode: "pairing",
      allowedUserIds: [],
      blockedUserIds: [],
      botTokenMasked: null,
      configured: false,
      handshakeCode: null,
      pairedUserIds: [],
      profileId: DEFAULT_TELEGRAM_PROFILE_ID,
    };
  }

  return {
    accessMode: file.accessMode || "pairing",
    allowedUserIds: file.allowedUserIds || [],
    blockedUserIds: file.blockedUserIds || [],
    botTokenMasked: maskBotToken(file.botToken),
    configured: Boolean(file.botToken.trim()),
    handshakeCode: file.handshakeCode,
    pairedUserIds: file.pairedUserIds || [],
    profileId: file.profileId,
  };
}

export async function loadTelegramSettingsPublic(
  orgId?: string | null
): Promise<TelegramSettingsPublic> {
  return toTelegramSettingsPublic(await loadTelegramConfigFile(orgId));
}

async function writeTelegramConfigFile(
  config: TelegramConfigFile,
  orgId?: string | null
): Promise<void> {
  const lines = [
    "# Atlas Telegram bridge",
    `bot_token=${config.botToken}`,
    `profile_id=${config.profileId}`,
    `access_mode=${config.accessMode}`,
    ...(config.handshakeCode ? [`handshake_code=${config.handshakeCode}`] : []),
    ...(config.handshakeUserId
      ? [`handshake_user_id=${config.handshakeUserId}`]
      : []),
    ...(config.handshakeAssertion
      ? [`handshake_assertion=${config.handshakeAssertion}`]
      : []),
    ...(config.pairedUserIds.length > 0
      ? [`paired_user_ids=${config.pairedUserIds.join(",")}`]
      : []),
    ...(config.allowedUserIds.length > 0
      ? [`allowed_user_ids=${config.allowedUserIds.join(",")}`]
      : []),
    ...(config.blockedUserIds.length > 0
      ? [`blocked_user_ids=${config.blockedUserIds.join(",")}`]
      : []),
    "",
  ];

  await writePrivateTextFile(getTelegramConfigPath(orgId), lines.join("\n"), {
    ensureDir: getTelegramConfigDir(orgId),
  });
}

function resolveTelegramBotToken(
  input: UpdateTelegramSettingsInput,
  existing: TelegramConfigFile | null
): string {
  return input.botToken === undefined
    ? (existing?.botToken ?? "")
    : input.botToken.trim();
}

function resolveTelegramProfileId(
  input: UpdateTelegramSettingsInput,
  existing: TelegramConfigFile | null
): string {
  return (
    input.profileId?.trim() ||
    existing?.profileId ||
    DEFAULT_TELEGRAM_PROFILE_ID
  );
}

function resolveAllowedUserIdsInput(
  input: UpdateTelegramSettingsInput,
  existing: TelegramConfigFile | null
): number[] {
  const raw =
    input.allowedUserIds === undefined
      ? (existing?.allowedUserIds.join(",") ?? "")
      : input.allowedUserIds.trim();

  return raw ? parseAllowedUserIds(raw) : [];
}

function resolveBlockedUserIdsInput(
  input: UpdateTelegramSettingsInput,
  existing: TelegramConfigFile | null
): number[] {
  const raw =
    input.blockedUserIds === undefined
      ? (existing?.blockedUserIds?.join(",") ?? "")
      : input.blockedUserIds.trim();

  return raw ? parseAllowedUserIds(raw) : [];
}

function resolveHandshakeCode(
  existing: TelegramConfigFile | null,
  allowedUserIds: number[]
): string | null {
  const pairedUserIds = existing?.pairedUserIds ?? [];
  const handshakeCode = existing?.handshakeCode ?? null;

  if (pairedUserIds.length > 0 || allowedUserIds.length > 0 || handshakeCode) {
    return handshakeCode;
  }

  return generateHandshakeCode();
}

function buildSavedTelegramConfig(
  input: UpdateTelegramSettingsInput,
  existing: TelegramConfigFile | null
): TelegramConfigFile {
  const botToken = resolveTelegramBotToken(input, existing);

  if (!botToken) {
    throw new Error("Bot token is required.");
  }

  const allowedUserIds = resolveAllowedUserIdsInput(input, existing);
  const blockedUserIds = resolveBlockedUserIdsInput(input, existing);
  const accessMode = input.accessMode ?? existing?.accessMode ?? "pairing";

  return {
    accessMode,
    allowedUserIds,
    blockedUserIds,
    botToken,
    handshakeAssertion: existing?.handshakeAssertion ?? null,
    handshakeCode: resolveHandshakeCode(existing, allowedUserIds),
    handshakeUserId: existing?.handshakeUserId ?? null,
    pairedUserIds: existing?.pairedUserIds ?? [],
    profileId: resolveTelegramProfileId(input, existing),
  };
}

export async function saveTelegramConfig(
  input: UpdateTelegramSettingsInput,
  orgId?: string | null
): Promise<TelegramSettingsPublic> {
  const existing = await loadTelegramConfigFile(orgId);
  const next = buildSavedTelegramConfig(input, existing);
  await writeTelegramConfigFile(next, orgId);
  return toTelegramSettingsPublic(next);
}

export async function regenerateTelegramHandshake(
  orgId?: string | null,
  handshakeUserId?: string | null,
  pairingAssertion?: string | null
): Promise<TelegramSettingsPublic> {
  const existing = await loadTelegramConfigFile(orgId);

  if (!existing?.botToken.trim()) {
    throw new Error("Save a bot token before generating a pairing code.");
  }

  const issuer = handshakeUserId?.trim() || null;
  if (!issuer) {
    throw new Error(
      "Canonical principal is required to generate a pairing code."
    );
  }

  const next: TelegramConfigFile = {
    ...existing,
    handshakeAssertion: pairingAssertion?.trim() || null,
    handshakeCode: generateHandshakeCode(),
    handshakeUserId: issuer,
  };

  await writeTelegramConfigFile(next, orgId);
  return toTelegramSettingsPublic(next);
}

const telegramPairLocks = new Map<string, Promise<unknown>>();

function runSerializedTelegramPair<T>(
  orgId: string | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const key = orgId ?? "";
  const previous = telegramPairLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  telegramPairLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

export async function verifyAndPairTelegramUser(
  handshakeInput: string,
  userId: number,
  orgId?: string | null
): Promise<
  | {
      ok: true;
      message: string;
      handshakeUserId: string | null;
      pairingAssertion: string | null;
    }
  | { ok: false; message: string }
> {
  return runSerializedTelegramPair(orgId, async () => {
    const config = await loadTelegramConfigFile(orgId);

    if (!config) {
      return {
        message: "Telegram is not configured on the server yet.",
        ok: false,
      };
    }

    if (isTelegramUserAuthorized(userId, config)) {
      return {
        handshakeUserId: config.handshakeUserId,
        message: "This chat is already linked.",
        ok: true,
        pairingAssertion: config.handshakeAssertion ?? null,
      };
    }

    const expected = config.handshakeCode;

    if (!expected) {
      return {
        message:
          "No pairing code is active. Open Atlas Integrations → Telegram and generate a new code.",
        ok: false,
      };
    }

    if (
      normalizeHandshakeInput(handshakeInput) !==
      normalizeHandshakeInput(expected)
    ) {
      return {
        message:
          "Invalid pairing code. Copy it from Integrations → Telegram and try again.",
        ok: false,
      };
    }

    const pairedUserIds = [...new Set([...config.pairedUserIds, userId])];
    const handshakeUserId = config.handshakeUserId;
    const pairingAssertion = config.handshakeAssertion ?? null;

    await writeTelegramConfigFile(
      {
        ...config,
        handshakeAssertion: pairingAssertion,
        handshakeCode: null,
        handshakeUserId,
        pairedUserIds,
      },
      orgId
    );

    return {
      handshakeUserId,
      message: "Linked successfully. You can chat with Atlas now.",
      ok: true,
      pairingAssertion,
    };
  });
}

export async function clearTelegramPairingAssertion(
  orgId?: string | null
): Promise<void> {
  const config = await loadTelegramConfigFile(orgId);
  if (!config?.handshakeAssertion) {
    return;
  }
  await writeTelegramConfigFile(
    {
      ...config,
      handshakeAssertion: null,
      handshakeUserId: config.handshakeCode ? config.handshakeUserId : null,
    },
    orgId
  );
}

export function resolveTelegramConfigFromSources(options: {
  allowEnvCredentials?: boolean;
  env?: Record<string, string | undefined>;
  file?: TelegramConfigFile | null;
}): TelegramConfigFile | null {
  const env = options.env ?? process.env;
  const file = options.file ?? null;
  const allowEnvCredentials = options.allowEnvCredentials !== false;
  const botToken =
    (allowEnvCredentials ? env.TELEGRAM_BOT_TOKEN?.trim() : "") ||
    file?.botToken?.trim() ||
    "";

  if (!botToken) {
    return null;
  }

  const envAllowlist = allowEnvCredentials
    ? env.TELEGRAM_ALLOWED_USER_IDS?.trim()
    : undefined;
  const envDenylist = allowEnvCredentials
    ? env.TELEGRAM_BLOCKED_USER_IDS?.trim()
    : undefined;

  return {
    accessMode: file?.accessMode ?? "pairing",
    allowedUserIds: envAllowlist
      ? parseAllowedUserIds(envAllowlist)
      : (file?.allowedUserIds ?? []),
    blockedUserIds: envDenylist
      ? parseAllowedUserIds(envDenylist)
      : (file?.blockedUserIds ?? []),
    botToken,
    handshakeAssertion: file?.handshakeAssertion ?? null,
    handshakeCode: file?.handshakeCode ?? null,
    handshakeUserId: file?.handshakeUserId ?? null,
    pairedUserIds: file?.pairedUserIds ?? [],
    profileId:
      (allowEnvCredentials
        ? env.ATLAS_TELEGRAM_PROFILE_ID?.trim()
        : undefined) ||
      file?.profileId?.trim() ||
      DEFAULT_TELEGRAM_PROFILE_ID,
  };
}
