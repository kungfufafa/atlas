import { type CustomModelEntry, findCustomModel } from "@atlas/core";

export function cerebrasModelSupportsThinking(
  model: string,
  customModels?: CustomModelEntry[]
): boolean {
  const trimmed = model.trim();
  const custom = findCustomModel(customModels, trimmed);

  if (custom?.supportsThinking !== undefined) {
    return custom.supportsThinking;
  }

  return false;
}
