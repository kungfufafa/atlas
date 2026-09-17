import {
  type AgentChannel,
  buildLearnedSkillMarkdown,
  type ChatMessage,
  collectSkillLearningSignals,
  composeMatchedSkillsPrompt,
  composeSkillsCatalog,
  consolidateSkillLearningOutcome,
  type DiscoveredSkill,
  discoveredSkillFromMarkdown,
  extractExplicitSkillName,
  getUserMessageText,
  type LearnedSkillApplyAction,
  matchSkillsForMessage,
  type ProviderClient,
  SKILL_QUERY_STOP_WORDS,
  type SkillLearningSignal,
  type SkillLearningStopReason,
  type SkillRanker,
  skillLearningAllowedOnChannel,
  skillLearningIsEligible,
  slugifyLearnedSkillName,
} from "@atlas/core";
import {
  generateSkillPostTurnReview,
  type SkillCatalogEntry,
  type SkillPostTurnReviewOutcome,
} from "./skill-post-turn-review";

export interface SkillLearningApplyResult {
  action: "create" | "edit" | "noop" | "patch" | "staged";
  name?: string;
  reason?: string;
  staged?: boolean;
}

export interface SkillLearningStore {
  apply(
    outcome: Exclude<LearnedSkillApplyAction, { action: "noop" }>,
    context?: { writeApprovalRequired?: boolean }
  ): Promise<SkillLearningApplyResult> | SkillLearningApplyResult;
  listCatalog():
    | readonly SkillCatalogEntry[]
    | Promise<readonly SkillCatalogEntry[]>;
  listDiscovered():
    | readonly DiscoveredSkill[]
    | Promise<readonly DiscoveredSkill[]>;
  ranker?: SkillRanker;
}

export interface SkillLearningSessionOptions {
  enabled: boolean;
  /** Default true. AgentService sets false because it already injects matched skills. */
  injectMatchedSkills?: boolean;
  store: SkillLearningStore;
  writeApprovalRequired?: boolean;
}

export interface SkillLearningTurnResult {
  applied?: SkillLearningApplyResult;
  outcome: SkillPostTurnReviewOutcome | LearnedSkillApplyAction;
  signals: SkillLearningSignal[];
  skipped?: "channel" | "disabled" | "ineligible" | "noop";
}

export async function composeSkillLearningPromptContext(input: {
  ranker?: SkillRanker;
  store: SkillLearningStore;
  userMessage?: string;
}): Promise<string> {
  const discovered = [...(await Promise.resolve(input.store.listDiscovered()))];
  const parts: string[] = [];
  const catalog = composeSkillsCatalog(discovered);
  if (catalog.trim()) {
    parts.push(catalog.trim());
  }
  const userMessage = input.userMessage?.trim() ?? "";
  if (userMessage && discovered.length > 0) {
    const matched = matchSkillsForMessage(discovered, userMessage, {
      ranker: input.ranker ?? input.store.ranker,
    });
    const matchedPrompt = composeMatchedSkillsPrompt(matched, {
      explicitInvocation: extractExplicitSkillName(userMessage) !== null,
    });
    if (matchedPrompt.trim()) {
      parts.push(matchedPrompt.trim());
    }
  }
  return parts.join("\n\n");
}

export function distillFallbackSkill(input: {
  assignedToolNames: readonly string[];
  catalog: readonly SkillCatalogEntry[];
  signals: readonly SkillLearningSignal[];
  turnMessages: ChatMessage[];
}): LearnedSkillApplyAction {
  const userMessage = latestUserMessage(input.turnMessages);
  const unknownTools = input.signals
    .filter(
      (signal) =>
        signal.kind === "unknown_tool" ||
        signal.kind === "requested_unassigned_tool"
    )
    .map((signal) => signal.toolName);
  const stop = input.signals.find((signal) => signal.kind === "tool_loop_stop");
  const taught = input.signals.some(
    (signal) => signal.kind === "taught_procedure"
  );

  if (unknownTools.length > 0) {
    const primary = unknownTools[0] ?? "missing-tool";
    const name = slugifyLearnedSkillName(`recover-${primary}`);
    const assigned =
      input.assignedToolNames.length > 0
        ? input.assignedToolNames.join(", ")
        : "(none)";
    const readableUnknown = primary.replaceAll("_", " ").replaceAll("-", " ");
    const body = [
      `# Unknown tool: ${primary}`,
      "",
      `Never call \`${primary}\`${
        unknownTools.length > 1
          ? ` or ${unknownTools
              .slice(1)
              .map((toolName) => `\`${toolName}\``)
              .join(", ")}`
          : ""
      }. ${primary} is not assigned.`,
      "",
      `Assigned tools: ${assigned}.`,
      "",
      "When the user asks for this workflow again:",
      "1. Use only assigned tools.",
      "2. If a ticket id is present, call lookup_ticket with that id.",
      "3. Call write_note to record the result. Prefer a title that names the workflow (for example clearance-stamp) and include the live ticket summary in the body.",
      "4. Copy any exact tokens or note titles from the original request into that note.",
      "",
      `Original request: ${userMessage || "(none)"}`,
    ].join("\n");
    return consolidateSkillLearningOutcome(
      {
        action: "create",
        content: buildLearnedSkillMarkdown({
          body,
          description: `Recover when the user asks to ${readableUnknown} or a similar unassigned tool.`,
          name,
        }),
        name,
      },
      input.catalog
    );
  }

  if (taught || stop) {
    const name = slugifyLearnedSkillName(
      taught ? skillNameFromUserMessage(userMessage) : `recover-${stop?.reason}`
    );
    const steps = taught
      ? userMessage
      : `The previous turn stopped (${stop?.reason}). Do not repeat identical failing tool calls. Continue with assigned tools only: ${input.assignedToolNames.join(", ")}.`;
    return consolidateSkillLearningOutcome(
      {
        action: "create",
        content: buildLearnedSkillMarkdown({
          body: steps,
          description: taught
            ? descriptionFromUserMessage(userMessage)
            : `Recover from a ${stop?.reason} tool-loop stop.`,
          name,
        }),
        name,
      },
      input.catalog
    );
  }

  return { action: "noop", reason: "no_fallback" };
}

