import {
  assertCanonicalPrincipal,
  assertExternalPrincipal,
  type CanonicalPrincipal,
  type ChannelType,
  type ExternalPrincipal,
  isChannelGuestUserId,
  isServiceAccountUserId,
  nanoid,
  PrincipalRequiredError,
  resolveCanonicalPrincipal,
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";
import {
  ChannelGuestPrincipalService,
  normalizeExternalActor,
} from "./channel-guest-principal-service";

interface IssuedPairingAssertion {
  channel: ChannelType;
  expiresAt: number;
  orgId: string;
  userId: string;
}

interface ConsumedPairingAssertion extends IssuedPairingAssertion {
  channelUserId: string;
}

const PAIRING_ASSERTION_TTL_MS = 10 * 60 * 1000;

export class IdentityService {
  private readonly channelGuestPrincipalService: ChannelGuestPrincipalService;
  private readonly channelIdentityLocks = new Map<string, Promise<void>>();
  private readonly consumedPairingAssertions = new Map<
    string,
    ConsumedPairingAssertion
  >();
  private readonly pairingAssertions = new Map<
    string,
    IssuedPairingAssertion
  >();

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => number = Date.now,
    channelGuestPrincipalService?: ChannelGuestPrincipalService
  ) {
    this.channelGuestPrincipalService =
      channelGuestPrincipalService ??
      new ChannelGuestPrincipalService(db, { now });
  }

  async issuePairingAssertion(input: {
    channel: ChannelType;
    orgId: string;
    userId: string;
  }): Promise<string> {
    const userId = input.userId.trim();
    const orgId = input.orgId.trim();
    if (isServiceAccountUserId(userId)) {
      throw new PrincipalRequiredError(
        "Cannot issue a pairing assertion for the local-client service account."
      );
    }
    const member = await this.db.getOrgMember(orgId, userId);
    if (!member) {
      throw new PrincipalRequiredError(
        "Mapped user is not a member of the active workspace."
      );
    }
    const now = this.now();
    for (const [id, assertion] of this.consumedPairingAssertions) {
      if (assertion.expiresAt <= now) {
        this.consumedPairingAssertions.delete(id);
      }
    }
    for (const [id, assertion] of this.pairingAssertions) {
      if (
        assertion.expiresAt <= now ||
        (assertion.channel === input.channel &&
          assertion.orgId === orgId &&
          assertion.userId === userId)
      ) {
        this.pairingAssertions.delete(id);
      }
    }
    const id = nanoid();
    this.pairingAssertions.set(id, {
      channel: input.channel,
      expiresAt: now + PAIRING_ASSERTION_TTL_MS,
      orgId,
      userId,
    });
    return id;
  }

  async bindExternalPrincipal(input: {
    actor?: {
      mode:
        | "bearer-session"
        | "browser-session"
        | "local-token"
        | "workspace-worker";
      userId: string;
    };
    channel: ChannelType;
    channelUserId: string;
    expectedUserId?: string;
    orgId: string;
    pairingAssertion?: string;
    userId?: string;
  }): Promise<CanonicalPrincipal> {
    const principal = assertExternalPrincipal({
      channel: input.channel,
      channelUserId: input.channelUserId,
      orgId: input.orgId,
    });

    let userId: string;
    let restoreAssertion: (() => void) | undefined;
    try {
      if (
        input.actor?.mode === "local-token" ||
        input.actor?.mode === "workspace-worker"
      ) {
        const expectedUserId = input.expectedUserId?.trim();
        if (!expectedUserId) {
          throw new PrincipalRequiredError(
            "Worker channel bindings require the expected pairing user."
          );
        }
        const taken = this.takePairingAssertion({
          assertionId: input.pairingAssertion,
          channel: principal.channel,
          channelUserId: principal.channelUserId,
          expectedUserId,
          orgId: principal.orgId,
        });
        userId = taken.userId;
        restoreAssertion = taken.restore;
        if (taken.alreadyConsumed) {
          return this.withChannelIdentityLock(
            `${principal.orgId}:${principal.channel}`,
            async () => {
              const existing = await this.db.getChannelOrgMapping(
                principal.orgId,
                principal.channel,
                principal.channelUserId
              );
              if (existing?.userId !== expectedUserId) {
                throw new PrincipalRequiredError(
                  "Pairing assertion is invalid or already used."
                );
              }
              return this.resolveForUser(principal.orgId, expectedUserId);
            }
          );
        }
      } else if (input.actor) {
        userId = input.actor.userId.trim();
      } else if (input.pairingAssertion?.trim()) {
        const taken = this.takePairingAssertion({
          assertionId: input.pairingAssertion,
          channel: principal.channel,
          channelUserId: principal.channelUserId,
          expectedUserId: input.expectedUserId?.trim(),
          orgId: principal.orgId,
        });
        userId = taken.userId;
        restoreAssertion = taken.restore;
      } else {
        userId = (input.userId ?? "").trim();
      }

      const expectedUserId = input.expectedUserId?.trim();
      if (expectedUserId && expectedUserId !== userId) {
        throw new PrincipalRequiredError(
          "Pairing assertion does not match the expected user."
        );
      }

      if (!userId) {
        throw new PrincipalRequiredError(
          "Canonical principal is required to bind a channel identity."
        );
      }
      if (isServiceAccountUserId(userId)) {
        throw new PrincipalRequiredError(
          "Cannot bind a channel identity to the local-client service account."
        );
      }

      const member = await this.db.getOrgMember(principal.orgId, userId);
      if (!member) {
        throw new PrincipalRequiredError(
          "Mapped user is not a member of the active workspace."
        );
      }

      const user = await this.db.getUserById(userId);
      await this.withChannelIdentityLock(
        `${principal.orgId}:${principal.channel}`,
        () =>
          this.db.upsertChannelOrgMapping({
            channel: principal.channel,
            channelUserId: principal.channelUserId,
            createdAt: new Date().toISOString(),
            orgId: principal.orgId,
            userId,
          })
      );

      return assertCanonicalPrincipal({
        isPlatformAdmin: user?.isPlatformAdmin === true,
        orgId: principal.orgId,
        orgRole: member.role,
        userId,
      });
    } catch (error) {
      restoreAssertion?.();
      throw error;
    }
  }

  private takePairingAssertion(input: {
    assertionId: string | undefined;
    channel: ChannelType;
    channelUserId: string;
    expectedUserId?: string;
    orgId: string;
  }): {
    alreadyConsumed: boolean;
    restore: () => void;
    userId: string;
  } {
    const assertionId = input.assertionId?.trim();
    if (!assertionId) {
      throw new PrincipalRequiredError(
        "Worker channel bindings require a pairing assertion."
      );
    }
    const assertion = this.pairingAssertions.get(assertionId);
    if (!assertion) {
      const consumed = this.consumedPairingAssertions.get(assertionId);
      if (consumed?.expiresAt && consumed.expiresAt <= this.now()) {
        this.consumedPairingAssertions.delete(assertionId);
      } else if (
        consumed &&
        consumed.channel === input.channel &&
        consumed.channelUserId === input.channelUserId &&
        consumed.orgId === input.orgId &&
        consumed.userId === input.expectedUserId
      ) {
        return {
          alreadyConsumed: true,
          restore: () => undefined,
          userId: consumed.userId,
        };
      }
      throw new PrincipalRequiredError(
        "Pairing assertion is invalid or already used."
      );
    }
    if (assertion.expiresAt <= this.now()) {
      this.pairingAssertions.delete(assertionId);
      throw new PrincipalRequiredError("Pairing assertion has expired.");
    }
    if (
      assertion.channel !== input.channel ||
      assertion.orgId !== input.orgId
    ) {
      throw new PrincipalRequiredError(
        "Pairing assertion does not match this channel binding."
      );
    }
    if (input.expectedUserId && assertion.userId !== input.expectedUserId) {
      throw new PrincipalRequiredError(
        "Pairing assertion does not match the expected user."
      );
    }
    this.pairingAssertions.delete(assertionId);
    this.consumedPairingAssertions.set(assertionId, {
      ...assertion,
      channelUserId: input.channelUserId,
    });
    return {
      alreadyConsumed: false,
      restore: () => {
        if (assertion.expiresAt > this.now()) {
          this.consumedPairingAssertions.delete(assertionId);
          this.pairingAssertions.set(assertionId, assertion);
        }
      },
      userId: assertion.userId,
    };
  }

  async resolve(principal: ExternalPrincipal): Promise<CanonicalPrincipal> {
    const external = assertExternalPrincipal(principal);
    const mapping = await this.db.getChannelOrgMapping(
      external.orgId,
      external.channel,
      external.channelUserId
    );
    const member = mapping
      ? await this.db.getOrgMember(external.orgId, mapping.userId)
      : null;
    const user = mapping ? await this.db.getUserById(mapping.userId) : null;

    return resolveCanonicalPrincipal({
      mapping,
      member: member
        ? {
            isPlatformAdmin: user?.isPlatformAdmin === true,
            orgRole: member.role,
          }
        : null,
      principal: external,
    });
  }

  private async resolveTrustedChannelAliases(input: {
    allowGuestProvisioning: boolean;
    channel: "telegram" | "whatsapp" | "discord";
    channelUserAliases: string[];
    channelUserId: string;
    orgId: string;
  }): Promise<CanonicalPrincipal> {
    const normalizedActor = normalizeExternalActor({
      channel: input.channel,
      channelUserAliases: input.channelUserAliases,
      channelUserId: input.channelUserId,
      orgId: input.orgId,
    });
    const primary = assertExternalPrincipal({
      channel: input.channel,
      channelUserId: normalizedActor.primaryChannelUserId,
      orgId: input.orgId,
    });
    const channelUserIds = normalizedActor.channelUserIds;

    const lockKey = `${primary.orgId}:${primary.channel}`;
    return this.withChannelIdentityLock(lockKey, async () => {
      const mappings = await Promise.all(
        channelUserIds.map((channelUserId) =>
          this.db.getChannelOrgMapping(
            primary.orgId,
            primary.channel,
            channelUserId
          )
        )
      );
      const mappedUserIds = new Set(
        mappings
          .filter((mapping) => mapping !== null)
          .map((mapping) => mapping.userId)
      );
      if (mappedUserIds.size === 0) {
        if (input.allowGuestProvisioning) {
          return this.channelGuestPrincipalService.resolveOrProvision({
            channel: input.channel,
            channelUserAliases: channelUserIds.slice(1),
            channelUserId: primary.channelUserId,
            orgId: primary.orgId,
          });
        }
        return this.resolve(primary);
      }
      if (mappedUserIds.size !== 1) {
        throw new PrincipalRequiredError(
          "Trusted channel aliases have conflicting canonical user mappings."
        );
      }

      const userId = [...mappedUserIds][0]!;
      if (input.allowGuestProvisioning && isChannelGuestUserId(userId)) {
        return this.channelGuestPrincipalService.resolveOrProvision({
          channel: input.channel,
          channelUserAliases: channelUserIds.filter(
            (channelUserId) =>
              channelUserId !== normalizedActor.primaryChannelUserId
          ),
          channelUserId: normalizedActor.primaryChannelUserId,
          orgId: primary.orgId,
        });
      }
      const principal = await this.resolveForUser(primary.orgId, userId);
      const createdAt = new Date().toISOString();
      for (const [index, channelUserId] of channelUserIds.entries()) {
        if (mappings[index]) {
          continue;
        }
        await this.db.upsertChannelOrgMapping({
          channel: primary.channel,
          channelUserId,
          createdAt,
          orgId: primary.orgId,
          userId,
        });
      }
      return principal;
    });
  }

  private async withChannelIdentityLock<T>(
    key: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.channelIdentityLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.channelIdentityLocks.set(key, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.channelIdentityLocks.get(key) === queued) {
        this.channelIdentityLocks.delete(key);
      }
    }
  }

  async resolveForChannelSession(input: {
    authUserId: string;
    channel: string;
    channelUserAliases?: string[];
    channelUserId?: string;
    isPlatformAdmin: boolean;
    orgId: string;
    orgRole: CanonicalPrincipal["orgRole"];
  }): Promise<CanonicalPrincipal> {
    if (
      input.channel === "telegram" ||
      input.channel === "whatsapp" ||
      input.channel === "discord"
    ) {
      const channelUserId = input.channelUserId?.trim();
      if (channelUserId) {
        const channelUserAliases = input.channelUserAliases ?? [];
        if (channelUserAliases.length > 0) {
          if (input.channel !== "whatsapp") {
            throw new PrincipalRequiredError(
              "External principal aliases are only supported for WhatsApp."
            );
          }
          if (!isServiceAccountUserId(input.authUserId)) {
            throw new PrincipalRequiredError(
              "Only a trusted channel worker may prove external principal aliases."
            );
          }
          return this.resolveTrustedChannelAliases({
            allowGuestProvisioning: true,
            channel: input.channel,
            channelUserAliases,
            channelUserId,
            orgId: input.orgId,
          });
        }
        if (isServiceAccountUserId(input.authUserId)) {
          return this.resolveTrustedChannelAliases({
            allowGuestProvisioning: true,
            channel: input.channel,
            channelUserAliases: [],
            channelUserId,
            orgId: input.orgId,
          });
        }
        return this.resolve({
          channel: input.channel,
          channelUserId,
          orgId: input.orgId,
        });
      }
      if (input.authUserId && !isServiceAccountUserId(input.authUserId)) {
        return assertCanonicalPrincipal({
          isPlatformAdmin: input.isPlatformAdmin,
          orgId: input.orgId,
          orgRole: input.orgRole,
          userId: input.authUserId,
        });
      }
      throw new PrincipalRequiredError(
        "Channel sessions require an external principal."
      );
    }

    if (isServiceAccountUserId(input.authUserId) && input.channel !== "cli") {
      throw new PrincipalRequiredError(
        "Service-account identity cannot create this session."
      );
    }

    if (input.channel === "cli" && isServiceAccountUserId(input.authUserId)) {
      const members = await this.db.listOrgMembers(input.orgId);
      const admin = members.find((member) => member.role === "admin");
      if (!admin) {
        throw new PrincipalRequiredError(
          "CLI local-client has no workspace admin to act as."
        );
      }
      const user = await this.db.getUserById(admin.userId);
      return assertCanonicalPrincipal({
        isPlatformAdmin: user?.isPlatformAdmin === true,
        orgId: input.orgId,
        orgRole: admin.role,
        userId: admin.userId,
      });
    }

    return assertCanonicalPrincipal({
      isPlatformAdmin: input.isPlatformAdmin,
      orgId: input.orgId,
      orgRole: input.orgRole,
      userId: input.authUserId,
    });
  }

  async resolveForUser(
    orgId: string,
    userId: string
  ): Promise<CanonicalPrincipal> {
    const canonicalUserId = userId.trim();
    const canonicalOrgId = orgId.trim();
    if (!(canonicalUserId && canonicalOrgId)) {
      throw new PrincipalRequiredError("Canonical principal is required.");
    }
    if (isServiceAccountUserId(canonicalUserId)) {
      throw new PrincipalRequiredError(
        "Channel service-account identity cannot act as the canonical principal."
      );
    }

    const member = await this.db.getOrgMember(canonicalOrgId, canonicalUserId);
    if (!member) {
      throw new PrincipalRequiredError(
        "Mapped user is not a member of the active workspace."
      );
    }

    const user = await this.db.getUserById(canonicalUserId);
    return assertCanonicalPrincipal({
      isPlatformAdmin: user?.isPlatformAdmin === true,
      orgId: canonicalOrgId,
      orgRole: member.role,
      userId: canonicalUserId,
    });
  }
}
