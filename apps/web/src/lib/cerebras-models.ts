export interface CerebrasApiPricing {
  completion?: string;
  prompt?: string;
}

export interface CerebrasApiCapabilities {
  function_calling?: boolean;
  json_mode?: boolean;
  reasoning?: boolean;
  streaming?: boolean;
  structured_outputs?: boolean;
  tools?: boolean;
  vision?: boolean;
}

export interface CerebrasApiModel {
  capabilities?: CerebrasApiCapabilities;
  deprecated?: boolean;
  description?: string;
  id: string;
  limits?: {
    max_context_length?: number;
    max_completion_tokens?: number;
  };
  name: string;
  preview?: boolean;
  pricing?: CerebrasApiPricing;
}

export interface CerebrasModelsApiResponse {
  data?: CerebrasApiModel[];
  object?: string;
}

export interface CerebrasModelRow {
  contextLength: number;
  deprecated: boolean;
  description: string;
  id: string;
  inputPerMillionUsd?: number;
  maxOutputTokens?: number;
  name: string;
  outputPerMillionUsd?: number;
  preview: boolean;
  reasoning?: boolean;
  tools?: boolean;
  vision?: boolean;
}

export function cerebrasPricingPerMillion(
  pricing: CerebrasApiPricing | undefined
):
  | Pick<CerebrasModelRow, "inputPerMillionUsd" | "outputPerMillionUsd">
  | undefined {
  if (!(pricing?.prompt && pricing?.completion)) {
    return;
  }

  const inputPerMillionUsd = Number.parseFloat(pricing.prompt) * 1_000_000;
  const outputPerMillionUsd = Number.parseFloat(pricing.completion) * 1_000_000;

  if (
    !(
      Number.isFinite(inputPerMillionUsd) &&
      Number.isFinite(outputPerMillionUsd)
    )
  ) {
    return;
  }

  return { inputPerMillionUsd, outputPerMillionUsd };
}

function truncateDescription(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 160) {
    return trimmed;
  }

  return `${trimmed.slice(0, 157)}...`;
}

export function normalizeCerebrasModel(
  entry: CerebrasApiModel
): CerebrasModelRow {
  const capabilities = entry.capabilities ?? {};
  const perMillion = cerebrasPricingPerMillion(entry.pricing);

  return {
    contextLength: entry.limits?.max_context_length ?? 0,
    deprecated: entry.deprecated === true,
    description: truncateDescription(entry.description ?? ""),
    id: entry.id,
    maxOutputTokens: entry.limits?.max_completion_tokens,
    name: entry.name,
    preview: entry.preview === true,
    reasoning: capabilities.reasoning,
    tools: capabilities.tools ?? capabilities.function_calling,
    vision: capabilities.vision,
    ...(perMillion ?? {}),
  };
}

export function normalizeCerebrasModels(
  apiJson: CerebrasModelsApiResponse
): CerebrasModelRow[] {
  const data = apiJson.data ?? [];
  return data.map(normalizeCerebrasModel).sort(compareCerebrasModelRows);
}

export function compareCerebrasModelRows(
  a: CerebrasModelRow,
  b: CerebrasModelRow
): number {
  return a.name.localeCompare(b.name);
}
