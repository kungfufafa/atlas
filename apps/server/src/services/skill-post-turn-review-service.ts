import {
  generateSkillPostTurnReview,
  type SkillPostTurnReviewOutcome,
} from "@atlas/agent";
import {
  type ChatMessage,
  extractLatestTurnMessages,
  type ProviderClient,
  type ProviderInstance,
  resolveSkillPostTurnReviewEnabled,
  type UserConfig,
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";
import { createProviderForInstance } from "../providers/create";
import { resolveProfileProviderSelection } from "./provider-instance-helpers";

const MIN_TOOL_CALLS_FOR_COMPLEX_TURN = 5;
const MANAGE_SKILLS_NAME = "manage-skills";
const SKILL_MANAGE_TOOL_NAME = "skill_manage";

export type PostTurnReviewSkipReason =
  | "in_flight"
  | "session_missing"
  | "profile_missing"
  | "org_missing"
  | "org_archived"
  | "org_mismatch"
  | "channel_not_interactive"
  | "flag_disabled"
  | "manage_skills_unassigned"
  | "turn_not_complex"
  | "skill_manage_already_used"
  | "noop";

export interface PostTurnReviewEligibility {
  eligible: boolean;
  hasToolError: boolean;
  reason?: PostTurnReviewSkipReason;
  toolCallCount: number;
  usedSkillManage: boolean;
}

export interface PostTurnReviewRunnerContext {
  messages: ChatMessage[];
  orgId: string;
  profileId: string;
  sessionId: string;
  turnMessages: ChatMessage[];
  userId: string | null;
}

export type PostTurnReviewRunner = (
  context: PostTurnReviewRunnerContext
) => Promise<SkillPostTurnReviewOutcome | void>;

export type PostTurnReviewPersistence = () => Promise<void>;

export type PostTurnReviewPersistencePlanner = (
  context: PostTurnReviewRunnerContext,
  outcome: Exclude<SkillPostTurnReviewOutcome, { action: "noop" }>
) => Promise<PostTurnReviewPersistence | void>;

type PostTurnReviewProviderFactory = (
  instance: ProviderInstance,
  model: string,
  userConfig: UserConfig
) => ProviderClient | null;

export function countToolCallsInTurn(turnMessages: ChatMessage[]): number {
  let count = 0;
  for (const message of turnMessages) {
    if (message.role === "assistant" && message.toolCalls) {
      count += message.toolCalls.length;
    }
  }
  return count;
}

export function turnHasToolError(turnMessages: ChatMessage[]): boolean {
  for (const message of turnMessages) {
    if (message.role !== "tool") {
      continue;
    }
    try {
      const parsed = JSON.parse(message.content) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        (parsed as { error: unknown }).error != null
      ) {
        return true;
      }
    } catch {
      // non-JSON tool content is not treated as an error signal
    }
  }
  return false;
}

export function turnUsedSkillManage(turnMessages: ChatMessage[]): boolean {
  for (const message of turnMessages) {
    if (
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.some((call) => call.name === SKILL_MANAGE_TOOL_NAME)
    ) {
      return true;
    }
    if (message.role === "tool" && message.name === SKILL_MANAGE_TOOL_NAME) {
      return true;
    }
  }
  return false;
}

export function evaluatePostTurnReviewTurnEligibility(
  turnMessages: ChatMessage[]
): PostTurnReviewEligibility {
  const toolCallCount = countToolCallsInTurn(turnMessages);
  const hasToolError = turnHasToolError(turnMessages);
  const usedSkillManage = turnUsedSkillManage(turnMessages);

  if (usedSkillManage) {
    return {
      eligible: false,
      hasToolError,
      reason: "skill_manage_already_used",
      toolCallCount,
      usedSkillManage,
    };
  }

  const complex =
    toolCallCount >= MIN_TOOL_CALLS_FOR_COMPLEX_TURN || hasToolError;
  if (!complex) {
    return {
      eligible: false,
      hasToolError,
      reason: "turn_not_complex",
      toolCallCount,
      usedSkillManage,
    };
  }

  return {
    eligible: true,
    hasToolError,
    toolCallCount,
    usedSkillManage,
  };
}

