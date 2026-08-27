import type { CustomModelEntry, ProviderName, WireApi } from "./contract";
import { validateProviderCapabilityClaims } from "./provider-capabilities";

export const DISPLAY_NAME_MAX_LENGTH = 64;

/** Unknown persisted values intentionally fall back to chat completions. */
export function parseWireApi(value: unknown): WireApi | undefined {
  return typeof value === "string" && value.trim() === "responses"
    ? "responses"
    : undefined;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function isValidBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateDisplayName(displayName: string): string {
  const trimmed = displayName.trim();

  if (!trimmed) {
    throw new Error("Provider name is required.");
  }

  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(
      `Provider name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`
    );
  }

  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error("Provider name contains invalid characters.");
  }

  return trimmed;
}

export function parseCustomModelsJson(
  raw: string | undefined
): CustomModelEntry[] | undefined {
  if (!raw?.trim()) {
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid models_json in config.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("models_json must be a JSON array.");
  }

  return validateCustomModels(parsed);
}

export function validateCustomModels(entries: unknown): CustomModelEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("At least one model is required.");
  }

  const result: CustomModelEntry[] = [];
  const seenModelIds = new Set<string>();
  let defaultCount = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each model entry must be an object.");
    }

    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";

    if (!id) {
      throw new Error("Each model must have a non-empty id.");
    }
    if (seenModelIds.has(id)) {
      throw new Error(`Duplicate model id "${id}".`);
    }
    seenModelIds.add(id);

    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : undefined;
    const isDefault = record.default === true;
    const supportsThinking =
      record.supportsThinking === undefined
        ? undefined
        : record.supportsThinking === true
          ? true
          : record.supportsThinking === false
            ? false
            : (() => {
                throw new Error(
                  `Model "${id}" has invalid supportsThinking flag.`
                );
              })();
    const supportsVision =
      record.supportsVision === undefined
        ? undefined
        : record.supportsVision === true
          ? true
          : record.supportsVision === false
            ? false
            : (() => {
                throw new Error(
                  `Model "${id}" has invalid supportsVision flag.`
                );
              })();
    const capabilities =
      record.capabilities === undefined
        ? undefined
        : validateProviderCapabilityClaims(
            record.capabilities,
            `Model "${id}" capabilities`
          );

    if (isDefault) {
      defaultCount += 1;
    }

    const inputPerMillionUsd = parseOptionalUsdRate(record.inputPerMillionUsd);
    const outputPerMillionUsd = parseOptionalUsdRate(
      record.outputPerMillionUsd
    );

    const reasoningEffortValues = Array.isArray(record.reasoningEffortValues)
      ? record.reasoningEffortValues
          .map((v) => (typeof v === "string" ? v.trim() : ""))
          .filter(Boolean)
      : typeof record.reasoningEffortValues === "string"
        ? record.reasoningEffortValues
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
        : undefined;
    const defaultReasoningEffort =
      typeof record.defaultReasoningEffort === "string" &&
      record.defaultReasoningEffort.trim()
        ? record.defaultReasoningEffort.trim()
        : undefined;

    if (
      defaultReasoningEffort &&
      reasoningEffortValues?.length &&
      !reasoningEffortValues.includes(defaultReasoningEffort)
    ) {
      throw new Error(
        `Model "${id}" has a default reasoning effort that is not in reasoningEffortValues.`
      );
    }

    if (
      (inputPerMillionUsd !== undefined && outputPerMillionUsd === undefined) ||
      (inputPerMillionUsd === undefined && outputPerMillionUsd !== undefined)
    ) {
      throw new Error(
        `Model "${id}" must set both input and output $/1M rates, or leave both blank.`
      );
    }

    result.push({
      id,
      ...(capabilities ? { capabilities } : {}),
      ...(name ? { name } : {}),
      ...(isDefault ? { default: true } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(supportsThinking === undefined ? {} : { supportsThinking }),
      ...(supportsVision === undefined ? {} : { supportsVision }),
      ...(reasoningEffortValues?.length ? { reasoningEffortValues } : {}),
      ...(inputPerMillionUsd === undefined ? {} : { inputPerMillionUsd }),
      ...(outputPerMillionUsd === undefined ? {} : { outputPerMillionUsd }),
    });
  }

  if (defaultCount > 1) {
    throw new Error("At most one model can be marked as default.");
  }

  return result;
}

function parseOptionalUsdRate(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return;
  }

  const numeric = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("Pricing rates must be non-negative numbers.");
  }

  return numeric;
}

export function serializeCustomModels(models: CustomModelEntry[]): string {
  return JSON.stringify(validateCustomModels(models));
}

export function findCustomModel(
  models: CustomModelEntry[] | undefined,
  modelId: string
): CustomModelEntry | undefined {
  return models?.find((model) => model.id === modelId.trim());
}

export function isCompatibleProvider(provider: ProviderName): boolean {
  return provider === "openai_compatible";
}
