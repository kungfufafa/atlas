import { generateSessionTitleFromMessages } from "@atlas/agent";
import {
  type ChatMessage,
  getUserMessageText,
  type ProviderClient,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import type { DatabaseAdapter, StoredProfileRecord } from "@atlas/db";
import { createProviderForInstance } from "../providers/create";
import { resolveProfileProviderSelection } from "./provider-instance-helpers";

export const SESSION_TITLE_FALLBACK = "Untitled";

const TITLE_GENERATION_TIMEOUT_MS = 30_000;
const FALLBACK_MAX_LENGTH = 80;
const WHITESPACE = /\s+/g;
const fallbackSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

interface SessionTitleOptions {
  generationTimeoutMs?: number;
}

type SessionTitleProviderFactory = (
  instance: ProviderInstance,
  model: string,
  userConfig: UserConfig
) => ProviderClient | null;

export class SessionTitleService {
  private readonly inFlight = new Set<string>();
  private readonly generationTimeoutMs: number;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly getUserConfig: (
      orgId: string
    ) => UserConfig | null | Promise<UserConfig | null>,
    private readonly providerFactory: SessionTitleProviderFactory = (
      instance,
      model
    ) => createProviderForInstance(instance, model),
    options: SessionTitleOptions = {}
  ) {
    const timeout = options.generationTimeoutMs ?? TITLE_GENERATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeout) ||
      timeout <= 0 ||
      timeout > 2_147_483_647
    ) {
      throw new RangeError(
        "Session title timeout must be a positive timer-safe integer"
      );
    }
    this.generationTimeoutMs = timeout;
  }

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
      const fallback = firstUserTextFallback(messages);
      let provider: ProviderClient | null = null;
      try {
        provider = this.resolveProviderForProfile(profile, userConfig);
      } catch (error) {
        console.error("Failed to resolve the session title provider:", error);
      }

      let title: string | null = null;
      if (provider) {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort(
            new DOMException("Session title deadline reached", "TimeoutError")
          );
        }, this.generationTimeoutMs);
        try {
          // Await cleanup even after abort: a duplicate job must not outlive this one.
          title = await generateSessionTitleFromMessages(messages, {
            provider,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      }

      await this.commitTitleIfEligible(
        sessionId,
        profile.id,
        profile.orgId,
        title ?? fallback
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

function firstUserTextFallback(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser || firstUser.role !== "user") {
    return SESSION_TITLE_FALLBACK;
  }
  const text = getUserMessageText(firstUser.content)
    .toWellFormed()
    .replace(WHITESPACE, " ")
    .trim();
  if (!text) {
    return SESSION_TITLE_FALLBACK;
  }
  let title = "";
  for (const { segment } of fallbackSegmenter.segment(text)) {
    if (title.length + segment.length > FALLBACK_MAX_LENGTH) {
      return title ? `${title.trimEnd()}…` : SESSION_TITLE_FALLBACK;
    }
    title += segment;
  }
  return title;
}
