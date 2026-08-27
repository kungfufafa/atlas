export const PROVIDER_CAPABILITY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;
export const PROVIDER_ADAPTER_API_VERSION = 1 as const;
export const PROVIDER_CAPABILITY_CONTRACT_VERSION = 1 as const;

export const PROVIDER_CAPABILITY_IDS = {
  audioTranscription: "audio.transcription",
  chatCompletion: "chat.completion",
  chatInputAudio: "chat.input.audio",
  chatInputImage: "chat.input.image",
  chatNativeWebSearch: "chat.native-web-search",
  chatReasoning: "chat.reasoning",
  chatStreaming: "chat.streaming",
  chatStructuredOutput: "chat.structured-output",
  chatToolUse: "chat.tool-use",
  imageGeneration: "image.generation",
  imageUnderstanding: "image.understanding",
} as const;

export type StandardProviderCapabilityId =
  (typeof PROVIDER_CAPABILITY_IDS)[keyof typeof PROVIDER_CAPABILITY_IDS];

/** Capability IDs are open strings so adapters can add operations without a core union change. */
export type ProviderCapabilityId = string;

export type CapabilitySupportStatus = "supported" | "unsupported" | "unknown";

export type CapabilityRuntimeAvailability =
  | "adapter-missing"
  | "credentials-missing"
  | "handler-missing"
  | "ready";

export type CapabilityClaimSource =
  | "admin-override"
  | "legacy-migration"
  | "provider-discovery"
  | "runtime-probe"
  | "static-manifest";

export type CapabilityConstraintValue = boolean | number | string;

export interface ProviderCapabilityConstraints {
  acceptedMimeTypes?: string[];
  maximum?: Record<string, number>;
  minimum?: Record<string, number>;
  supportedValues?: Record<string, CapabilityConstraintValue[]>;
}

export interface ProviderCapabilityClaim {
  constraints?: ProviderCapabilityConstraints;
  source: CapabilityClaimSource;
  status: CapabilitySupportStatus;
  verified?: boolean;
  verifiedAt?: string;
}

export type ProviderCapabilityClaims = Record<
  ProviderCapabilityId,
  ProviderCapabilityClaim
>;

/**
 * Partial admin-authored update for provider-level capability evidence.
 * A null value removes the override and returns resolution to adapter evidence.
 */
export type ProviderCapabilityOverridePatch = Record<
  ProviderCapabilityId,
  CapabilitySupportStatus | null
>;

export interface ProviderCapabilityManifestEntry {
  contractVersion: typeof PROVIDER_CAPABILITY_CONTRACT_VERSION;
  implementation: {
    status: "available" | "unavailable";
  };
  metadata?: ProviderCapabilityMetadata;
  modelDefault: ProviderCapabilityClaim;
  native: ProviderCapabilityClaim;
}

export interface ProviderManifestModelV1 {
  capabilities: ProviderCapabilityClaims;
  id: string;
  name?: string;
}

export interface ProviderCapabilityManifestV1 {
  adapterApiVersion: typeof PROVIDER_ADAPTER_API_VERSION;
  capabilities: Record<ProviderCapabilityId, ProviderCapabilityManifestEntry>;
  manifestRevision: string;
  models?: ProviderManifestModelV1[];
  provider: {
    displayName: string;
    id: string;
  };
  schemaVersion: typeof PROVIDER_CAPABILITY_MANIFEST_SCHEMA_VERSION;
}

export interface CapabilityTarget {
  modelId: string;
  providerId: string;
}

export interface CapabilityBindingV1 {
  contractVersion: typeof PROVIDER_CAPABILITY_CONTRACT_VERSION;
  enabled: boolean;
  fallbacks: CapabilityTarget[];
  mode: "manual";
  options?: Record<string, unknown>;
  primary?: CapabilityTarget;
}

export interface CapabilityConfigV1 {
  bindings: Record<ProviderCapabilityId, CapabilityBindingV1>;
  schemaVersion: typeof PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION;
}

export interface LegacyCapabilitySelections {
  imageModel?: string | null;
  transcriptionModel?: string | null;
  visionModel?: string | null;
}

export interface ProviderCapabilityMetadata {
  description: string;
  label: string;
  routable: boolean;
}

export interface ProviderCapabilityDefinition
  extends ProviderCapabilityMetadata {
  id: ProviderCapabilityId;
}

