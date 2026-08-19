import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ChannelAccessMode } from "./contract";
import { parseIni, readTextOrNull, writePrivateTextFile } from "./fs";
import { getWorkspaceChannelDir } from "./workspace-channel-paths";

export const DEFAULT_DISCORD_PROFILE_ID = "default";

export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export function isDiscordSnowflake(value: string): boolean {
  return SNOWFLAKE_PATTERN.test(value);
}

export interface DiscordConfigFile {
  accessMode: ChannelAccessMode;
  allowedUserIds: string[];
  blockedUserIds: string[];
  botToken: string;
  handshakeCode: string | null;
  pairedUserIds: string[];
  profileId: string;
}

export interface DiscordSettingsPublic {
  accessMode: ChannelAccessMode;
  allowedUserIds: string[];
  blockedUserIds: string[];
  botTokenMasked: string | null;
  configured: boolean;
  handshakeCode: string | null;
  inviteUrl: string | null;
  pairedUserIds: string[];
  profileId: string;
}

export interface UpdateDiscordSettingsInput {
  accessMode?: ChannelAccessMode;
  allowedUserIds?: string;
  blockedUserIds?: string;
  botToken?: string;
  profileId?: string;
}

export function getDiscordConfigDir(orgId?: string | null): string {
  return orgId === undefined
    ? getWorkspaceChannelDir("discord")
    : getWorkspaceChannelDir("discord", orgId);
}

export function getDiscordConfigPath(orgId?: string | null): string {
  return join(getDiscordConfigDir(orgId), "config.ini");
}

const DISCORD_INVITE_PERMISSIONS = 101_376; // 68608 | 32768 (Attach Files)
const DISCORD_INVITE_SCOPES = "bot applications.commands";

const discordApplicationIdCache = new Map<string, string>();

