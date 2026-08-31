import { createHash } from "node:crypto";
import {
  assertCanonicalPrincipal,
  assertExternalPrincipal,
  type CanonicalPrincipal,
  CHANNEL_GUEST_USER_ID_PREFIX,
  type ChannelType,
  isDiscordSnowflake,
  isDiscordUserAuthorized,
  isTelegramUserAuthorized,
  isWhatsAppLidJid,
  isWhatsAppUserAuthorized,
  loadDiscordConfigFile,
  loadTelegramConfigFile,
  loadWhatsAppConfigFile,
  normalizeWhatsAppUserJid,
  PrincipalRequiredError,
  toWhatsAppPhoneJid,
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";

export const DEFAULT_CHANNEL_GUEST_MAPPING_CAP = 10_000;
export const DEFAULT_CHANNEL_GUEST_PROVISION_RATE = 60;
export const DEFAULT_CHANNEL_GUEST_RATE_WINDOW_MS = 60_000;

const CHANNEL_GUEST_PASSWORD_HASH = "!atlas-channel-guest-no-login!";
const EXTERNAL_CHANNELS = new Set<ChannelType>([
  "telegram",
  "whatsapp",
  "discord",
]);
const WHATSAPP_PHONE_JID_PATTERN = /^\d+@s\.whatsapp\.net$/;
const WHATSAPP_LID_JID_PATTERN = /^\d+@lid$/;

type ExternalChannel = "telegram" | "whatsapp" | "discord";

export interface NormalizedExternalActor {
  channelUserIds: string[];
  primaryChannelUserId: string;
  stableActorId: string;
}

interface ProvisionRateWindow {
  count: number;
  startedAt: number;
}

export interface ChannelGuestPrincipalInput {
  channel: ExternalChannel;
  channelUserAliases?: string[];
  channelUserId: string;
  orgId: string;
}

export interface ChannelGuestPrincipalServiceOptions {
  authorize?: (input: ChannelGuestPrincipalInput) => Promise<boolean> | boolean;
  mappingCap?: number;
  now?: () => number;
  provisionRate?: number;
  rateWindowMs?: number;
}

/**
 * Creates a least-privilege Atlas principal for an authorized external actor.
 * Callers still need to serialize this with explicit pairing/rebinding when
 * both operations can target the same workspace channel.
 */
export class ChannelGuestPrincipalService {
  private readonly authorize: (
    input: ChannelGuestPrincipalInput
  ) => Promise<boolean>;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly mappingCap: number;
  private readonly now: () => number;
  private readonly provisionRate: number;
  private readonly rateWindowMs: number;
  private readonly rateWindows = new Map<string, ProvisionRateWindow>();

  constructor(
    private readonly db: DatabaseAdapter,
    options: ChannelGuestPrincipalServiceOptions = {}
  ) {
    this.authorize = async (input) =>
      (options.authorize ?? authorizeExternalActorFromWorkspaceConfig)(input);
    this.mappingCap = requirePositiveInteger(
      options.mappingCap ?? DEFAULT_CHANNEL_GUEST_MAPPING_CAP,
      "Channel guest mapping cap"
    );
    this.now = options.now ?? Date.now;
    this.provisionRate = requirePositiveInteger(
      options.provisionRate ?? DEFAULT_CHANNEL_GUEST_PROVISION_RATE,
      "Channel guest provision rate"
    );
    this.rateWindowMs = requirePositiveInteger(
      options.rateWindowMs ?? DEFAULT_CHANNEL_GUEST_RATE_WINDOW_MS,
      "Channel guest rate window"
    );
  }

  async resolveOrProvision(
    input: ChannelGuestPrincipalInput
  ): Promise<CanonicalPrincipal> {
    const normalizedInput = normalizeExternalActor(input);
    const orgId = input.orgId.trim();
    const lockKey = `${orgId}:${input.channel}`;

    return this.withLock(lockKey, async () => {
      const authorized = await this.authorize({
        channel: input.channel,
        channelUserAliases: normalizedInput.channelUserIds.filter(
          (channelUserId) =>
            channelUserId !== normalizedInput.primaryChannelUserId
        ),
        channelUserId: normalizedInput.primaryChannelUserId,
        orgId,
      });
      if (!authorized) {
        throw new PrincipalRequiredError(
          "External channel sender is not authorized by the workspace channel policy."
        );
      }

      const existing = await this.resolveExistingMappings({
        channel: input.channel,
        channelUserIds: normalizedInput.channelUserIds,
        orgId,
      });
      if (existing) {
        return existing;
      }

      const allMappings = (
        await this.db.listChannelOrgMappingsForOrg(orgId)
      ).filter((mapping) => mapping.channel === input.channel);
      if (
        allMappings.length + normalizedInput.channelUserIds.length >
        this.mappingCap
      ) {
        throw new PrincipalRequiredError(
          "External channel guest mapping limit reached for this workspace."
        );
      }
      this.consumeProvisionRate(lockKey);

      const guest = buildGuestRecord({
        channel: input.channel,
        now: new Date(this.now()).toISOString(),
        orgId,
        stableActorId: normalizedInput.stableActorId,
      });
      const existingUser = await this.db.getUserById(guest.userId);
      if (existingUser) {
        if (
          existingUser.email !== guest.email ||
          existingUser.isPlatformAdmin === true
        ) {
          throw new PrincipalRequiredError(
            "External channel guest identity conflicts with an existing user."
          );
        }
      } else {
        await this.db.createUser({
          createdAt: guest.now,
          email: guest.email,
          id: guest.userId,
          isPlatformAdmin: false,
          name: guest.name,
          passwordHash: CHANNEL_GUEST_PASSWORD_HASH,
          updatedAt: guest.now,
        });
      }

      await this.db.upsertOrgMember({
        createdAt: guest.now,
        orgId,
        role: "member",
        userId: guest.userId,
      });
      for (const channelUserId of normalizedInput.channelUserIds) {
        const current = await this.db.getChannelOrgMapping(
          orgId,
          input.channel,
          channelUserId
        );
        if (current) {
          if (current.userId !== guest.userId) {
            return this.resolveMappedUser(orgId, current.userId);
          }
          continue;
        }
        await this.db.upsertChannelOrgMapping({
          channel: input.channel,
          channelUserId,
          createdAt: guest.now,
          orgId,
          userId: guest.userId,
        });
      }

      return assertCanonicalPrincipal({
        isPlatformAdmin: false,
        orgId,
        orgRole: "member",
        userId: guest.userId,
      });
    });
  }

  private consumeProvisionRate(key: string): void {
    const now = this.now();
    const previous = this.rateWindows.get(key);
    if (!previous || now - previous.startedAt >= this.rateWindowMs) {
      this.rateWindows.set(key, { count: 1, startedAt: now });
      return;
    }
    if (previous.count >= this.provisionRate) {
      throw new PrincipalRequiredError(
        "External channel guest provisioning is temporarily rate limited."
      );
    }
    previous.count += 1;
  }

  private async resolveExistingMappings(input: {
    channel: ExternalChannel;
    channelUserIds: string[];
    orgId: string;
  }): Promise<CanonicalPrincipal | null> {
    const mappings = await Promise.all(
      input.channelUserIds.map((channelUserId) =>
        this.db.getChannelOrgMapping(input.orgId, input.channel, channelUserId)
      )
    );
    const mappedUserIds = new Set(
      mappings
        .filter((mapping) => mapping !== null)
        .map((mapping) => mapping.userId)
    );
    if (mappedUserIds.size === 0) {
      return null;
    }
    if (mappedUserIds.size !== 1) {
      throw new PrincipalRequiredError(
        "Trusted channel aliases have conflicting canonical user mappings."
      );
    }

    const userId = [...mappedUserIds][0]!;
    const principal = await this.resolveMappedUser(input.orgId, userId);
    const createdAt = new Date(this.now()).toISOString();
    for (const [index, channelUserId] of input.channelUserIds.entries()) {
      if (mappings[index]) {
        continue;
      }
      await this.db.upsertChannelOrgMapping({
        channel: input.channel,
        channelUserId,
        createdAt,
        orgId: input.orgId,
        userId,
      });
    }
    return principal;
  }

  private async resolveMappedUser(
    orgId: string,
    userId: string
  ): Promise<CanonicalPrincipal> {
    const member = await this.db.getOrgMember(orgId, userId);
    if (!member) {
      throw new PrincipalRequiredError(
        "Mapped user is not a member of the active workspace."
      );
    }
    const user = await this.db.getUserById(userId);
    return assertCanonicalPrincipal({
      isPlatformAdmin: user?.isPlatformAdmin === true,
      orgId,
      orgRole: member.role,
      userId,
    });
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === queued) {
        this.locks.delete(key);
      }
    }
  }
}

