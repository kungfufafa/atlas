import type { AgentChannel, ChatMessage } from "../contract";
import { getUserMessageText } from "../message-content";
import type { SkillPostTurnReviewSources } from "./post-turn-review";
import { resolveSkillPostTurnReviewEnabled } from "./post-turn-review";

export const UNKNOWN_TOOL_ERROR_PREFIX = "Unknown tool:";

export const SKILL_LEARNING_INTERACTIVE_CHANNELS = new Set<AgentChannel>([
  "web",
  "cli",
]);

export type SkillLearningStopReason = "no_progress" | "iteration_limit";

export const SNAKE_CASE_TOOL_NAME = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi;

export type SkillLearningSignal =
  | { kind: "unknown_tool"; toolName: string }
  | { kind: "requested_unassigned_tool"; toolName: string }
  | { kind: "tool_loop_stop"; reason: SkillLearningStopReason }
  | { kind: "tool_error"; toolName?: string }
  | { kind: "taught_procedure" };

export interface SkillFailureLearningSources
  extends SkillPostTurnReviewSources {
  /** Session/eval override. true/false wins; unset inherits post-turn review (default off). */
  sessionEnabled?: boolean | null;
}

/** Default-safe: off unless the session forces it or post-turn review is opted in. */
export function resolveSkillFailureLearningEnabled(
  sources: SkillFailureLearningSources
): boolean {
  if (sources.sessionEnabled === true) {
    return true;
  }
  if (sources.sessionEnabled === false) {
    return false;
  }
  return resolveSkillPostTurnReviewEnabled(sources);
}

export function skillLearningAllowedOnChannel(
  channel: AgentChannel | undefined
): boolean {
  if (!channel) {
    return true;
  }
  return SKILL_LEARNING_INTERACTIVE_CHANNELS.has(channel);
}

export function parseUnknownToolName(content: string): string | null {
  const fromJson = unknownToolNameFromJson(content);
  if (fromJson) {
    return fromJson;
  }
  const trimmed = content.trim();
  if (!trimmed.startsWith(UNKNOWN_TOOL_ERROR_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(UNKNOWN_TOOL_ERROR_PREFIX.length).trim();
  return name || null;
}

export function extractSnakeCaseToolNames(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of text.matchAll(SNAKE_CASE_TOOL_NAME)) {
    const name = match[0];
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(key);
  }
  return names;
}

export function looksLikeTaughtProcedure(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) {
    return false;
  }
  if (
    /\b(you must|must follow|procedure|runbook|sop|standard operating)\b/i.test(
      text
    )
  ) {
    return true;
  }
  return /(?:^|\n)\s*\d+\.\s+\S/.test(text);
}

export function collectSkillLearningSignals(input: {
  assignedToolNames?: readonly string[];
  stopReason?: SkillLearningStopReason | null;
  turnMessages: ChatMessage[];
}): SkillLearningSignal[] {
  const signals: SkillLearningSignal[] = [];
  const unknownNames = new Set<string>();
  let toolCallCount = 0;
  let userMessage = "";
  let sawToolError = false;

  for (const message of input.turnMessages) {
    if (message.role === "user" && !userMessage) {
      userMessage = getUserMessageText(message.content);
    }
    if (message.role === "assistant" && message.toolCalls) {
      toolCallCount += message.toolCalls.length;
    }
    if (message.role !== "tool") {
      continue;
    }
    const unknownName = parseUnknownToolName(message.content);
    if (unknownName) {
      unknownNames.add(unknownName.toLowerCase());
      continue;
    }
    if (toolContentHasError(message.content)) {
      sawToolError = true;
      signals.push({
        kind: "tool_error",
        ...(message.name ? { toolName: message.name } : {}),
      });
    }
  }

  for (const toolName of unknownNames) {
    signals.push({ kind: "unknown_tool", toolName });
  }

  const assigned = new Set(
    (input.assignedToolNames ?? []).map((name) => name.toLowerCase())
  );
  if (assigned.size > 0) {
    for (const toolName of extractSnakeCaseToolNames(userMessage)) {
      if (assigned.has(toolName) || unknownNames.has(toolName)) {
        continue;
      }
      signals.push({ kind: "requested_unassigned_tool", toolName });
    }
  }

  if (input.stopReason) {
    signals.push({ kind: "tool_loop_stop", reason: input.stopReason });
  }

  if (looksLikeTaughtProcedure(userMessage) && toolCallCount >= 2) {
    signals.push({ kind: "taught_procedure" });
  }

  if (sawToolError && unknownNames.size === 0 && signals.length === 0) {
    signals.push({ kind: "tool_error" });
  }

  return signals;
}

export function skillLearningIsEligible(
  signals: readonly SkillLearningSignal[]
): boolean {
  return signals.length > 0;
}

function unknownToolNameFromJson(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
      return null;
    }
    const error = (parsed as { error: unknown }).error;
    if (typeof error !== "string") {
      return null;
    }
    return parseUnknownToolName(error);
  } catch {
    return null;
  }
}

function toolContentHasError(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      (parsed as { error: unknown }).error != null
    );
  } catch {
    return false;
  }
}
