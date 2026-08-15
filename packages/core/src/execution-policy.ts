import type { ExecutionPolicy } from "./contract";

export type PolicySource = "explicit" | "override" | "auto" | "fallback";

export interface ExecutionAttempt {
  completedAt?: string;
  createdAt: string;
  error?: string;
  id: string;
  messageId: string;
  parentAttemptId?: string;
  policySource: PolicySource;
  requestedPolicy: ExecutionPolicy;
  resolvedPolicy: ExecutionPolicy;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
}

export interface ResolvePolicyInput {
  documents?: unknown[];
  images?: unknown[];
  overridePolicy?: ExecutionPolicy;
  prompt: string;
  userPolicy?: ExecutionPolicy;
}

export interface PolicyResolution {
  displayLabel: string;
  policy: ExecutionPolicy;
  source: PolicySource;
}

/**
 * Format the user-facing compact display label for Auto or explicit policies.
 * Never exposes internal classifier reasoning.
 */
export function formatPolicyDisplayLabel(
  policy: ExecutionPolicy,
  source: PolicySource
): string {
  const cap = policy.charAt(0).toUpperCase() + policy.slice(1);
  if (source === "auto") {
    return `Auto: ${cap}`;
  }
  if (source === "override") {
    return `Override: ${cap}`;
  }
  return cap;
}

/**
 * Resolves the execution policy following the strict source-of-truth priority:
 * 1. Explicit User Selection (userPolicy !== "auto")
 * 2. Turn Override (overridePolicy)
 * 3. Auto Classification Heuristics
 * 4. Safe Default ("standard")
 */
export function resolveExecutionPolicyWithSource(
  input: ResolvePolicyInput
): PolicyResolution {
  const { prompt, userPolicy, overridePolicy, documents, images } = input;

  // Priority 1: Explicit User Selection (wins over everything when explicitly set by user)
  if (userPolicy && userPolicy !== "auto") {
    return {
      displayLabel: formatPolicyDisplayLabel(userPolicy, "explicit"),
      policy: userPolicy,
      source: "explicit",
    };
  }

  // Priority 2: Turn Override
  if (overridePolicy && overridePolicy !== "auto") {
    return {
      displayLabel: formatPolicyDisplayLabel(overridePolicy, "override"),
      policy: overridePolicy,
      source: "override",
    };
  }

  const hasAttachments = Boolean(
    (documents && documents.length > 0) || (images && images.length > 0)
  );
  const text = prompt.toLowerCase().trim();

  // Priority 3: Auto Classification
  // 1. FAST heuristics: arithmetic, single conversions, direct translations (when no files attached)
  const isSimpleMath =
    !hasAttachments &&
    /^(\d+[\s+\-*/%^()0-9.]+|hitung|berapa|calculate|what is \d+)/i.test(
      text
    ) &&
    text.length < 60;
  if (isSimpleMath) {
    return {
      displayLabel: formatPolicyDisplayLabel("fast", "auto"),
      policy: "fast",
      source: "auto",
    };
  }

  // 2. RESEARCH heuristics: deep investigations, market research, competitor comparison, literature reviews
  const isResearchIntent =
    text.startsWith("research ") ||
    text.startsWith("riset ") ||
    text.includes("deep research") ||
    text.includes("research pasar") ||
    text.includes("market research") ||
    text.includes("comparative study") ||
    (text.includes("compare") && text.includes("sources")) ||
    (text.includes("bandingkan") && text.includes("sumber"));

  if (isResearchIntent) {
    return {
      displayLabel: formatPolicyDisplayLabel("research", "auto"),
      policy: "research",
      source: "auto",
    };
  }

  // 3. AGENT heuristics: browser navigation, purchase/checkout actions, multi-step coding/terminal tasks
  const isAgentIntent =
    text.includes("buka browser") ||
    text.includes("open browser") ||
    text.includes("buka website") ||
    text.includes("buka dashboard") ||
    text.includes("open the test shop") ||
    text.includes("test shop") ||
    text.includes("navigate to") ||
    text.includes("download invoice") ||
    text.includes("place the order") ||
    text.includes("submit order") ||
    text.includes("order ") ||
    text.includes("beli ") ||
    text.includes("checkout") ||
    text.includes("coding agent") ||
    text.includes("github issues") ||
    text.includes("run command in terminal");

  if (isAgentIntent) {
    return {
      displayLabel: formatPolicyDisplayLabel("agent", "auto"),
      policy: "agent",
      source: "auto",
    };
  }

  // Priority 4: Safe Default ("standard")
  return {
    displayLabel: formatPolicyDisplayLabel(
      "standard",
      userPolicy === "auto" ? "auto" : "fallback"
    ),
    policy: "standard",
    source: userPolicy === "auto" ? "auto" : "fallback",
  };
}

/**
 * Backward compatible helper for existing callers.
 */
export function resolveExecutionPolicy(
  input: ResolvePolicyInput
): ExecutionPolicy {
  return resolveExecutionPolicyWithSource(input).policy;
}

/**
 * Create a new execution attempt record.
 */
export function createExecutionAttempt(params: {
  id?: string;
  messageId: string;
  parentAttemptId?: string;
  policyResolution: PolicyResolution;
  requestedPolicy?: ExecutionPolicy;
  sessionId: string;
}): ExecutionAttempt {
  return {
    createdAt: new Date().toISOString(),
    id:
      params.id ||
      `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    messageId: params.messageId,
    parentAttemptId: params.parentAttemptId,
    policySource: params.policyResolution.source,
    requestedPolicy: params.requestedPolicy || "auto",
    resolvedPolicy: params.policyResolution.policy,
    sessionId: params.sessionId,
    status: "queued",
  };
}

/**
 * Process a policy override on an existing attempt: cancels old attempt and creates child attempt.
 */
export function overrideExecutionAttempt(
  activeAttempt: ExecutionAttempt,
  newPolicy: ExecutionPolicy,
  newAttemptId?: string
): { cancelledAttempt: ExecutionAttempt; newAttempt: ExecutionAttempt } {
  const cancelledAttempt: ExecutionAttempt = {
    ...activeAttempt,
    completedAt: new Date().toISOString(),
    status: "cancelled",
  };

  const newAttempt: ExecutionAttempt = {
    createdAt: new Date().toISOString(),
    id:
      newAttemptId ||
      `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    messageId: activeAttempt.messageId,
    parentAttemptId: activeAttempt.id,
    policySource: "override",
    requestedPolicy: newPolicy,
    resolvedPolicy: newPolicy,
    sessionId: activeAttempt.sessionId,
    status: "queued",
  };

  return { cancelledAttempt, newAttempt };
}