async function authorizeExternalActorFromWorkspaceConfig(
  input: ChannelGuestPrincipalInput
): Promise<boolean> {
  if (input.channel === "telegram") {
    const telegramId = Number(input.channelUserId);
    if (
      !(
        /^\d+$/.test(input.channelUserId) && Number.isSafeInteger(telegramId)
      ) ||
      telegramId <= 0
    ) {
      return false;
    }
    const config = await loadTelegramConfigFile(input.orgId);
    return config ? isTelegramUserAuthorized(telegramId, config) : false;
  }

  if (input.channel === "discord") {
    if (!isDiscordSnowflake(input.channelUserId)) {
      return false;
    }
    const config = await loadDiscordConfigFile(input.orgId);
    return config
      ? isDiscordUserAuthorized(input.channelUserId, config)
      : false;
  }

  const actor = normalizeWhatsAppActor(input);
  const config = await loadWhatsAppConfigFile(input.orgId);
  return config
    ? isWhatsAppUserAuthorized(
        {
          jid: actor.primaryChannelUserId,
          mappedPhoneJid: actor.phoneJid,
        },
        config
      )
    : false;
}

export function normalizeExternalActor(
  input: ChannelGuestPrincipalInput
): NormalizedExternalActor {
  if (!EXTERNAL_CHANNELS.has(input.channel)) {
    throw new PrincipalRequiredError("Unsupported external channel.");
  }
  const primary = assertExternalPrincipal({
    channel: input.channel,
    channelUserId: input.channelUserId,
    orgId: input.orgId,
  });
  if (input.channel === "whatsapp") {
    return normalizeWhatsAppActor({
      ...input,
      channelUserId: primary.channelUserId,
      orgId: primary.orgId,
    });
  }
  if (input.channelUserAliases?.length) {
    throw new PrincipalRequiredError(
      "External principal aliases are only supported for WhatsApp."
    );
  }
  return {
    channelUserIds: [primary.channelUserId],
    primaryChannelUserId: primary.channelUserId,
    stableActorId: primary.channelUserId,
  };
}