export async function runSkillLearningTurn(input: {
  assignedToolNames: readonly string[];
  channel?: AgentChannel;
  enabled: boolean;
  provider?: ProviderClient | null;
  stopReason?: SkillLearningStopReason | null;
  store: SkillLearningStore;
  turnMessages: ChatMessage[];
  writeApprovalRequired?: boolean;
}): Promise<SkillLearningTurnResult> {
  if (!input.enabled) {
    return {
      outcome: { action: "noop", reason: "disabled" },
      signals: [],
      skipped: "disabled",
    };
  }
  if (!skillLearningAllowedOnChannel(input.channel)) {
    return {
      outcome: { action: "noop", reason: "channel" },
      signals: [],
      skipped: "channel",
    };
  }

  const signals = collectSkillLearningSignals({
    assignedToolNames: input.assignedToolNames,
    stopReason: input.stopReason,
    turnMessages: input.turnMessages,
  });
  if (!skillLearningIsEligible(signals)) {
    return {
      outcome: { action: "noop", reason: "ineligible" },
      signals,
      skipped: "ineligible",
    };
  }

  const catalog = [...(await Promise.resolve(input.store.listCatalog()))];
  let outcome: SkillPostTurnReviewOutcome | LearnedSkillApplyAction = {
    action: "noop",
    reason: "provider_unavailable",
  };

  if (input.provider) {
    outcome = await generateSkillPostTurnReview({
      assignedToolNames: input.assignedToolNames,
      catalog,
      provider: input.provider,
      signals,
      turnMessages: input.turnMessages,
    });
  }

  if (outcome.action === "noop") {
    outcome = distillFallbackSkill({
      assignedToolNames: input.assignedToolNames,
      catalog,
      signals,
      turnMessages: input.turnMessages,
    });
  } else if (outcome.action === "create") {
    outcome = consolidateSkillLearningOutcome(
      {
        action: "create",
        content: ensureBodyOnMatch(outcome.content),
        name: outcome.name,
      },
      catalog
    );
  }

  if (outcome.action === "noop") {
    return { outcome, signals, skipped: "noop" };
  }

  const applied = await Promise.resolve(
    input.store.apply(outcome, {
      writeApprovalRequired: input.writeApprovalRequired,
    })
  );
  return { applied, outcome, signals };
}

function ensureBodyOnMatch(content: string): string {
  try {
    const skill = discoveredSkillFromMarkdown(content);
    if (skill.includeBodyOnMatch) {
      return content;
    }
    return buildLearnedSkillMarkdown({
      body: skill.body,
      description: skill.description,
      name: skill.name,
    });
  } catch {
    return content;
  }
}

function latestUserMessage(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return getUserMessageText(message.content);
    }
  }
  return "";
}

function skillNameFromUserMessage(userMessage: string): string {
  const kebab = userMessage.match(/\b[a-z]+(?:-[a-z0-9]+){1,4}\b/i);
  if (kebab?.[0]) {
    return slugifyLearnedSkillName(kebab[0]);
  }
  const words = (userMessage.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(
    (word) => !SKILL_QUERY_STOP_WORDS.has(word)
  );
  return slugifyLearnedSkillName(
    words.slice(0, 3).join("-") || "learned-procedure"
  );
}

function descriptionFromUserMessage(userMessage: string): string {
  const firstLine = userMessage.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length >= 8) {
    return firstLine.slice(0, 180);
  }
  return "Reusable procedure learned from a taught SOP.";
}
