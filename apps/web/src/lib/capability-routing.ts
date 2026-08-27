import type {
  CapabilityBindingV1,
  CapabilityTarget,
} from "@atlas/core/provider-capabilities";

export const DISABLED_CAPABILITY_SELECTION = "__capability_disabled__";
export const NO_PRIMARY_CAPABILITY_SELECTION = "__capability_no_primary__";

const TARGET_SELECTION_PREFIX = "target:";

export function encodeCapabilityTarget(target: CapabilityTarget): string {
  return `${TARGET_SELECTION_PREFIX}${encodeURIComponent(
    JSON.stringify([target.providerId, target.modelId])
  )}`;
}

export function decodeCapabilityTarget(
  selection: string
): CapabilityTarget | null {
  if (!selection.startsWith(TARGET_SELECTION_PREFIX)) {
    return null;
  }

  try {
    const decoded: unknown = JSON.parse(
      decodeURIComponent(selection.slice(TARGET_SELECTION_PREFIX.length))
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string" ||
      !decoded[0].trim() ||
      !decoded[1].trim()
    ) {
      return null;
    }

    return { modelId: decoded[1], providerId: decoded[0] };
  } catch {
    return null;
  }
}

export function buildCapabilityBinding(
  primarySelection: string,
  fallbackSelections: readonly string[]
): CapabilityBindingV1 {
  if (primarySelection === DISABLED_CAPABILITY_SELECTION) {
    return {
      contractVersion: 1,
      enabled: false,
      fallbacks: [],
      mode: "manual",
    };
  }

  const primary = decodeCapabilityTarget(primarySelection);
  if (!(primary || primarySelection === NO_PRIMARY_CAPABILITY_SELECTION)) {
    return {
      contractVersion: 1,
      enabled: false,
      fallbacks: [],
      mode: "manual",
    };
  }

  const seen = new Set(primary ? [encodeCapabilityTarget(primary)] : []);
  const fallbacks: CapabilityTarget[] = [];
  for (const selection of fallbackSelections) {
    const fallback = decodeCapabilityTarget(selection);
    const encoded = fallback ? encodeCapabilityTarget(fallback) : null;
    if (!(fallback && encoded) || seen.has(encoded)) {
      continue;
    }
    seen.add(encoded);
    fallbacks.push(fallback);
  }

  return {
    contractVersion: 1,
    enabled: true,
    fallbacks,
    mode: "manual",
    ...(primary ? { primary } : {}),
  };
}

export function capabilityBindingSelections(
  binding: CapabilityBindingV1 | undefined
): { fallbacks: string[]; primary: string } {
  if (!binding?.enabled) {
    return { fallbacks: [], primary: DISABLED_CAPABILITY_SELECTION };
  }

  return {
    fallbacks: binding.fallbacks.map(encodeCapabilityTarget),
    primary: binding.primary
      ? encodeCapabilityTarget(binding.primary)
      : NO_PRIMARY_CAPABILITY_SELECTION,
  };
}
