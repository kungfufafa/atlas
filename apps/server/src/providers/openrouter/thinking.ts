import type { CustomModelEntry } from "@atlas/core";
import { modelSupportsReasoning } from "../reasoning-metadata";

export function openRouterModelSupportsThinking(
  model: string,
  customModels?: CustomModelEntry[]
): boolean {
  return modelSupportsReasoning(model, customModels);
}

/** An id alone supplies no capability evidence. */
export function openRouterSlugSupportsThinking(_model: string): boolean {
  return false;
}