export class SkillPostTurnReviewService {
  private readonly inFlight = new Set<string>();
  private persistencePlanner: PostTurnReviewPersistencePlanner | null = null;
  private runner: PostTurnReviewRunner;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly getUserConfig: (
      orgId: string
    ) => UserConfig | null | Promise<UserConfig | null>,
    runner?: PostTurnReviewRunner,
    private readonly providerFactory: PostTurnReviewProviderFactory = (
      instance,
      model
    ) => createProviderForInstance(instance, model)
  ) {
    this.runner = runner ?? ((context) => this.reviewTurnWithLlm(context));
  }

  /** Test/injection hook for the outcome-generation phase. */
  setRunner(runner: PostTurnReviewRunner): void {
    this.runner = runner;
  }

  setPersistencePlanner(planner: PostTurnReviewPersistencePlanner): void {
    this.persistencePlanner = planner;
  }

  schedulePostTurnSkillReview(sessionId: string): void {
    void this.runPostTurnSkillReview(sessionId).catch((error) => {
      console.error(`Failed post-turn skill review for ${sessionId}:`, error);
    });
  }

  async reviewTurnWithLlm(
    context: PostTurnReviewRunnerContext
  ): Promise<SkillPostTurnReviewOutcome> {
    const organization = await this.db.getOrganizationById(context.orgId);
    const profile = await this.db.getProfile(context.profileId);
    if (
      !organization ||
      organization.archivedAt ||
      profile?.orgId !== context.orgId
    ) {
      return { action: "noop", reason: "organization_inactive" };
    }

    const provider = await this.resolveProviderForProfile(context.profileId);
    if (!provider) {
      return { action: "noop", reason: "provider_unavailable" };
    }

    const assigned = await this.db.listSkillsForProfile(context.profileId);
    const catalog = assigned.map((skill) => ({
      description: skill.description,
      name: skill.name,
    }));

    return generateSkillPostTurnReview({
      catalog,
      provider,
      turnMessages: context.turnMessages,
    });
  }

  async runPostTurnSkillReview(
    sessionId: string
  ): Promise<PostTurnReviewSkipReason | "ran"> {
    if (this.inFlight.has(sessionId)) {
      return "in_flight";
    }

    this.inFlight.add(sessionId);

    try {
      const session = await this.db.getSession(sessionId);
      if (!session) {
        return "session_missing";
      }

      const channel = session.channel;
      const interactiveChannels = new Set([
        "web",
        "cli",
        "discord",
        "telegram",
        "whatsapp",
      ]);
      if (!interactiveChannels.has(channel)) {
        return "channel_not_interactive";
      }

      const profile = await this.db.getProfile(session.profileId);
      if (!profile?.orgId) {
        return "profile_missing";
      }

      if (session.orgId !== profile.orgId) {
        return "org_mismatch";
      }

      const org = await this.db.getOrganizationById(profile.orgId);
      if (!org) {
        return "org_missing";
      }
      if (org.archivedAt) {
        return "org_archived";
      }

      const enabled = resolveSkillPostTurnReviewEnabled({
        orgSkillsPostTurnReview: org.skillsPostTurnReview ?? false,
        profileSkillsPostTurnReview: profile.skillsPostTurnReview ?? null,
      });
      if (!enabled) {
        return "flag_disabled";
      }

      const assignedSkills = await this.db.listSkillsForProfile(profile.id);
      if (!assignedSkills.some((skill) => skill.name === MANAGE_SKILLS_NAME)) {
        return "manage_skills_unassigned";
      }

      const storedMessages = await this.db.listMessagesForSession(sessionId);
      const messages = storedMessages.map(
        (record) => record.payload as ChatMessage
      );
      const turnMessages = extractLatestTurnMessages(messages);
      const eligibility = evaluatePostTurnReviewTurnEligibility(turnMessages);
      if (!eligibility.eligible) {
        return eligibility.reason ?? "turn_not_complex";
      }

      const context: PostTurnReviewRunnerContext = {
        messages,
        orgId: profile.orgId,
        profileId: profile.id,
        sessionId,
        turnMessages,
        userId: session.userId ?? null,
      };
      const beforeRunnerReason = await this.recheckActiveContext(context);
      if (beforeRunnerReason) {
        return beforeRunnerReason;
      }

      const outcome = await this.runner(context);
      if (!outcome || outcome.action === "noop" || !this.persistencePlanner) {
        return "ran";
      }

      const afterRunnerReason = await this.recheckActiveContext(context);
      if (afterRunnerReason) {
        return afterRunnerReason;
      }

      const persist = await this.persistencePlanner(context, outcome);
      if (!persist) {
        return "ran";
      }

      const beforePersistenceReason = await this.recheckActiveContext(context);
      if (beforePersistenceReason) {
        return beforePersistenceReason;
      }

      await persist();

      return "ran";
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  async resolveProviderForProfile(profileId: string) {
    const profile = await this.db.getProfile(profileId);
    if (!profile?.orgId) {
      return null;
    }

    const userConfig = await this.getUserConfig(profile.orgId);
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

  private async recheckActiveContext(
    context: PostTurnReviewRunnerContext
  ): Promise<PostTurnReviewSkipReason | null> {
    const [session, profile, organization] = await Promise.all([
      this.db.getSession(context.sessionId),
      this.db.getProfile(context.profileId),
      this.db.getOrganizationById(context.orgId),
    ]);

    if (!session) {
      return "session_missing";
    }
    if (!profile?.orgId) {
      return "profile_missing";
    }
    if (
      session.profileId !== context.profileId ||
      session.orgId !== context.orgId ||
      profile.orgId !== context.orgId
    ) {
      return "org_mismatch";
    }
    if (!organization) {
      return "org_missing";
    }
    if (organization.archivedAt) {
      return "org_archived";
    }
    return null;
  }
}
