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
  validValues: readonly string[] | string[],
  runtimeDefault?: string
): string | undefined {
  const trimmed = effort?.trim();
  if (trimmed && validValues.includes(trimmed)) {
    return trimmed;
  }
  const normalizedDefault = runtimeDefault?.trim();
  return normalizedDefault && validValues.includes(normalizedDefault)
    ? normalizedDefault
    : undefined;
}

export function buildThinkingEffortOptions(
  effortValues?: string[]
): Array<{ value: ThinkingEffort; label: string }> {
  const values = effortValues ?? [];

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
    effort: settings.effort,
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
