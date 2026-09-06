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

function trimNonEmptyStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      result.push(trimmed);
    }
  }
  return result;
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
      ? trimNonEmptyStrings(row.reasoningEffortValues)
      : typeof row.reasoningEffortValues === "string"
        ? trimNonEmptyStrings((row.reasoningEffortValues as string).split(","))
        : undefined;

    return [
      {
        ...row,
        id,
        ...(row.name?.trim() ? { name: row.name.trim() } : {}),
        ...(row.default ? { default: true } : {}),
        ...(row.capabilities === undefined
          ? {}
          : { capabilities: row.capabilities }),
        ...(row.supportsThinking === undefined
          ? {}
          : { supportsThinking: row.supportsThinking }),
        ...(row.supportsVision === undefined
          ? {}
          : { supportsVision: row.supportsVision }),
        ...(reasoningEffortValues === undefined
          ? {}
          : { reasoningEffortValues }),
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

/** A different account or endpoint needs fresh discovery; retain explicit admin claims. */
export function clearConnectionModelMetadata(
  models: ModelListRow[]
): ModelListRow[] {
  return models.map(({ id, name, default: isDefault, capabilities }) => {
    const adminClaims = Object.fromEntries(
      Object.entries(capabilities ?? {}).filter(
        ([, claim]) => claim.source === "admin-override"
      )
    );
    return {
      id,
      ...(name === undefined ? {} : { name }),
      ...(isDefault === undefined ? {} : { default: isDefault }),
      ...(Object.keys(adminClaims).length ? { capabilities: adminClaims } : {}),
    };
  });
}
