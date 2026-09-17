import type { AutomationDefinition, ToolDefinition } from "@atlas/core";
import {
  type AgentChatSession,
  type AgentChatSessionOptions,
  type AgentDependencies,
  type AgentRequest,
  createAgentChatSession,
} from "./chat";
import { enforceChatCapabilityPolicy } from "./chat-capability-provider";
import { parseAutomationResponse } from "./parse";
import {
  buildAutomationSystemPrompt,
  buildAutomationUserPrompt,
} from "./prompt";

export { enforceChatCapabilityPolicy } from "./chat-capability-provider";

export interface AgentHarness {
  createAutomationFromPrompt(
    request: AgentRequest,
    options?: { tools?: ToolDefinition[] }
  ): Promise<AutomationDefinition>;
  createChatSession(options?: AgentChatSessionOptions): AgentChatSession;
}

export function createAgentHarness(
  dependencies: AgentDependencies = {}
): AgentHarness {
  const guardedDependencies: AgentDependencies = {
    ...dependencies,
    ...(dependencies.provider && dependencies.chatCapabilityPolicy
      ? {
          provider: enforceChatCapabilityPolicy(
            dependencies.provider,
            dependencies.chatCapabilityPolicy
          ),
        }
      : {}),
  };
  const defaultTools = guardedDependencies.tools ?? [];
  const harness: AgentHarness = {
    async createAutomationFromPrompt(request, options) {
      const tools = options?.tools ?? defaultTools;

      if (!guardedDependencies.provider) {
        throw new Error("Provider is not configured.");
      }

      const result = await guardedDependencies.provider.generateText({
        format: "json",
        prompt: buildAutomationUserPrompt(request.prompt, request.channel),
        system: buildAutomationSystemPrompt(tools),
      });

      return parseAutomationResponse(result.content, {
        prompt: request.prompt,
        tools,
      });
    },
    createChatSession(options) {
      return createAgentChatSession(guardedDependencies, harness, options);
    },
  };

  return harness;
}

export type {
  AgentChatSession,
  AgentChatSessionOptions,
  AgentDependencies,
  AgentRequest,
  ChatCapabilityErrorCode,
  ChatCapabilityPolicy,
  ChatCapabilityPolicyEntry,
  ResolvePromptContextInput,
  ToolLoopStopReason,
} from "./chat";
export { ChatCapabilityError } from "./chat";
export type { CompactionConfig } from "./history-compaction";
export { usableContextTokens } from "./history-compaction";
export {
  buildLearnPrompt,
  expandLearnInLastUserMessage,
  expandLearnUserContent,
  expandLearnUserMessage,
  tryParseLearnCommand,
} from "./learn-prompt";
export type { MergeOrgMemoryWithApprovedBulletOptions } from "./org-memory-merge";
export {
  mergeOrgMemoryWithApprovedBullet,
  mergeOrgMemoryWithApprovedBulletFallback,
} from "./org-memory-merge";
export {
  buildSessionTitlePrompt,
  generateSessionTitleFromMessages,
  normalizeSessionTitle,
} from "./session-title";
export type { SkillCuratorDocumentInput } from "./skill-curator-consolidation";
export {
  buildSkillCuratorConsolidationPrompt,
  generateSkillCuratorConsolidationMarkdown,
} from "./skill-curator-consolidation";
export type {
  SkillLearningApplyResult,
  SkillLearningSessionOptions,
  SkillLearningStore,
  SkillLearningTurnResult,
} from "./skill-learning-loop";
export {
  composeSkillLearningPromptContext,
  distillFallbackSkill,
  runSkillLearningTurn,
} from "./skill-learning-loop";
export type {
  SkillCatalogEntry,
  SkillPostTurnReviewOutcome,
} from "./skill-post-turn-review";
export {
  buildSkillPostTurnReviewPrompt,
  generateSkillPostTurnReview,
  parseSkillPostTurnReviewResponse,
} from "./skill-post-turn-review";
export type { DraftTaskPromptInput } from "./task-prompt";
export { draftTaskPromptFromFields } from "./task-prompt";
export type {
  ToolExecutionLifecycle,
  ToolInvocationLifecycle,
} from "./tool-execution-lifecycle";
export { canRunToolCallsInParallel, executeToolCall } from "./tool-loop";
export {
  buildSuggestParamsUserPrompt,
  parseSuggestedParams,
  suggestToolParamsFromPrompt,
} from "./tool-playground-params";
