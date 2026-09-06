import type { CompactionConfig } from "@atlas/agent";
import type { ProviderInstance } from "@atlas/core";
import { getModelsForProviderInstance } from "./compatible-models";

/** Resolve against the selected instance: identical IDs on two hosts can differ. */
export function resolveModelCompactionConfig(
  instance: ProviderInstance,
  modelId: string
): CompactionConfig | undefined {
  const model = getModelsForProviderInstance(instance).find(
    (entry) => entry.id === modelId
  );
  const contextWindow = model?.contextWindow;
  if (
    !(
      typeof contextWindow === "number" &&
      Number.isSafeInteger(contextWindow) &&
      contextWindow > 0
    )
  ) {
    return;
  }
  const maxOutputTokens = model?.maxOutputTokens;
  return {
    // Native discovery supplies max_input_tokens / inputTokenLimit, so the
    // advertised window already excludes output capacity.
    ...(instance.type === "anthropic" || instance.type === "gemini"
      ? { contextIncludesOutput: false }
      : {}),
    contextWindow,
    ...(typeof maxOutputTokens === "number" &&
    Number.isSafeInteger(maxOutputTokens) &&
    maxOutputTokens > 0
      ? { maxOutputTokens }
      : {}),
  };
}
