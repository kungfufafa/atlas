import type {
  CapabilityCatalogResponse,
  ProviderInstanceSummary,
} from "@atlas/core/contract";
import type {
  CapabilitySupportStatus,
  ProviderCapabilityOverridePatch,
} from "@atlas/core/provider-capabilities";

export const INHERIT_CAPABILITY_EVIDENCE = "inherit" as const;

export type CapabilityEvidenceSelection =
  | CapabilitySupportStatus
  | typeof INHERIT_CAPABILITY_EVIDENCE;

export interface CapabilityEvidenceRow {
  capabilityId: string;
  implementationAvailable: boolean;
  label: string;
}

export function listProviderCapabilityEvidenceRows(
  catalog: CapabilityCatalogResponse,
  providerType: string
): CapabilityEvidenceRow[] {
  const provider = catalog.providers.find((entry) => entry.id === providerType);
  if (!provider) {
    return [];
  }

  const providerCapabilities = new Map(
    provider.capabilities.map((entry) => [entry.capabilityId, entry])
  );

  return catalog.capabilities.flatMap((definition) => {
    const providerCapability = providerCapabilities.get(definition.id);
    if (definition.routable || !providerCapability) {
      return [];
    }

    return [
      {
        capabilityId: definition.id,
        implementationAvailable: providerCapability.implementationAvailable,
        label: definition.label,
      },
    ];
  });
}

export function capabilityEvidenceSettingLabel(
  selection: CapabilityEvidenceSelection
): string {
  if (selection === INHERIT_CAPABILITY_EVIDENCE) {
    return "Provider default";
  }
  return `${selection.charAt(0).toUpperCase()}${selection.slice(1)}`;
}

export function capabilityEvidenceSelectionIsDisabled(
  row: CapabilityEvidenceRow,
  selection: CapabilityEvidenceSelection
): boolean {
  return selection === "supported" && !row.implementationAvailable;
}

export function capabilityEvidenceSelections(
  rows: CapabilityEvidenceRow[],
  instance: ProviderInstanceSummary
): Record<string, CapabilityEvidenceSelection> {
  return Object.fromEntries(
    rows.map((row) => [
      row.capabilityId,
      instance.capabilityOverrides?.[row.capabilityId]?.status ??
        INHERIT_CAPABILITY_EVIDENCE,
    ])
  );
}

export function buildCapabilityEvidencePatch(
  rows: CapabilityEvidenceRow[],
  original: Record<string, CapabilityEvidenceSelection>,
  current: Record<string, CapabilityEvidenceSelection>
): ProviderCapabilityOverridePatch {
  const patch: ProviderCapabilityOverridePatch = {};

  for (const row of rows) {
    const capabilityId = row.capabilityId;
    const before = original[capabilityId] ?? INHERIT_CAPABILITY_EVIDENCE;
    const after = current[capabilityId] ?? INHERIT_CAPABILITY_EVIDENCE;
    if (before === after) {
      continue;
    }
    patch[capabilityId] = after === INHERIT_CAPABILITY_EVIDENCE ? null : after;
  }

  return patch;
}
