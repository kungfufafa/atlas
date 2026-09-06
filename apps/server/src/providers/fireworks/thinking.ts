import type { CustomModelEntry } from "@atlas/core";
import { modelSupportsReasoning } from "../reasoning-metadata";

export function fireworksModelSupportsThinking(
  model: string,
  customModels?: CustomModelEntry[]
): boolean {
  return modelSupportsReasoning(model, customModels);
}
