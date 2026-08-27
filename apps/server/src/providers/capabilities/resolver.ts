import type { CapabilityTarget, ProviderCapabilityId } from "@atlas/core";
import { type CapabilityConfigV1, validateCapabilityConfig } from "@atlas/core";
import { type CapabilityRouteAttempt, ProviderCapabilityError } from "./errors";
import type { EffectiveModelCapability } from "./registry";

export interface ResolvedCapabilityRoute {
  fallbackIndex: number | null;
  target: CapabilityTarget;
  trace: CapabilityRouteAttempt[];
}

export function resolveCapabilityRoute(options: {
  capabilityId: ProviderCapabilityId;
  config: CapabilityConfigV1;
  evaluate: (target: CapabilityTarget) => EffectiveModelCapability;
}): ResolvedCapabilityRoute {
  const config = validateCapabilityConfig(options.config);
  const binding = config.bindings[options.capabilityId];
  if (!binding) {
    throw new ProviderCapabilityError({
      capabilityId: options.capabilityId,
      code: "CAPABILITY_NOT_CONFIGURED",
      message: `No model is configured for capability "${options.capabilityId}". Configure it in Settings → Capability mappings.`,
    });
  }
  if (!binding.enabled) {
    throw new ProviderCapabilityError({
      attempts: [],
      capabilityId: options.capabilityId,
      code: "CAPABILITY_NOT_CONFIGURED",
      message: `Capability "${options.capabilityId}" is disabled in Settings → Capability mappings.`,
    });
  }

  const targets = [
    ...(binding.primary ? [binding.primary] : []),
    ...binding.fallbacks,
  ];
  if (targets.length === 0) {
    throw new ProviderCapabilityError({
      capabilityId: options.capabilityId,
      code: "CAPABILITY_NOT_CONFIGURED",
      message: `No model is configured for capability "${options.capabilityId}". Configure it in Settings → Capability mappings.`,
    });
  }

  const trace: CapabilityRouteAttempt[] = [];
  for (const [index, target] of targets.entries()) {
    const effective = options.evaluate(target);
    trace.push({
      modelId: target.modelId,
      providerId: target.providerId,
      reasons: effective.reasons,
    });
    if (effective.selectable) {
      return {
        fallbackIndex: index === 0 && binding.primary ? null : index,
        target,
        trace,
      };
    }
  }

  const hasUnknown = trace.some((attempt) =>
    attempt.reasons.includes("model-unknown")
  );
  const onlyCredentials = trace.every((attempt) =>
    attempt.reasons.includes("credentials-missing")
  );
  throw new ProviderCapabilityError({
    attempts: trace,
    capabilityId: options.capabilityId,
    code: onlyCredentials
      ? "CAPABILITY_CREDENTIALS_MISSING"
      : hasUnknown
        ? "CAPABILITY_UNKNOWN"
        : "CAPABILITY_UNSUPPORTED",
    message: `No configured model can run capability "${options.capabilityId}". Review Settings → Capability mappings.`,
  });
}
