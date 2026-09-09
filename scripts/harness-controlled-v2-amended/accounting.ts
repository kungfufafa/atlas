import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  comparisonLimits,
  comparisonModel,
  upstreamEndpoint,
} from "../harness-compare-v2-transport/proxy";

export interface RequestEvidence {
  cachedTokens: number | null;
  effectiveControlsValid: boolean;
  generatedTokens: number | null;
  index: number;
  maxOutputTokens: number | null;
  promptTokens: number | null;
  reason: string | null;
  responseModel: string | null;
  status: number | null;
}

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function requestEvidence(
  index: number,
  request: unknown,
  response: unknown,
  transportError: boolean
): RequestEvidence {
  const outer = object(response);
  const status = count(outer.status);
  const usage = object(object(outer.response).usage);
  const promptTokens = count(usage.prompt_tokens);
  const generatedTokens = count(usage.completion_tokens);
  let reason: string | null = null;
  if (transportError) {
    reason = "transport_error";
  } else if (status === null) {
    reason = "missing_response";
  } else if (status < 200 || status >= 300) {
    reason = "non_2xx_response";
  } else if (promptTokens === null || generatedTokens === null) {
    reason = "missing_or_invalid_mandatory_usage";
  }
  const maximum = count(object(object(request).effective).max_tokens);
  const effective = object(object(request).effective);
  const responseModel =
    typeof object(outer.response).model === "string"
      ? (object(outer.response).model as string)
      : null;
  const effectiveControlsValid =
    object(request).upstreamEndpoint === upstreamEndpoint &&
    object(request).model === comparisonModel &&
    object(object(request).request).model === comparisonModel &&
    effective.model === comparisonModel &&
    effective.stream === false &&
    effective.temperature === 0.2 &&
    !("thinking" in effective) &&
    !("reasoning_effort" in effective) &&
    !("reasoning" in effective) &&
    !("reasoning_config" in effective) &&
    !("enable_thinking" in effective) &&
    !("max_completion_tokens" in effective) &&
    !("stream_options" in effective);
  if (
    (!effectiveControlsValid ||
      (responseModel !== null && responseModel !== comparisonModel)) &&
    reason === null
  ) {
    reason = "model_or_effective_controls_mismatch";
  }
  if (responseModel === null && reason === null) {
    reason = "missing_returned_model_identity";
  }
  if (maximum === null && reason === null) {
    reason = "missing_effective_request";
  }
  return {
    cachedTokens:
      count(object(usage.prompt_tokens_details).cached_tokens) ??
      count(usage.prompt_cache_hit_tokens),
    effectiveControlsValid,
    generatedTokens,
    index,
    maxOutputTokens: maximum,
    promptTokens,
    reason,
    responseModel,
    status,
  };
}