function normalizeWhatsAppActor(
  input: ChannelGuestPrincipalInput
): NormalizedExternalActor & { phoneJid: string | null } {
  const rawIds = [input.channelUserId, ...(input.channelUserAliases ?? [])];
  if (rawIds.length > 9) {
    throw new PrincipalRequiredError(
      "Too many trusted channel identity aliases."
    );
  }
  const channelUserIds: string[] = [];
  const seen = new Set<string>();
  const phoneJids = new Set<string>();

  for (const rawId of rawIds) {
    const normalized = normalizeWhatsAppUserJid(rawId.trim());
    const isLid = isWhatsAppLidJid(normalized);
    const phoneJid = toWhatsAppPhoneJid(normalized);
    const validLid = isLid && WHATSAPP_LID_JID_PATTERN.test(normalized);
    const validPhone =
      phoneJid !== null && WHATSAPP_PHONE_JID_PATTERN.test(normalized);
    if (!(validLid || validPhone)) {
      throw new PrincipalRequiredError(
        "Invalid trusted WhatsApp channel identity."
      );
    }
    if (phoneJid) {
      phoneJids.add(phoneJid);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      channelUserIds.push(normalized);
    }
  }
  if (phoneJids.size > 1) {
    throw new PrincipalRequiredError(
      "Trusted WhatsApp aliases contain conflicting phone identities."
    );
  }
  const primaryChannelUserId = normalizeWhatsAppUserJid(
    input.channelUserId.trim()
  );
  const phoneJid = [...phoneJids][0] ?? null;
  return {
    channelUserIds,
    phoneJid,
    primaryChannelUserId,
    stableActorId: phoneJid ?? primaryChannelUserId,
  };
}

function buildGuestRecord(input: {
  channel: ExternalChannel;
  now: string;
  orgId: string;
  stableActorId: string;
}): {
  email: string;
  name: string;
  now: string;
  userId: string;
} {
  const digest = createHash("sha256")
    .update(`${input.orgId}\0${input.channel}\0${input.stableActorId}`)
    .digest("hex");
  const label = `${input.channel[0]!.toUpperCase()}${input.channel.slice(1)}`;
  const actorSuffix = input.stableActorId.replace(/\D/g, "").slice(-6);
  return {
    email: `${digest}@channel-guest.atlas.invalid`,
    name: `${label} ${actorSuffix || digest.slice(0, 6)}`,
    now: input.now,
    userId: `${CHANNEL_GUEST_USER_ID_PREFIX}${digest}`,
  };
}

function requirePositiveInteger(value: number, label: string): number {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
  return value;
}