export const STANDARD_PROVIDER_CAPABILITIES: readonly ProviderCapabilityDefinition[] =
  [
    {
      description: "Generate conversational text responses.",
      id: PROVIDER_CAPABILITY_IDS.chatCompletion,
      label: "Text generation",
      routable: false,
    },
    {
      description: "Accept images directly in a chat request.",
      id: PROVIDER_CAPABILITY_IDS.chatInputImage,
      label: "Image input",
      routable: false,
    },
    {
      description: "Accept audio directly in a chat request.",
      id: PROVIDER_CAPABILITY_IDS.chatInputAudio,
      label: "Audio input",
      routable: false,
    },
    {
      description: "Invoke Atlas tools from a chat response.",
      id: PROVIDER_CAPABILITY_IDS.chatToolUse,
      label: "Tool use",
      routable: false,
    },
    {
      description: "Stream chat output incrementally.",
      id: PROVIDER_CAPABILITY_IDS.chatStreaming,
      label: "Streaming",
      routable: false,
    },
    {
      description: "Return output constrained by a structured schema.",
      id: PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
      label: "Structured output",
      routable: false,
    },
    {
      description: "Use model-native reasoning controls.",
      id: PROVIDER_CAPABILITY_IDS.chatReasoning,
      label: "Reasoning",
      routable: false,
    },
    {
      description: "Search the web through the provider's hosted search tool.",
      id: PROVIDER_CAPABILITY_IDS.chatNativeWebSearch,
      label: "Native web search",
      routable: false,
    },
    {
      description: "Turn an audio recording into text.",
      id: PROVIDER_CAPABILITY_IDS.audioTranscription,
      label: "Audio transcription",
      routable: true,
    },
    {
      description: "Create an image from a text prompt.",
      id: PROVIDER_CAPABILITY_IDS.imageGeneration,
      label: "Image generation",
      routable: true,
    },
    {
      description: "Describe or parse image content for another model.",
      id: PROVIDER_CAPABILITY_IDS.imageUnderstanding,
      label: "Image parsing",
      routable: true,
    },
  ] as const;

const CLAIM_SOURCES = new Set<CapabilityClaimSource>([
  "admin-override",
  "legacy-migration",
  "provider-discovery",
  "runtime-probe",
  "static-manifest",
]);

const SUPPORT_STATUSES = new Set<CapabilitySupportStatus>([
  "supported",
  "unsupported",
  "unknown",
]);

export function validateProviderCapabilityClaims(
  value: unknown,
  path = "capabilities"
): ProviderCapabilityClaims {
  const record = requireRecord(value, path);
  const result: ProviderCapabilityClaims = {};

  for (const [rawCapabilityId, rawClaim] of Object.entries(record)) {
    const capabilityId = rawCapabilityId.trim();
    if (!capabilityId) {
      throw new Error(`${path} contains an empty capability id.`);
    }
    result[capabilityId] = validateCapabilityClaim(
      rawClaim,
      `${path}.${capabilityId}`
    );
  }

  return result;
}

export function validateProviderCapabilityManifest(
  value: unknown
): ProviderCapabilityManifestV1 {
  const manifest = requireRecord(value, "provider capability manifest");
  requireExactVersion(
    manifest.schemaVersion,
    PROVIDER_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    "provider capability manifest schema"
  );
  requireExactVersion(
    manifest.adapterApiVersion,
    PROVIDER_ADAPTER_API_VERSION,
    "provider adapter API"
  );

  const provider = requireRecord(manifest.provider, "manifest.provider");
  const providerId = requireNonEmptyString(provider.id, "manifest.provider.id");
  const displayName = requireNonEmptyString(
    provider.displayName,
    "manifest.provider.displayName"
  );
  const capabilityEntries = requireRecord(
    manifest.capabilities,
    "manifest.capabilities"
  );
  const capabilities: Record<string, ProviderCapabilityManifestEntry> = {};

  for (const [rawCapabilityId, rawEntry] of Object.entries(capabilityEntries)) {
    const capabilityId = rawCapabilityId.trim();
    if (!capabilityId) {
      throw new Error("manifest.capabilities contains an empty capability id.");
    }
    if (capabilities[capabilityId]) {
      throw new Error(
        `manifest.capabilities contains duplicate capability id "${capabilityId}".`
      );
    }
    const entry = requireRecord(
      rawEntry,
      `manifest.capabilities.${capabilityId}`
    );
    requireExactVersion(
      entry.contractVersion,
      PROVIDER_CAPABILITY_CONTRACT_VERSION,
      `manifest.capabilities.${capabilityId}.contractVersion`
    );
    capabilities[capabilityId] = {
      contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
      implementation: validateImplementation(
        entry.implementation,
        `manifest.capabilities.${capabilityId}.implementation`
      ),
      ...(entry.metadata === undefined
        ? {}
        : {
            metadata: validateCapabilityMetadata(
              entry.metadata,
              `manifest.capabilities.${capabilityId}.metadata`
            ),
          }),
      modelDefault: validateCapabilityClaim(
        entry.modelDefault,
        `manifest.capabilities.${capabilityId}.modelDefault`
      ),
      native: validateCapabilityClaim(
        entry.native,
        `manifest.capabilities.${capabilityId}.native`
      ),
    };
  }

  const models = validateManifestModels(manifest.models);

  return {
    adapterApiVersion: PROVIDER_ADAPTER_API_VERSION,
    capabilities,
    manifestRevision: requireNonEmptyString(
      manifest.manifestRevision,
      "manifest.manifestRevision"
    ),
    ...(models ? { models } : {}),
    provider: { displayName, id: providerId },
    schemaVersion: PROVIDER_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  };
}

