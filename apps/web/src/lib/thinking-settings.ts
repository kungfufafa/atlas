import type { ThinkingEffort, ThinkingSettings } from "@atlas/core/contract";

export const DEFAULT_THINKING_EFFORT: ThinkingEffort = "medium";

const KNOWN_EFFORT_LABELS: Record<string, string> = {
  high: "High",
  low: "Low",
  max: "Max",
  medium: "Medium",
  none: "None",
  xhigh: "Extra High",
};

const KNOWN_EFFORT_SHORT_LABELS: Record<string, string> = {
  high: "High",
  low: "Low",
  max: "Max",
  medium: "Med",
  none: "Off",
  xhigh: "XHigh",
};

export function thinkingEffortLabel(effort: ThinkingEffort): string {
  if (!effort) {
    return "";
  }
  const key = effort.toLowerCase();
  return (
    KNOWN_EFFORT_LABELS[key] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
  );
}

export function thinkingEffortShortLabel(effort: ThinkingEffort): string {
  if (!effort) {
    return "";
  }
  const key = effort.toLowerCase();
  return KNOWN_EFFORT_SHORT_LABELS[key] ?? effort;
}

export function resolveEffortForOptions(
  effort: ThinkingEffort | undefined,
  validValues: readonly string[] | string[]
): string {
  const trimmed = effort?.trim();
  if (trimmed) {
    if (validValues.includes(trimmed)) {
      return trimmed;
    }
    if (
      (trimmed === "high" || trimmed === "max") &&
      validValues.includes("xhigh")
    ) {
      return "xhigh";
    }
    if (trimmed === "xhigh" && validValues.includes("max")) {
      return "max";
    }
    if (
      (trimmed === "xhigh" || trimmed === "max") &&
      validValues.includes("high")
    ) {
      return "high";
    }
    if (
      (trimmed === "high" || trimmed === "xhigh") &&
      validValues.includes("max")
    ) {
      return "max";
    }
  }
  return (
    validValues[Math.floor(validValues.length / 2)] ??
    validValues[0] ??
    DEFAULT_THINKING_EFFORT
  );
}

export function buildThinkingEffortOptions(
  effortValues?: string[]
): Array<{ value: ThinkingEffort; label: string }> {
  const values = effortValues?.length
    ? effortValues
    : ["low", "medium", "high"];

  return values.map((value) => ({
    label: thinkingEffortLabel(value),
    value,
  }));
}

export function shouldShowThinkingEffort(
  activeModelSupportsThinking: boolean | undefined
): boolean {
  return activeModelSupportsThinking === true;
}

/** Same gate as effort picker — thinking UI only when model explicitly supports reasoning. */
export const shouldShowThinkingBlocks = shouldShowThinkingEffort;

export function buildAutoEnableThinkingPayload(
  settings: Pick<ThinkingSettings, "effort">
): ThinkingSettings {
  return {
    effort: settings.effort ?? DEFAULT_THINKING_EFFORT,
    enabled: true,
  };
}

export function shouldAutoEnableThinking(
  settings: ThinkingSettings | undefined,
  activeModelSupportsThinking: boolean | undefined,
  busy: boolean,
  alreadyMigrated: boolean,
  options?: {
    hasProfileId?: boolean;
    hasRouteSession?: boolean;
    hasSession?: boolean;
    hasMessages?: boolean;
  }
): boolean {
  if (alreadyMigrated || busy || !settings || settings.enabled !== false) {
    return false;
  }

  if (options?.hasProfileId === false) {
    return false;
  }

  if (options?.hasRouteSession || options?.hasSession || options?.hasMessages) {
    return false;
  }

  return activeModelSupportsThinking === true;
}

export function shouldBlockThinkingEffortChange(busy: boolean): boolean {
  return busy;
}
