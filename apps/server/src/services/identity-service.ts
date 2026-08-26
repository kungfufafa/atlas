import {
  assertCanonicalPrincipal,
  assertExternalPrincipal,
  type CanonicalPrincipal,
  type ChannelType,
  type ExternalPrincipal,
  isServiceAccountUserId,
  nanoid,
  PrincipalRequiredError,
  resolveCanonicalPrincipal,
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";

interface IssuedPairingAssertion {
  channel: ChannelType;
  orgId: string;
  userId: string;
}

export class IdentityService {
  private readonly pairingAssertions = new Map<
    string,
    IssuedPairingAssertion
  >();

  constructor(private readonly db: DatabaseAdapter) {}

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
    for (const [id, assertion] of this.pairingAssertions) {
      if (
        assertion.channel === input.channel &&
        assertion.orgId === orgId &&
        assertion.userId === userId
      ) {
        this.pairingAssertions.delete(id);
      }
    }
    const id = nanoid();
    this.pairingAssertions.set(id, {
      channel: input.channel,
      orgId,
      userId,
    });
    return id;
  }

  async bindExternalPrincipal(input: {
    actor?: {
      mode: "browser-session" | "local-token";
      userId: string;
    };
    channel: ChannelType;
    channelUserId: string;
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
      if (input.actor?.mode === "local-token") {
        const taken = this.takePairingAssertion({
          assertionId: input.pairingAssertion,
          channel: principal.channel,
          orgId: principal.orgId,
        });
        userId = taken.userId;
        restoreAssertion = taken.restore;
      } else if (input.actor) {
        userId = input.actor.userId.trim();
      } else if (input.pairingAssertion?.trim()) {
        const taken = this.takePairingAssertion({
          assertionId: input.pairingAssertion,
          channel: principal.channel,
          orgId: principal.orgId,
        });
        userId = taken.userId;
        restoreAssertion = taken.restore;
      } else {
        userId = (input.userId ?? "").trim();
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
      await this.db.upsertChannelOrgMapping({
        channel: principal.channel,
        channelUserId: principal.channelUserId,
        createdAt: new Date().toISOString(),
        orgId: principal.orgId,
        userId,
      });

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
    orgId: string;
  }): { restore: () => void; userId: string } {
    const assertionId = input.assertionId?.trim();
    if (!assertionId) {
      throw new PrincipalRequiredError(
        "Worker channel bindings require a pairing assertion."
      );
    }
    const assertion = this.pairingAssertions.get(assertionId);
    if (!assertion) {
      throw new PrincipalRequiredError(
        "Pairing assertion is invalid or already used."
      );
    }
    if (
      assertion.channel !== input.channel ||
      assertion.orgId !== input.orgId
    ) {
      throw new PrincipalRequiredError(
        "Pairing assertion does not match this channel binding."
      );
    }
    this.pairingAssertions.delete(assertionId);
    return {
      restore: () => {
        this.pairingAssertions.set(assertionId, assertion);
      },
      userId: assertion.userId,
    };
  }

  async resolve(principal: ExternalPrincipal): Promise<CanonicalPrincipal> {
    const external = assertExternalPrincipal(principal);
    const mapping = await this.db.getChannelOrgMapping(
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

  async resolveForChannelSession(input: {
    authUserId: string;
    channel: string;
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
        try {
          return await this.resolve({
            channel: input.channel,
            channelUserId,
            orgId: input.orgId,
          });
        } catch (error) {
          if (
            error instanceof PrincipalRequiredError &&
            isServiceAccountUserId(input.authUserId)
          ) {
            return await this.bindAuthorizedWorkerPrincipal({
              channel: input.channel,
              channelUserId,
              orgId: input.orgId,
            });
          }
          throw error;
        }
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

  private async bindAuthorizedWorkerPrincipal(input: {
    channel: ChannelType;
    channelUserId: string;
    orgId: string;
  }): Promise<CanonicalPrincipal> {
    const members = await this.db.listOrgMembers(input.orgId);
    const admin = members.find(
      (member) =>
        member.role === "admin" && !isServiceAccountUserId(member.userId)
    );
    if (!admin) {
      throw new PrincipalRequiredError(
        "Mapped user is not a member of the active workspace."
      );
    }

    return this.bindExternalPrincipal({
      channel: input.channel,
      channelUserId: input.channelUserId,
      orgId: input.orgId,
      userId: admin.userId,
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
