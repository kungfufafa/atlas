import { generateSessionTitleFromMessages } from "@atlas/agent";
import type {
  ChatMessage,
  ProviderClient,
  ProviderInstance,
  UserConfig,
} from "@atlas/core";
import type { DatabaseAdapter, StoredProfileRecord } from "@atlas/db";
import { createProviderForInstance } from "../providers/create";
import { resolveProfileProviderSelection } from "./provider-instance-helpers";

export const SESSION_TITLE_FALLBACK = "Untitled";

type SessionTitleProviderFactory = (
  instance: ProviderInstance,
  model: string,
  userConfig: UserConfig
) => ProviderClient | null;

export class SessionTitleService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly getUserConfig: (
      orgId: string
    ) => UserConfig | null | Promise<UserConfig | null>,
    private readonly providerFactory: SessionTitleProviderFactory = (
      instance,
      model
    ) => createProviderForInstance(instance, model)
  ) {}

  scheduleSessionTitleGeneration(sessionId: string): void {
    void this.generateSessionTitle(sessionId).catch((error) => {
      console.error(
        `Failed to generate session title for ${sessionId}:`,
        error
      );
    });
  }

  async generateSessionTitle(sessionId: string): Promise<void> {
    if (this.inFlight.has(sessionId)) {
      return;
    }

    this.inFlight.add(sessionId);

    try {
      const session = await this.db.getSession(sessionId);

      if (!session || session.title !== null) {
        return;
      }

      const profile = await this.db.getProfile(session.profileId);

      if (!(session.orgId && profile?.orgId === session.orgId)) {
        return;
      }

      const organization = await this.db.getOrganizationById(profile.orgId);

      if (!organization || organization.archivedAt) {
        return;
      }

      const storedMessages = await this.db.listMessagesForSession(sessionId);
      const messages = storedMessages.map(
        (record) => record.payload as ChatMessage
      );

      if (!hasCompletedFirstTurn(messages)) {
        return;
      }

      const userConfig = await this.getUserConfig(profile.orgId);
      if (
        !(await this.isEligibleContext(sessionId, profile.id, profile.orgId))
      ) {
        return;
      }
      const provider = this.resolveProviderForProfile(profile, userConfig);

      if (!provider) {
        await this.commitTitleIfEligible(
          sessionId,
          profile.id,
          profile.orgId,
          SESSION_TITLE_FALLBACK
        );
        return;
      }

      const title = await generateSessionTitleFromMessages(messages, {
        provider,
      });

      await this.commitTitleIfEligible(
        sessionId,
        profile.id,
        profile.orgId,
        title ?? SESSION_TITLE_FALLBACK
      );
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async commitTitleIfEligible(
    sessionId: string,
    profileId: string,
    orgId: string,
    title: string
  ): Promise<void> {
    if (!(await this.isEligibleContext(sessionId, profileId, orgId))) {
      return;
    }

    await this.db.updateSessionTitle(sessionId, title);
  }

  private async isEligibleContext(
    sessionId: string,
    profileId: string,
    orgId: string
  ): Promise<boolean> {
    const [session, profile, organization] = await Promise.all([
      this.db.getSession(sessionId),
      this.db.getProfile(profileId),
      this.db.getOrganizationById(orgId),
    ]);

    return Boolean(
      session &&
        session.title === null &&
        session.profileId === profileId &&
        session.orgId === orgId &&
        profile?.orgId === orgId &&
        organization &&
        !organization.archivedAt
    );
  }

  private resolveProviderForProfile(
    profile: StoredProfileRecord,
    userConfig: UserConfig | null
  ) {
    if (!userConfig) {
      return null;
    }

    const selection = resolveProfileProviderSelection({
      defaultProviderId: userConfig.defaultProviderId,
      profileModel: profile.model,
      providers: userConfig.providers,
    });

    if (!selection) {
      return null;
    }

    return this.providerFactory(
      selection.instance,
      selection.model,
      userConfig
    );
  }
}

function hasCompletedFirstTurn(messages: readonly ChatMessage[]): boolean {
  const hasUser = messages.some((message) => message.role === "user");
  const hasAssistant = messages.some(
    (message) =>
      message.role === "assistant" && message.content.trim().length > 0
  );

  return hasUser && hasAssistant;
}