function validateImplementation(
  value: unknown,
  path: string
): ProviderCapabilityManifestEntry["implementation"] {
  const implementation = requireRecord(value, path);
  const status = implementation.status;
  if (status !== "available" && status !== "unavailable") {
    throw new Error(`${path}.status is invalid.`);
  }
  return { status };
}

function validateCapabilityMetadata(
  value: unknown,
  path: string
): ProviderCapabilityMetadata {
  const metadata = requireRecord(value, path);
  return {
    description: requireNonEmptyString(
      metadata.description,
      `${path}.description`
    ),
    label: requireNonEmptyString(metadata.label, `${path}.label`),
    routable: requireBoolean(metadata.routable, `${path}.routable`),
  };
}

export function validateCapabilityConfig(value: unknown): CapabilityConfigV1 {
  const config = requireRecord(value, "capability config");
  requireExactVersion(
    config.schemaVersion,
    PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION,
    "capability config schema"
  );
  const bindingsRecord = requireRecord(
    config.bindings,
    "capability config.bindings"
  );
  const bindings: Record<string, CapabilityBindingV1> = {};

  for (const [rawCapabilityId, rawBinding] of Object.entries(bindingsRecord)) {
    const capabilityId = rawCapabilityId.trim();
    if (!capabilityId) {
      throw new Error("capability config contains an empty capability id.");
    }
    bindings[capabilityId] = validateCapabilityBinding(
      rawBinding,
      `capability config.bindings.${capabilityId}`
    );
  }

  return {
    bindings,
    schemaVersion: PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION,
  };
}

export function migrateLegacyCapabilityConfig(
  selections: LegacyCapabilitySelections,
  existing?: CapabilityConfigV1 | null
): CapabilityConfigV1 {
  const validated = existing
    ? validateCapabilityConfig(existing)
    : {
        bindings: {},
        schemaVersion: PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION,
      };
  const bindings: Record<string, CapabilityBindingV1> = {
    ...validated.bindings,
  };
  addMissingLegacyBinding(
    bindings,
    PROVIDER_CAPABILITY_IDS.imageUnderstanding,
    selections.visionModel
  );
  addMissingLegacyBinding(
    bindings,
    PROVIDER_CAPABILITY_IDS.audioTranscription,
    selections.transcriptionModel
  );
  addMissingLegacyBinding(
    bindings,
    PROVIDER_CAPABILITY_IDS.imageGeneration,
    selections.imageModel
  );

  return {
    bindings,
    schemaVersion: PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION,
  };
}

function addMissingLegacyBinding(
  bindings: Record<string, CapabilityBindingV1>,
  capabilityId: StandardProviderCapabilityId,
  selection: string | null | undefined
): void {
  if (bindings[capabilityId]) {
    return;
  }
  addLegacyBinding(bindings, capabilityId, selection);
}

