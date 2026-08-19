import { toOpenCodeGoApiModelId } from "../models";

export type OpenCodeGoApiKind = "chat" | "messages" | "responses";

const RESPONSES_MODEL_IDS = new Set([
  "grok-4.5",
  "gpt-5.6-luna",
  "muse-spark-1.2",
]);

export function resolveOpenCodeGoApiKind(model: string): OpenCodeGoApiKind {
  const id = toOpenCodeGoApiModelId(model).toLowerCase();

  if (
    RESPONSES_MODEL_IDS.has(id) ||
    id.startsWith("grok-") ||
    id.startsWith("gpt-") ||
    id.startsWith("muse-")
  ) {
    return "responses";
  }

  if (id.startsWith("minimax-") || id.startsWith("qwen")) {
    return "messages";
  }

  return "chat";
}
