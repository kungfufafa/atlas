import {
  type CustomModelEntry,
  findCustomModel,
  PROVIDER_CAPABILITY_IDS,
} from "@atlas/core";
import { resolveThinkingEffort } from "./shared";

/** Metadata belongs to the selected provider instance and exact model id. */
export function modelSupportsReasoning(
  model: string,
  customModels?: CustomModelEntry[]
): boolean {
  const metadata = findCustomModel(customModels, model.trim());
  const claim = metadata?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatReasoning];
  if (
    metadata?.supportsThinking === false ||
    claim?.status === "unsupported" ||
    claim?.status === "unknown"
  ) {
    return false;
  }
  return (
    claim?.status === "supported" ||
    metadata?.supportsThinking === true ||
    Boolean(metadata?.reasoningEffortValues?.length)
  );
}

export function resolveModelThinkingEffort(
  model: string,
  effort: string | undefined,
  customModels?: CustomModelEntry[]
): string | undefined {
  if (!modelSupportsReasoning(model, customModels)) {
    return;
  }
  const metadata = findCustomModel(customModels, model.trim());
  return resolveThinkingEffort(
    effort,
    metadata?.reasoningEffortValues,
    metadata?.defaultReasoningEffort
  );
}