export function certifyUsage(
  requests: RequestEvidence[],
  providerRequests: number,
  elapsedMs: number | null,
  timedOut = false,
  knownAdmissionExhaustion = false,
  rejectionEvidenceValid = true
) {
  const sequenceValid =
    count(providerRequests) !== null &&
    requests.length === providerRequests &&
    requests.every((request, index) => request.index === index + 1);
  const mandatoryUsageKnown =
    sequenceValid &&
    providerRequests > 0 &&
    requests.every((request) => request.reason === null);
  let previousGenerated = 0;
  let outputEnvelopeValid = true;
  for (const request of requests) {
    if (
      request.maxOutputTokens !==
      Math.min(
        comparisonLimits.perResponseTokens,
        comparisonLimits.generatedTokens - previousGenerated
      )
    ) {
      outputEnvelopeValid = false;
    }
    if (
      request.status !== null &&
      request.status >= 200 &&
      request.status < 300
    ) {
      previousGenerated += request.generatedTokens ?? 0;
    }
  }
  const elapsedKnown =
    typeof elapsedMs === "number" &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0;
  const successful = requests.filter(
    (request) =>
      request.status !== null && request.status >= 200 && request.status < 300
  );
  const observedGeneratedTokens = successful.reduce(
    (total, request) => total + (request.generatedTokens ?? 0),
    0
  );
  const observedPromptTokens = successful.reduce(
    (total, request) => total + (request.promptTokens ?? 0),
    0
  );
  const budgetReasons: string[] = [];
  if (
    timedOut ||
    (elapsedMs !== null && elapsedMs > comparisonLimits.timeoutMs)
  ) {
    budgetReasons.push("observed_wall_clock_limit");
  }
  if (providerRequests > comparisonLimits.providerRequests) {
    budgetReasons.push("observed_request_limit");
  }
  if (observedGeneratedTokens > comparisonLimits.generatedTokens) {
    budgetReasons.push("observed_generated_token_limit");
  }
  if (
    successful.some(
      (request) =>
        request.generatedTokens !== null &&
        request.maxOutputTokens !== null &&
        request.generatedTokens > request.maxOutputTokens
    )
  ) {
    budgetReasons.push("observed_per_response_limit");
  }
  if (knownAdmissionExhaustion) {
    budgetReasons.push("known_budget_admission_exhaustion");
  }
  return {
    accountingUncertain: !(
      mandatoryUsageKnown &&
      elapsedKnown &&
      outputEnvelopeValid &&
      rejectionEvidenceValid
    ),
    budgetExceeded: budgetReasons.length > 0,
    budgetReasons,
    cachedTokens:
      mandatoryUsageKnown &&
      requests.every((request) => request.cachedTokens !== null)
        ? requests.reduce((total, request) => total + request.cachedTokens!, 0)
        : null,
    costUsd: null,
    elapsedMs,
    generatedTokens: mandatoryUsageKnown ? observedGeneratedTokens : null,
    mandatoryUsageKnown,
    missingUsage: !mandatoryUsageKnown,
    observedGeneratedTokens,
    observedPromptTokens,
    outputEnvelopeValid,
    promptTokens: mandatoryUsageKnown ? observedPromptTokens : null,
    providerRequests,
    rejectionEvidenceValid,
    requests,
    sequenceValid,
    withinBudgetCertified:
      mandatoryUsageKnown &&
      elapsedKnown &&
      outputEnvelopeValid &&
      rejectionEvidenceValid &&
      budgetReasons.length === 0,
  };
}

async function optionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Wire files are the authority. The original proxy's missing-usage budget flag is not evidence of an overrun. */
export async function readUsage(
  directory: string,
  providerRequests: number,
  elapsedMs: number | null,
  timedOut = false
) {
  const requests: RequestEvidence[] = [];
  const indices = new Set(
    Array.from({ length: providerRequests }, (_, index) => index + 1)
  );
  for (const name of await readdir(directory)) {
    const match = name.match(
      /^(\d+)-(?:request|response|transport-error)\.json$/
    );
    if (match) {
      indices.add(Number(match[1]));
    }
  }
  for (const index of [...indices].sort((left, right) => left - right)) {
    const prefix = join(directory, String(index).padStart(3, "0"));
    const [request, response, transport] = await Promise.all([
      optionalJson(`${prefix}-request.json`),
      optionalJson(`${prefix}-response.json`),
      optionalJson(`${prefix}-transport-error.json`),
    ]);
    requests.push(
      requestEvidence(index, request, response, transport !== null)
    );
  }
  let knownAdmissionExhaustion = false;
  let rejectionEvidenceValid = true;
  try {
    const lines = (
      await readFile(join(directory, "budget-rejections.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    for (const line of lines) {
      try {
        const event = object(JSON.parse(line));
        const complete = [
          event.requests,
          event.generatedTokens,
          event.elapsed,
        ].every((value) => count(value) !== null);
        rejectionEvidenceValid &&= complete;
        knownAdmissionExhaustion ||=
          (count(event.requests) ?? -1) >= comparisonLimits.providerRequests ||
          (count(event.generatedTokens) ?? -1) >=
            comparisonLimits.generatedTokens ||
          (count(event.elapsed) ?? -1) >= comparisonLimits.timeoutMs;
      } catch {
        rejectionEvidenceValid = false;
      }
    }
  } catch (error) {
    // No rejection file means no observed admission exhaustion; missing usage alone is not exhaustion.
    rejectionEvidenceValid = (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  return certifyUsage(
    requests,
    providerRequests,
    elapsedMs,
    timedOut,
    knownAdmissionExhaustion,
    rejectionEvidenceValid
  );
}

export type CertifiedUsage = ReturnType<typeof certifyUsage>;
