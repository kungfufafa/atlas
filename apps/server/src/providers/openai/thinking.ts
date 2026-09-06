import type { CustomModelEntry } from "@atlas/core";
import { modelSupportsReasoning } from "../reasoning-metadata";

export function openAIModelSupportsThinking(
  model: string,
  customModels?: CustomModelEntry[]
): boolean {
  return modelSupportsReasoning(model, customModels);
}

/** Models that reject `/v1/chat/completions` (Codex completion models). */
export function openAIModelRequiresResponsesApi(model: string): boolean {
  return model.trim().toLowerCase().includes("codex");
}

/**
 * gpt-5.4+ (including gpt-5.6-luna / sol / terra) reject function tools combined
 * with non-none `reasoning_effort` on `/v1/chat/completions`. Use `/v1/responses`
 * or set `reasoning_effort` to `"none"`.
 */
export function openAIModelRejectsChatToolsWithReasoning(
  model: string
): boolean {
  const slug = model.trim().toLowerCase();
  // gpt-5.4 … gpt-5.9, gpt-5.10+, gpt-5.6-luna, etc.
  return /^gpt-5\.(?:[4-9]|\d{2,})/.test(slug);
}
