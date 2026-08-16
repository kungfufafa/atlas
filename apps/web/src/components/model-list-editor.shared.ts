import type { CustomModelEntry } from "@atlas/core/contract";
import type { ModelListRow } from "@/components/ModelListEditor";

export function normalizeModelListRows(
  models: ModelListRow[]
): CustomModelEntry[] {
  return models.flatMap((row) => {
    const id = row.id.trim();
    if (id.length === 0) {
      return [];
    }

    const reasoningEffortValues = Array.isArray(row.reasoningEffortValues)
      ? row.reasoningEffortValues
          .map((v) => (typeof v === "string" ? v.trim() : ""))
          .filter(Boolean)
      : typeof row.reasoningEffortValues === "string"
        ? (row.reasoningEffortValues as string)
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
        : undefined;

    return [
      {
        id,
        ...(row.name?.trim() ? { name: row.name.trim() } : {}),
        ...(row.default ? { default: true } : {}),
        ...(row.supportsThinking === undefined
          ? {}
          : { supportsThinking: row.supportsThinking }),
        ...(row.supportsVision === undefined
          ? {}
          : { supportsVision: row.supportsVision }),
        ...(reasoningEffortValues && reasoningEffortValues.length > 0
          ? { reasoningEffortValues }
          : {}),
        ...(row.inputPerMillionUsd === undefined
          ? {}
          : { inputPerMillionUsd: row.inputPerMillionUsd }),
        ...(row.outputPerMillionUsd === undefined
          ? {}
          : { outputPerMillionUsd: row.outputPerMillionUsd }),
      },
    ];
  });
}