export function setCapabilityPrimaryTarget(
  config: CapabilityConfigV1,
  capabilityId: ProviderCapabilityId,
  primary: CapabilityTarget | null
): CapabilityConfigV1 {
  const validated = validateCapabilityConfig(config);
  const current = validated.bindings[capabilityId];
  const nextBinding: CapabilityBindingV1 = {
    contractVersion:
      current?.contractVersion ?? PROVIDER_CAPABILITY_CONTRACT_VERSION,
    enabled: primary ? (current?.enabled ?? true) : false,
    fallbacks: current?.fallbacks ?? [],
    mode: current?.mode ?? "manual",
    ...(current?.options ? { options: current.options } : {}),
    ...(primary
      ? { primary: validateCapabilityTarget(primary, "primary") }
      : {}),
  };

  return {
    bindings: { ...validated.bindings, [capabilityId]: nextBinding },
    schemaVersion: PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION,
  };
}

/** Convert legacy provider-type targets to stable provider instance IDs. */
export function migrateCapabilityTargetProviderIds(
  config: CapabilityConfigV1,
  providers: readonly { id: string; type: string }[],
  defaultProviderId?: string | null
): CapabilityConfigV1 {
  const validated = validateCapabilityConfig(config);
  const providerIds = new Set(providers.map((provider) => provider.id));
  const defaultProvider = providers.find(
    (provider) => provider.id === defaultProviderId
  );
  const resolveTarget = (target: CapabilityTarget): CapabilityTarget => {
    if (providerIds.has(target.providerId)) {
      return target;
    }
    const matches = providers.filter(
      (provider) => provider.type === target.providerId
    );
    const match =
      matches.length === 1
        ? matches[0]
        : matches.find((provider) => provider.id === defaultProvider?.id);
    return match ? { ...target, providerId: match.id } : target;
  };

  return {
    bindings: Object.fromEntries(
      Object.entries(validated.bindings).map(([capabilityId, binding]) => [
        capabilityId,
        {
          ...binding,
          fallbacks: binding.fallbacks.map(resolveTarget),
          ...(binding.primary
            ? { primary: resolveTarget(binding.primary) }
            : {}),
        },
      ])
    ),
    schemaVersion: PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION,
  };
}

/** Merge claims from lowest to highest precedence. */
export function resolveCapabilityClaim(
  ...claims: Array<ProviderCapabilityClaim | null | undefined>
): ProviderCapabilityClaim {
  for (let index = claims.length - 1; index >= 0; index -= 1) {
    const claim = claims[index];
    if (claim) {
      return validateCapabilityClaim(claim, "capability claim");
    }
  }

  return {
    source: "static-manifest",
    status: "unknown",
    verified: false,
  };
}

const CAPABILITY_CLAIM_SOURCE_PRIORITY: Readonly<
  Record<CapabilityClaimSource, number>
> = {
  "admin-override": 4,
  "legacy-migration": 1,
  "provider-discovery": 2,
  "runtime-probe": 3,
  "static-manifest": 0,
};

export function resolveCapabilityClaimsBySource(
  ...claims: Array<ProviderCapabilityClaim | null | undefined>
): ProviderCapabilityClaim {
  let selected: ProviderCapabilityClaim | undefined;
  let selectedPriority = -1;
  const validatedClaims: ProviderCapabilityClaim[] = [];

  for (const claim of claims) {
    if (!claim) {
      continue;
    }
    const validated = validateCapabilityClaim(claim, "capability claim");
    validatedClaims.push(validated);
    const priority = CAPABILITY_CLAIM_SOURCE_PRIORITY[validated.source];
    if (priority >= selectedPriority) {
      selected = validated;
      selectedPriority = priority;
    }
  }

  if (!selected) {
    return resolveCapabilityClaim();
  }

  const constraints = intersectCapabilityConstraints(validatedClaims);
  return {
    ...selected,
    ...(constraints ? { constraints } : {}),
  };
}

/**
 * Evidence may change support status, but it must not widen physical request
 * limits declared by an adapter or a model. Intersect every supplied limit so
 * an admin status override cannot accidentally erase lower-level constraints.
 */