export function buildDiscordInviteUrl(applicationId: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    permissions: String(DISCORD_INVITE_PERMISSIONS),
    scope: DISCORD_INVITE_SCOPES,
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function clearDiscordApplicationIdCache(botToken: string): void {
  discordApplicationIdCache.delete(botToken.trim());
}

export async function resolveDiscordApplicationId(
  botToken: string
): Promise<string | null> {
  const token = botToken.trim();

  if (!token) {
    return null;
  }

  const cached = discordApplicationIdCache.get(token);

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(
      `${DISCORD_API_BASE_URL}/oauth2/applications/@me`,
      {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { id?: string };
    const applicationId = payload.id?.trim();

    if (!(applicationId && SNOWFLAKE_PATTERN.test(applicationId))) {
      return null;
    }

    discordApplicationIdCache.set(token, applicationId);
    return applicationId;
  } catch {
    return null;
  }
}

async function withDiscordInviteUrl(
  settings: DiscordSettingsPublic,
  botToken: string | null
): Promise<DiscordSettingsPublic> {
  if (!(settings.configured && botToken?.trim())) {
    return settings;
  }

  const applicationId = await resolveDiscordApplicationId(botToken);

  return {
    ...settings,
    inviteUrl: applicationId ? buildDiscordInviteUrl(applicationId) : null,
  };
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

export function parseAllowedUserIds(raw: string): string[] {
  const ids = new Set<string>();

  for (const part of raw.split(",")) {
    const trimmed = part.trim();

    if (!trimmed) {
      continue;
    }

    if (!SNOWFLAKE_PATTERN.test(trimmed)) {
      throw new Error(`Invalid Discord user ID: ${trimmed}`);
    }

    ids.add(trimmed);
  }

  return [...ids];
}

export function isDiscordUserAuthorized(
  userId: string,
  config: Pick<
    DiscordConfigFile,
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

async function loadDiscordConfigFile(
  orgId?: string | null
): Promise<DiscordConfigFile | null> {
  const raw = await readTextOrNull(getDiscordConfigPath(orgId));

  if (raw === null) {
    return null;
  }

  const values = parseIni(raw);
  const botToken = values.bot_token?.trim() ?? "";
  const profileId = values.profile_id?.trim() || DEFAULT_DISCORD_PROFILE_ID;
  const handshakeCode = values.handshake_code?.trim() || null;
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
    handshakeCode,
    pairedUserIds: pairedRaw ? parseAllowedUserIds(pairedRaw) : [],
    profileId,
  };
}

export { loadDiscordConfigFile };

export function toDiscordSettingsPublic(
  file: DiscordConfigFile | null
): DiscordSettingsPublic {
  if (!file) {
    return {
      accessMode: "pairing",
      allowedUserIds: [],
      blockedUserIds: [],
      botTokenMasked: null,
      configured: false,
      handshakeCode: null,
      inviteUrl: null,
      pairedUserIds: [],
      profileId: DEFAULT_DISCORD_PROFILE_ID,
    };
  }

  return {
    accessMode: file.accessMode || "pairing",
    allowedUserIds: file.allowedUserIds || [],
    blockedUserIds: file.blockedUserIds || [],
    botTokenMasked: maskBotToken(file.botToken),
    configured: Boolean(file.botToken.trim()),
    handshakeCode: file.handshakeCode,
    inviteUrl: null,
    pairedUserIds: file.pairedUserIds || [],
    profileId: file.profileId,
  };
}

export async function loadDiscordSettingsPublic(
  orgId?: string | null
): Promise<DiscordSettingsPublic> {
  const file = await loadDiscordConfigFile(orgId);
  const base = toDiscordSettingsPublic(file);
  return withDiscordInviteUrl(base, file?.botToken ?? null);
}

async function writeDiscordConfigFile(
  config: DiscordConfigFile,
  orgId?: string | null
): Promise<void> {
  const lines = [
    "# Atlas Discord bridge",
    `bot_token=${config.botToken}`,
    `profile_id=${config.profileId}`,
    `access_mode=${config.accessMode}`,
    ...(config.handshakeCode ? [`handshake_code=${config.handshakeCode}`] : []),
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

  await writePrivateTextFile(getDiscordConfigPath(orgId), lines.join("\n"), {
    ensureDir: getDiscordConfigDir(orgId),
  });
}

function resolveDiscordBotToken(
  input: UpdateDiscordSettingsInput,
  existing: DiscordConfigFile | null
): string {
  return input.botToken === undefined
    ? (existing?.botToken ?? "")
    : input.botToken.trim();
}

function resolveDiscordProfileId(
  input: UpdateDiscordSettingsInput,
  existing: DiscordConfigFile | null
): string {
  return (
    input.profileId?.trim() || existing?.profileId || DEFAULT_DISCORD_PROFILE_ID
  );
}

function resolveAllowedUserIdsInput(
  input: UpdateDiscordSettingsInput,
  existing: DiscordConfigFile | null
): string[] {
  const raw =
    input.allowedUserIds === undefined
      ? (existing?.allowedUserIds.join(",") ?? "")
      : input.allowedUserIds.trim();

  return raw ? parseAllowedUserIds(raw) : [];
}

function resolveBlockedUserIdsInput(
  input: UpdateDiscordSettingsInput,
  existing: DiscordConfigFile | null
): string[] {
  const raw =
    input.blockedUserIds === undefined
      ? (existing?.blockedUserIds?.join(",") ?? "")
      : input.blockedUserIds.trim();

  return raw ? parseAllowedUserIds(raw) : [];
}

function resolveHandshakeCode(
  existing: DiscordConfigFile | null,
  allowedUserIds: string[]
): string | null {
  const pairedUserIds = existing?.pairedUserIds ?? [];
  const handshakeCode = existing?.handshakeCode ?? null;

  if (pairedUserIds.length > 0 || allowedUserIds.length > 0 || handshakeCode) {
    return handshakeCode;
  }

  return generateHandshakeCode();
}

function buildSavedDiscordConfig(
  input: UpdateDiscordSettingsInput,
  existing: DiscordConfigFile | null
): DiscordConfigFile {
  const botToken = resolveDiscordBotToken(input, existing);

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
    handshakeCode: resolveHandshakeCode(existing, allowedUserIds),
    pairedUserIds: existing?.pairedUserIds ?? [],
    profileId: resolveDiscordProfileId(input, existing),
  };
}

export async function addDiscordAllowedUserId(
  userId: string,
  orgId?: string | null
): Promise<
  | { ok: true; alreadyAllowed: boolean; userId: string }
  | { ok: false; message: string }
> {
  const trimmed = userId.trim();
  if (!SNOWFLAKE_PATTERN.test(trimmed)) {
    return { message: "Invalid Discord user ID.", ok: false };
  }

  const existing = await loadDiscordConfigFile(orgId);

  if (!existing) {
    return {
      message: "Discord is not configured on the server yet.",
      ok: false,
    };
  }

  if (existing.allowedUserIds.includes(trimmed)) {
    return { alreadyAllowed: true, ok: true, userId: trimmed };
  }

  const next: DiscordConfigFile = {
    ...existing,
    allowedUserIds: [...existing.allowedUserIds, trimmed],
  };

  await writeDiscordConfigFile(next, orgId);
  return { alreadyAllowed: false, ok: true, userId: trimmed };
}

export async function saveDiscordConfig(
  input: UpdateDiscordSettingsInput,
  orgId?: string | null
): Promise<DiscordSettingsPublic> {
  const existing = await loadDiscordConfigFile(orgId);
  const next = buildSavedDiscordConfig(input, existing);
  clearDiscordApplicationIdCache(next.botToken);
  await writeDiscordConfigFile(next, orgId);
  const base = toDiscordSettingsPublic(next);
  return withDiscordInviteUrl(base, next.botToken);
}

export async function regenerateDiscordHandshake(
  orgId?: string | null
): Promise<DiscordSettingsPublic> {
  const existing = await loadDiscordConfigFile(orgId);

  if (!existing?.botToken.trim()) {
    throw new Error("Save a bot token before generating a pairing code.");
  }

  const next: DiscordConfigFile = {
    ...existing,
    handshakeCode: generateHandshakeCode(),
  };

  await writeDiscordConfigFile(next, orgId);
  const base = toDiscordSettingsPublic(next);
  return withDiscordInviteUrl(base, next.botToken);
}

export async function verifyAndPairDiscordUser(
  handshakeInput: string,
  userId: string,
  orgId?: string | null
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const config = await loadDiscordConfigFile(orgId);

  if (!config) {
    return {
      message: "Discord is not configured on the server yet.",
      ok: false,
    };
  }

  if (isDiscordUserAuthorized(userId, config)) {
    return { message: "This chat is already linked.", ok: true };
  }

  const expected = config.handshakeCode;

  if (!expected) {
    return {
      message:
        "No pairing code is active. Open Atlas Integrations → Discord and generate a new code.",
      ok: false,
    };
  }

  if (
    normalizeHandshakeInput(handshakeInput) !==
    normalizeHandshakeInput(expected)
  ) {
    return {
      message:
        "Invalid pairing code. Copy it from Integrations → Discord and try again.",
      ok: false,
    };
  }

  const pairedUserIds = [...new Set([...config.pairedUserIds, userId])];

  await writeDiscordConfigFile(
    {
      ...config,
      handshakeCode: null,
      pairedUserIds,
    },
    orgId
  );

  return {
    message: "Linked successfully. You can chat with Atlas now.",
    ok: true,
  };
}

export function resolveDiscordConfigFromSources(options: {
  allowEnvCredentials?: boolean;
  env?: Record<string, string | undefined>;
  file?: DiscordConfigFile | null;
}): DiscordConfigFile | null {
  const env = options.env ?? process.env;
  const file = options.file ?? null;
  const allowEnvCredentials = options.allowEnvCredentials !== false;
  const botToken =
    (allowEnvCredentials ? env.DISCORD_BOT_TOKEN?.trim() : "") ||
    file?.botToken?.trim() ||
    "";

  if (!botToken) {
    return null;
  }

  const envAllowlist = allowEnvCredentials
    ? env.DISCORD_ALLOWED_USER_IDS?.trim()
    : undefined;
  const envDenylist = allowEnvCredentials
    ? env.DISCORD_BLOCKED_USER_IDS?.trim()
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
    handshakeCode: file?.handshakeCode ?? null,
    pairedUserIds: file?.pairedUserIds ?? [],
    profileId:
      (allowEnvCredentials
        ? env.ATLAS_DISCORD_PROFILE_ID?.trim()
        : undefined) ||
      file?.profileId?.trim() ||
      DEFAULT_DISCORD_PROFILE_ID,
  };
}
