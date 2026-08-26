import { resolveCompatibleModelCapabilities } from "@atlas/core/compatible-model-capabilities";
import type { CustomModelEntry } from "@atlas/core/contract";
import type { ModelListRow } from "@/components/ModelListEditor";

export function modelListRowVisionEnabled(
  row: Pick<ModelListRow, "supportsVision">,
  visionDefaultOn: boolean
): boolean {
  return visionDefaultOn
    ? row.supportsVision !== false
    : row.supportsVision === true;
}

export function applyInferredCompatibleCapabilities(
  models: ModelListRow[],
  context: { baseUrl?: string; providerLabel?: string } = {}
): ModelListRow[] {
  return models.map((model) => {
    const id = model.id.trim();
    if (!id) {
      return model;
    }

    const inferred = resolveCompatibleModelCapabilities(
      id,
      {
        reasoningEffortValues: model.reasoningEffortValues,
        supportsThinking: model.supportsThinking,
      },
      context
    );

    if (
      inferred.supportsThinking === model.supportsThinking &&
      inferred.reasoningEffortValues === model.reasoningEffortValues
    ) {
      return model;
    }

    return {
      ...model,
      ...inferred,
    };
  });
}

export function toggleModelListRow(
  models: ModelListRow[],
  next: ModelListRow
): ModelListRow[] {
  const existing = models.filter((model) => model.id.trim().length > 0);

  if (existing.some((model) => model.id === next.id)) {
    return existing.filter((model) => model.id !== next.id);
  }

  return [...existing, next];
}

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