function intersectCapabilityConstraints(
  claims: readonly ProviderCapabilityClaim[]
): ProviderCapabilityConstraints | undefined {
  let acceptedMimeTypes: string[] | undefined;
  let maximum: Record<string, number> | undefined;
  let minimum: Record<string, number> | undefined;
  let supportedValues: Record<string, CapabilityConstraintValue[]> | undefined;

  for (const claim of claims) {
    const constraints = claim.constraints;
    if (!constraints) {
      continue;
    }

    if (constraints.acceptedMimeTypes) {
      acceptedMimeTypes = acceptedMimeTypes
        ? acceptedMimeTypes.filter((value) =>
            constraints.acceptedMimeTypes?.includes(value)
          )
        : [...constraints.acceptedMimeTypes];
    }

    if (constraints.maximum) {
      maximum = mergeNumberLimits(maximum, constraints.maximum, Math.min);
    }

    if (constraints.minimum) {
      minimum = mergeNumberLimits(minimum, constraints.minimum, Math.max);
    }

    if (constraints.supportedValues) {
      supportedValues = mergeSupportedValues(
        supportedValues,
        constraints.supportedValues
      );
    }
  }

  if (
    acceptedMimeTypes === undefined &&
    maximum === undefined &&
    minimum === undefined &&
    supportedValues === undefined
  ) {
    return;
  }

  return {
    ...(acceptedMimeTypes === undefined ? {} : { acceptedMimeTypes }),
    ...(maximum === undefined ? {} : { maximum }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(supportedValues === undefined ? {} : { supportedValues }),
  };
}

function mergeNumberLimits(
  current: Record<string, number> | undefined,
  incoming: Record<string, number>,
  select: (left: number, right: number) => number
): Record<string, number> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = merged[key];
    merged[key] = existing === undefined ? value : select(existing, value);
  }
  return merged;
}

function mergeSupportedValues(
  current: Record<string, CapabilityConstraintValue[]> | undefined,
  incoming: Record<string, CapabilityConstraintValue[]>
): Record<string, CapabilityConstraintValue[]> {
  const merged = Object.fromEntries(
    Object.entries(current ?? {}).map(([key, values]) => [key, [...values]])
  );
  for (const [key, values] of Object.entries(incoming)) {
    const existing = merged[key];
    merged[key] = existing
      ? existing.filter((value) => values.includes(value))
      : [...values];
  }
  return merged;
}

function validateCapabilityClaim(
  value: unknown,
  path: string
): ProviderCapabilityClaim {
  const claim = requireRecord(value, path);
  const status = claim.status;
  if (
    typeof status !== "string" ||
    !SUPPORT_STATUSES.has(status as CapabilitySupportStatus)
  ) {
    throw new Error(`${path}.status is invalid.`);
  }
  const source = claim.source;
  if (
    typeof source !== "string" ||
    !CLAIM_SOURCES.has(source as CapabilityClaimSource)
  ) {
    throw new Error(`${path}.source is invalid.`);
  }
  const constraints =
    claim.constraints === undefined
      ? undefined
      : validateCapabilityConstraints(claim.constraints, `${path}.constraints`);
  const verified =
    claim.verified === undefined
      ? undefined
      : requireBoolean(claim.verified, `${path}.verified`);
  const verifiedAt =
    claim.verifiedAt === undefined
      ? undefined
      : requireNonEmptyString(claim.verifiedAt, `${path}.verifiedAt`);

  return {
    ...(constraints ? { constraints } : {}),
    source: source as CapabilityClaimSource,
    status: status as CapabilitySupportStatus,
    ...(verified === undefined ? {} : { verified }),
    ...(verifiedAt ? { verifiedAt } : {}),
  };
}

function validateCapabilityConstraints(
  value: unknown,
  path: string
): ProviderCapabilityConstraints {
  const constraints = requireRecord(value, path);
  const acceptedMimeTypes = validateOptionalStringArray(
    constraints.acceptedMimeTypes,
    `${path}.acceptedMimeTypes`
  );
  const maximum = validateOptionalNumberRecord(
    constraints.maximum,
    `${path}.maximum`
  );
  const minimum = validateOptionalNumberRecord(
    constraints.minimum,
    `${path}.minimum`
  );
  const supportedValues = validateOptionalSupportedValues(
    constraints.supportedValues,
    `${path}.supportedValues`
  );

  return {
    ...(acceptedMimeTypes ? { acceptedMimeTypes } : {}),
    ...(maximum ? { maximum } : {}),
    ...(minimum ? { minimum } : {}),
    ...(supportedValues ? { supportedValues } : {}),
  };
}

