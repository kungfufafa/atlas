import type { ProviderModelOption } from "@atlas/core/contract";
import type { ModelListRow } from "@/components/ModelListEditor";
import type { SelectedProvider } from "@/lib/models";

export const CATALOG_SHORTLIST_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "cloudflare",
  "opencode_go",
] as const;

export type CatalogShortlistProvider =
  (typeof CATALOG_SHORTLIST_PROVIDERS)[number];

export function isCatalogShortlistProvider(
  provider: SelectedProvider
): provider is CatalogShortlistProvider {
  return (CATALOG_SHORTLIST_PROVIDERS as readonly string[]).includes(provider);
}

export function shouldShowCatalogModelBrowser(options: {
  customModelCount: number;
  isBrowsing: boolean;
}): boolean {
  return options.isBrowsing || options.customModelCount === 0;
}

export function catalogModelToModelListRow(
  model: ProviderModelOption
): ModelListRow {
  return {
    id: model.id,
    name: model.name,
    ...(model.default ? { default: true } : {}),
    ...(model.inputPerMillionUsd === undefined
      ? {}
      : { inputPerMillionUsd: model.inputPerMillionUsd }),
    ...(model.outputPerMillionUsd === undefined
      ? {}
      : { outputPerMillionUsd: model.outputPerMillionUsd }),
    ...(model.supportsThinking === undefined
      ? {}
      : { supportsThinking: model.supportsThinking }),
    ...(model.reasoningEffortValues?.length
      ? { reasoningEffortValues: model.reasoningEffortValues }
      : {}),
    ...(model.supportsVision === undefined
      ? {}
      : { supportsVision: model.supportsVision }),
  };
}

export function mergeCatalogModelsIntoRows(
  existingRows: ModelListRow[],
  catalogModels: ProviderModelOption[]
): ModelListRow[] {
  const merged: ModelListRow[] = [];
  const usedIds = new Set<string>();
  let hasDefault = false;

  const appendWithSingleDefault = (row: ModelListRow): void => {
    if (row.default && !hasDefault) {
      hasDefault = true;
      merged.push(row);
      return;
    }

    if (row.default) {
      const normalized = { ...row };
      delete normalized.default;
      merged.push(normalized);
      return;
    }

    merged.push(row);
  };

  for (const row of existingRows) {
    const id = row.id.trim();
    if (!id) {
      const placeholder = { ...row };
      delete placeholder.default;
      merged.push(placeholder);
      continue;
    }
    if (usedIds.has(id)) {
      continue;
    }
    usedIds.add(id);
    appendWithSingleDefault(row);
  }

  for (const model of catalogModels) {
    const id = model.id.trim();
    if (!id || usedIds.has(id)) {
      continue;
    }
    usedIds.add(id);
    appendWithSingleDefault(catalogModelToModelListRow({ ...model, id }));
  }

  return merged;
}
