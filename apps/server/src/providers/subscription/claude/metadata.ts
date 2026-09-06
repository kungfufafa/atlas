import type {
  ChatCompletionResult,
  GenerateChatInput,
  ProviderModelOption,
} from "@atlas/core";
import { SubscriptionRuntimeError } from "../errors";

export interface ClaudeRuntimeModel {
  displayName?: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsEffort?: boolean;
  value?: string;
}

export function claudeModelOptions(
  models: ClaudeRuntimeModel[]
): ProviderModelOption[] {
  const options = new Map<string, ProviderModelOption>();
  for (const model of models) {
    const id = model.value?.trim();
    if (!id) {
      continue;
    }
    const effortValues = model.supportedEffortLevels;
    const option: ProviderModelOption = {
      id,
      name: model.displayName?.trim() || id,
      provider: "claude",
      ...(model.supportsAdaptiveThinking === true
        ? { supportsThinking: true }
        : {}),
      ...(model.supportsEffort === false
        ? { reasoningEffortValues: [] }
        : effortValues
          ? { reasoningEffortValues: [...effortValues] }
          : {}),
    };
    options.set(id, option);
    const resolvedModel = model.resolvedModel?.trim();
    if (resolvedModel && resolvedModel !== id && !options.has(resolvedModel)) {
      options.set(resolvedModel, { ...option, id: resolvedModel });
    }
  }
  return [...options.values()];
}

export function claudeThinkingOptions(
  thinking: NonNullable<GenerateChatInput["providerOptions"]>["thinking"],
  model?: ClaudeRuntimeModel
): Record<string, unknown> {
  if (!thinking) {
    return {};
  }
  if (!thinking.enabled) {
    return { thinking: { type: "disabled" } };
  }
  if (model?.supportsAdaptiveThinking !== true) {
    throw new SubscriptionRuntimeError(
      "claude",
      "model_unavailable",
      "The Claude runtime does not advertise adaptive thinking for this model."
    );
  }
  const effort = thinking.effort?.trim();
  if (
    effort &&
    (model.supportsEffort === false ||
      !model.supportedEffortLevels?.includes(effort))
  ) {
    throw new SubscriptionRuntimeError(
      "claude",
      "model_unavailable",
      `The Claude runtime does not advertise reasoning effort "${effort}" for this model.`
    );
  }
  return {
    ...(effort ? { effort } : {}),
    thinking: { display: "summarized", type: "adaptive" },
  };
}

export function readClaudeContextUsage(
  value: unknown
): ChatCompletionResult["contextUsage"] {
  const context = asRecord(value);
  const contextWindow = tokenCount(context.maxTokens);
  const usedTokens = tokenCount(context.totalTokens);
  if (
    contextWindow === undefined ||
    contextWindow <= 0 ||
    usedTokens === undefined
  ) {
    return;
  }
  return { contextWindow, usedTokens };
}

/** Result modelUsage is a running query total, never current context occupancy. */
export function readClaudeTokenUsage(
  record: Record<string, unknown>
): ChatCompletionResult["usage"] {
  const models = Object.values(asRecord(record.modelUsage));
  if (models.length > 0) {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const model of models) {
      const usage = tokenUsage(asRecord(model));
      if (!usage) {
        return;
      }
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
    }
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }
  return tokenUsage(asRecord(record.usage));
}

function tokenUsage(
  record: Record<string, unknown>
): ChatCompletionResult["usage"] {
  const inputTokens = tokenCount(record.inputTokens ?? record.input_tokens);
  const outputTokens = tokenCount(record.outputTokens ?? record.output_tokens);
  const cacheRead = tokenCount(
    record.cacheReadInputTokens ?? record.cache_read_input_tokens ?? 0
  );
  const cacheWrite = tokenCount(
    record.cacheCreationInputTokens ?? record.cache_creation_input_tokens ?? 0
  );
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return;
  }
  const allInputTokens = inputTokens + cacheRead + cacheWrite;
  return {
    inputTokens: allInputTokens,
    outputTokens,
    totalTokens: allInputTokens + outputTokens,
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