function validateCapabilityBinding(
  value: unknown,
  path: string
): CapabilityBindingV1 {
  const binding = requireRecord(value, path);
  const enabled = requireBoolean(binding.enabled, `${path}.enabled`);
  requireExactVersion(
    binding.contractVersion,
    PROVIDER_CAPABILITY_CONTRACT_VERSION,
    `${path}.contractVersion`
  );
  const mode = binding.mode;
  if (mode !== "manual") {
    throw new Error(`${path}.mode is invalid.`);
  }
  if (!Array.isArray(binding.fallbacks)) {
    throw new Error(`${path}.fallbacks must be an array.`);
  }
  const fallbacks = binding.fallbacks.map((target, index) =>
    validateCapabilityTarget(target, `${path}.fallbacks[${index}]`)
  );
  const primary =
    binding.primary === undefined
      ? undefined
      : validateCapabilityTarget(binding.primary, `${path}.primary`);
  const options =
    binding.options === undefined
      ? undefined
      : requireRecord(binding.options, `${path}.options`);

  return {
    contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
    enabled,
    fallbacks,
    mode,
    ...(options ? { options } : {}),
    ...(primary ? { primary } : {}),
  };
}

function validateCapabilityTarget(
  value: unknown,
  path: string
): CapabilityTarget {
  const target = requireRecord(value, path);
  return {
    modelId: requireNonEmptyString(target.modelId, `${path}.modelId`),
    providerId: requireNonEmptyString(target.providerId, `${path}.providerId`),
  };
}

function validateManifestModels(
  value: unknown
): ProviderManifestModelV1[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error("manifest.models must be an array.");
  }
  const seen = new Set<string>();
  return value.map((rawModel, index) => {
    const model = requireRecord(rawModel, `manifest.models[${index}]`);
    const id = requireNonEmptyString(model.id, `manifest.models[${index}].id`);
    if (seen.has(id)) {
      throw new Error(`manifest.models contains duplicate model id "${id}".`);
    }
    seen.add(id);
    const name =
      model.name === undefined
        ? undefined
        : requireNonEmptyString(model.name, `manifest.models[${index}].name`);
    return {
      capabilities: validateProviderCapabilityClaims(
        model.capabilities,
        `manifest.models[${index}].capabilities`
      ),
      id,
      ...(name ? { name } : {}),
    };
  });
}

function addLegacyBinding(
  bindings: Record<string, CapabilityBindingV1>,
  capabilityId: StandardProviderCapabilityId,
  selection: string | null | undefined
): void {
  const target = decodeLegacyTarget(selection);
  if (!target) {
    return;
  }
  bindings[capabilityId] = {
    contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
    enabled: true,
    fallbacks: [],
    mode: "manual",
    primary: target,
  };
}

function decodeLegacyTarget(
  selection: string | null | undefined
): CapabilityTarget | null {
  const trimmed = selection?.trim();
  if (!trimmed) {
    return null;
  }
  const separator = trimmed.indexOf("::");
  if (separator <= 0 || separator >= trimmed.length - 2) {
    return null;
  }
  return {
    modelId: trimmed.slice(separator + 2).trim(),
    providerId: trimmed.slice(0, separator).trim(),
  };
}

function validateOptionalStringArray(
  value: unknown,
  path: string
): string[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((entry, index) =>
    requireNonEmptyString(entry, `${path}[${index}]`)
  );
}

function validateOptionalNumberRecord(
  value: unknown,
  path: string
): Record<string, number> | undefined {
  if (value === undefined) {
    return;
  }
  const record = requireRecord(value, path);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new Error(`${path}.${key} must be a finite number.`);
    }
    result[key] = entry;
  }
  return result;
}

function validateOptionalSupportedValues(
  value: unknown,
  path: string
): Record<string, CapabilityConstraintValue[]> | undefined {
  if (value === undefined) {
    return;
  }
  const record = requireRecord(value, path);
  const result: Record<string, CapabilityConstraintValue[]> = {};
  for (const [key, entries] of Object.entries(record)) {
    if (!Array.isArray(entries)) {
      throw new Error(`${path}.${key} must be an array.`);
    }
    result[key] = entries.map((entry, index) => {
      if (
        typeof entry !== "boolean" &&
        typeof entry !== "number" &&
        typeof entry !== "string"
      ) {
        throw new Error(`${path}.${key}[${index}] has an invalid value.`);
      }
      return entry;
    });
  }
  return result;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function requireExactVersion(
  value: unknown,
  expected: number,
  label: string
): void {
  if (value !== expected) {
    throw new Error(`${label} version ${String(value)} is not supported.`);
  }
}
