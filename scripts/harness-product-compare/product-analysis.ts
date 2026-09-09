import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

type Row = Record<string, unknown>;
type Harness = "atlas" | "hermes";
export type ProductTrack = "memory" | "files";
const ARMS: Harness[] = ["atlas", "hermes"];
const MEMORY_FAMILIES = [
  "durable_fact",
  "implicit_preference",
  "corrected_fact",
  "distractor_recall",
  "unsupported_fact",
  "forgotten_preference",
  "cross_language",
  "episodic_decision",
];
const FILE_FAMILIES = [
  "xlsx_reconciliation",
  "xlsx_surgical_edit",
  "docx_revision",
  "docx_report",
  "pdf_extract",
  "pdf_create",
  "pptx_revision",
  "csv_join",
  "code_fix",
];
const CONDITIONS = ["native-default", "explicit-memory"];
const HASH = /^[a-f0-9]{64}$/;
const BYTE_LIMIT = 100_000_000;
const ANALYSIS_PATH = "scripts/harness-product-compare/product-analysis.ts";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const measured = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const equals = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const mean = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

export interface ProductPair {
  condition?: string;
  family: string;
  order: Harness[];
  pairId: string;
  recallIdentity?: string;
  repetition: number;
  seed?: number;
  stratum?: string;
  taskId?: string;
  variant?: number;
}

export interface ProductAnalysisInput {
  budget: {
    maxGeneratedTokens: number;
    maxOutputTokens: number;
    maxProviderRequests: number;
    timeoutMs: number;
  };
  candidateSourceHash: string;
  ledger: unknown[];
  phase: string;
  provenanceIssues: string[];
  schedule: ProductPair[];
  track: ProductTrack;
  transportMode: string;
}

function quantile(sorted: number[], probability: number): number | null {
  if (!sorted.length) {
    return null;
  }
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  return (
    sorted[lower]! * (1 - position + lower) +
    sorted[Math.ceil(position)]! * (position - lower)
  );
}

function distribution(values: Array<number | null>) {
  const known = values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  return {
    mean: mean(known),
    measuredCount: known.length,
    median: quantile(known, 0.5),
    missingCount: values.length - known.length,
    observedTotal: known.length
      ? known.reduce((sum, value) => sum + value, 0)
      : null,
    p95: quantile(known, 0.95),
    total:
      known.length === values.length && values.length
        ? known.reduce((sum, value) => sum + value, 0)
        : null,
  };
}

/** Whole families are sampled; seeds and repetitions never become independent clusters. */
export function productFamilyBootstrap(effects: number[], seed: number) {
  const draws = 100_000;
  if (!effects.length) {
    return null;
  }
  let state = seed;
  const samples: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let sum = 0;
    let remaining = effects.length;
    while (remaining-- > 0) {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      sum += effects[Math.floor((state / 4_294_967_296) * effects.length)]!;
    }
    samples.push(sum / effects.length);
  }
  samples.sort((a, b) => a - b);
  const interval = (confidence: number) => ({
    confidence,
    lower: quantile(samples, (1 - confidence) / 2)!,
    upper: quantile(samples, 1 - (1 - confidence) / 2)!,
  });
  const descriptive95 = interval(0.95);
  const simultaneous97_5 = interval(0.975);
  return {
    clusters: effects.length,
    degenerate: descriptive95.upper - descriptive95.lower <= 1e-12,
    descriptive95,
    draws,
    familyEffects: effects,
    method:
      "Percentile paired bootstrap of equal-weight family effects; repetitions averaged within seeded instance.",
    pointEstimate: mean(effects),
    seed,
    simultaneous97_5,
  };
}

/** Independently rederive certification from finalized per-request mandatory usage. */
export function certifyProductUsage(
  record: Row,
  budget: ProductAnalysisInput["budget"]
) {
  const evidence = object(record.usageEvidence);
  const usage = object(record.usage);
  const requests = array(evidence.requests).map(object);
  const issues: string[] = [];
  if (
    evidence.finalized !== true ||
    evidence.mandatoryUsageKnown !== true ||
    evidence.observationError !== false ||
    evidence.inFlightRequests !== 0
  ) {
    issues.push("usage_not_finalized_or_uncertain");
  }
  if (count(usage.providerRequests) !== requests.length) {
    issues.push("request_count_mismatch");
  }
  if (
    !requests.every(
      (request, index) =>
        request.index === index + 1 &&
        request.kind === "success" &&
        typeof request.status === "number" &&
        request.status >= 200 &&
        request.status < 300 &&
        count(request.promptTokens) !== null &&
        count(request.generatedTokens) !== null
    )
  ) {
    issues.push("mandatory_request_usage_unknown");
  }
  const observedGenerated = requests.reduce(
    (sum, request) => sum + (count(request.generatedTokens) ?? 0),
    0
  );
  const observedPrompt = requests.reduce(
    (sum, request) => sum + (count(request.promptTokens) ?? 0),
    0
  );
  if (
    evidence.generatedTokens !== observedGenerated ||
    evidence.promptTokens !== observedPrompt ||
    usage.generatedTokens !== observedGenerated ||
    usage.promptTokens !== observedPrompt
  ) {
    issues.push("mandatory_usage_totals_disagree");
  }
  const elapsed = measured(record.elapsedMs);
  if (elapsed === null) {
    issues.push("required_invocation_time_unknown");
  }
  const budgetExceeded =
    requests.length > budget.maxProviderRequests ||
    observedGenerated > budget.maxGeneratedTokens ||
    requests.some(
      (request) =>
        (count(request.generatedTokens) ?? 0) > budget.maxOutputTokens
    ) ||
    (elapsed !== null && elapsed > budget.timeoutMs) ||
    usage.budgetExceeded === true;
  if (budgetExceeded) {
    issues.push("budget_exceeded");
  }
  // A measured overrun is a valid observed failure, not unknown accounting.
  const known = issues.every((issue) => issue === "budget_exceeded");
  const cacheKnown =
    known && requests.every((request) => count(request.cachedTokens) !== null);
  const cachedTokens = cacheKnown
    ? requests.reduce((sum, request) => sum + Number(request.cachedTokens), 0)
    : null;
  return {
    budgetExceeded,
    cachedTokens,
    generatedTokens: known ? observedGenerated : null,
    issues,
    known,
    observedGeneratedTokens:
      measured(evidence.observedGeneratedTokens) ??
      measured(usage.observedGeneratedTokens),
    observedPromptTokens:
      measured(evidence.observedPromptTokens) ??
      measured(usage.observedPromptTokens),
    promptTokens: known ? observedPrompt : null,
    providerRequests: count(usage.providerRequests),
  };
}

interface Attempt {
  ends: Row[];
  errors: Row[];
  id: string;
  starts: Row[];
}

/** Report only reason codes; request/response bodies never enter the analysis report. */
export function validateProductWire(
  requestValue: unknown,
  responseValue: unknown,
  usageValue: unknown,
  expected: {
    model: string;
    endpoint: string;
    maxOutputTokens: number;
    remainingGeneratedTokens: number;
  }
): string[] {
  const request = object(requestValue);
  const effective = object(request.effective);
  const response = object(responseValue);
  const body = object(response.response);
  const reported = object(body.usage);
  const usage = object(usageValue);
  const issues: string[] = [];
  if (
    !expected.model ||
    request.model !== expected.model ||
    object(request.request).model !== expected.model ||
    effective.model !== expected.model
  ) {
    issues.push("effective_model_mismatch");
  }
  if (!expected.endpoint || request.upstreamEndpoint !== expected.endpoint) {
    issues.push("upstream_endpoint_mismatch");
  }
  const maxTokens = count(effective.max_tokens);
  if (
    effective.stream !== false ||
    effective.temperature !== 0.2 ||
    maxTokens === null ||
    maxTokens === 0 ||
    maxTokens !==
      Math.min(expected.maxOutputTokens, expected.remainingGeneratedTokens) ||
    [
      "max_completion_tokens",
      "stream_options",
      "reasoning_effort",
      "thinking",
    ].some((key) => Object.hasOwn(effective, key))
  ) {
    issues.push("effective_settings_mismatch");
  }
  for (const key of ["reasoning", "reasoning_config", "enable_thinking"]) {
    if (Object.hasOwn(effective, key)) {
      issues.push(`undeclared_reasoning_control:${key}`);
    }
  }
  if (body.model !== expected.model) {
    issues.push("returned_model_mismatch");
  }
  if (
    response.status !== usage.status ||
    !(
      typeof response.status === "number" &&
      response.status >= 200 &&
      response.status < 300
    )
  ) {
    issues.push("response_status_mismatch");
  }
  if (
    count(reported.prompt_tokens) === null ||
    count(reported.completion_tokens) === null ||
    reported.prompt_tokens !== usage.promptTokens ||
    reported.completion_tokens !== usage.generatedTokens
  ) {
    issues.push("response_usage_mismatch");
  }
  return issues;
}
interface Paired {
  arms: Record<Harness, { attempt?: Attempt; end?: Row; valid: boolean }>;
  definition: ProductPair;
}

function indexLedger(input: ProductAnalysisInput) {
  const issues: string[] = [];
  const attempts = new Map<string, Attempt>();
  const events = input.ledger.map(object);
  for (const event of events) {
    const id = string(event.id);
    if (!["start", "end", "error"].includes(string(event.event))) {
      continue;
    }
    if (!id) {
      issues.push("ledger_event_missing_attempt_id");
      continue;
    }
    const attempt = attempts.get(id) ?? {
      ends: [],
      errors: [],
      id,
      starts: [],
    };
    if (event.event === "start") {
      attempt.starts.push(event);
    } else if (event.event === "end") {
      attempt.ends.push(event);
    } else {
      attempt.errors.push(event);
    }
    attempts.set(id, attempt);
  }
  const scheduled = new Set(input.schedule.map((pair) => pair.pairId));
  const expectedOrder = input.schedule.flatMap((pair) =>
    pair.order.map((arm) => `${pair.pairId}/${arm}`)
  );
  const observedOrder = events
    .filter((event) => event.event === "start")
    .map((event) => `${string(event.pairId)}/${string(event.harness)}`);
  if (!equals(expectedOrder, observedOrder)) {
    issues.push("attempt_order_or_coverage_differs_from_frozen_schedule");
  }
  const pairs: Paired[] = input.schedule.map((definition) => {
    const arms = {} as Paired["arms"];
    for (const harness of ARMS) {
      const matching = [...attempts.values()].filter((attempt) =>
        [...attempt.starts, ...attempt.ends].some(
          (row) => row.pairId === definition.pairId && row.harness === harness
        )
      );
      const attempt = matching.length === 1 ? matching[0] : undefined;
      const end = attempt?.ends.length === 1 ? attempt.ends[0] : undefined;
      let valid = Boolean(
        matching.length === 1 &&
          attempt?.starts.length === 1 &&
          attempt.ends.length === 1
      );
      if (matching.length > 1) {
        issues.push(`duplicate_arm_attempts:${definition.pairId}:${harness}`);
      }
      if (
        attempt &&
        (attempt.starts.length !== 1 || attempt.ends.length !== 1)
      ) {
        issues.push(`invalid_attempt_lifecycle:${attempt.id}`);
      }
      if (!matching.length) {
        issues.push(`missing_arm:${definition.pairId}:${harness}`);
      }
      if (attempt) {
        if (
          attempt.starts.length === 1 &&
          attempt.ends.length === 1 &&
          events.indexOf(attempt.ends[0]!) < events.indexOf(attempt.starts[0]!)
        ) {
          issues.push(`end_precedes_start:${attempt.id}`);
          valid = false;
        }
        for (const row of [...attempt.starts, ...attempt.ends]) {
          const fields = [
            "pairId",
            "family",
            "repetition",
            ...(input.track === "memory"
              ? ["condition", "stratum", "recallIdentity", "seed", "taskId"]
              : ["variant"]),
          ];
          if (
            row.harness !== harness ||
            row.candidateSourceHash !== input.candidateSourceHash ||
            row.phase !== input.phase ||
            fields.some((key) => row[key] !== object(definition)[key])
          ) {
            issues.push(`attempt_identity_mismatch:${attempt.id}`);
            valid = false;
          }
        }
      }
      arms[harness] = { attempt, end, valid };
    }
    return { arms, definition };
  });
  for (const attempt of attempts.values()) {
    if (
      [...attempt.starts, ...attempt.ends].some(
        (row) =>
          !(
            scheduled.has(string(row.pairId)) &&
            ARMS.includes(row.harness as Harness)
          )
      )
    ) {
      issues.push(`unscheduled_attempt:${attempt.id}`);
    }
    if (!(attempt.starts.length || attempt.ends.length)) {
      issues.push(`orphan_error:${attempt.id}`);
    }
  }
  return { attempts: [...attempts.values()], events, issues, pairs };
}

function scheduleIssues(input: ProductAnalysisInput): string[] {
  const issues: string[] = [];
  if (
    !input.schedule.length ||
    new Set(input.schedule.map((pair) => pair.pairId)).size !==
      input.schedule.length
  ) {
    issues.push("empty_or_duplicate_schedule");
  }
  for (const pair of input.schedule) {
    if (
      !pair.pairId ||
      pair.order.length !== 2 ||
      new Set(pair.order).size !== 2 ||
      !pair.order.every((arm) => ARMS.includes(arm))
    ) {
      issues.push(`invalid_arm_order:${pair.pairId}`);
    }
  }
  if (input.phase === "pilot") {
    return issues;
  }
  const confirmation = input.phase === "confirmatory";
  const perFamily = confirmation ? 6 : 2;
  const repetitions = confirmation ? [0, 1] : [0];
  const expectedPairs =
    input.track === "memory"
      ? confirmation
        ? 144
        : 48
      : confirmation
        ? 54
        : 18;
  if (input.schedule.length !== expectedPairs) {
    issues.push("incomplete_preregistered_schedule");
  }
  const groups = groupDefinitions(input);
  for (const group of groups) {
    const expectedFamilies =
      input.track === "files"
        ? FILE_FAMILIES
        : group.stratum === "warm"
          ? MEMORY_FAMILIES
          : group.stratum === "cold"
            ? ["durable_fact", "implicit_preference"]
            : ["durable_fact"];
    const rows = input.schedule.filter(group.matches);
    if (
      rows.length !== expectedFamilies.length * perFamily ||
      expectedFamilies.some(
        (family) =>
          rows.filter((row) => row.family === family).length !== perFamily
      )
    ) {
      issues.push(`family_schedule_coverage:${group.id}`);
    }
    const instances = new Map<string, ProductPair[]>();
    for (const row of rows) {
      const key = instanceId(row);
      instances.set(key, [...(instances.get(key) ?? []), row]);
    }
    for (const [id, repeated] of instances) {
      if (!equals(repeated.map((row) => row.repetition).sort(), repetitions)) {
        issues.push(`repetition_coverage:${id}`);
      }
      if (
        confirmation &&
        (repeated[0]?.order[0] !== repeated[1]?.order[1] ||
          repeated[0]?.order[1] !== repeated[1]?.order[0])
      ) {
        issues.push(`repetition_order_not_reversed:${id}`);
      }
    }
  }
  const assigned = input.schedule.filter((pair) =>
    groups.some((group) => group.matches(pair))
  );
  if (assigned.length !== input.schedule.length) {
    issues.push("unexpected_condition_or_control");
  }
  return issues;
}

function instanceId(pair: ProductPair): string {
  return [
    pair.condition,
    pair.stratum,
    pair.recallIdentity,
    pair.family,
    pair.taskId ?? pair.variant ?? pair.seed,
  ].join("/");
}

function groupDefinitions(input: ProductAnalysisInput) {
  if (input.track === "files") {
    return [
      {
        diagnosticOnly: false,
        id: "files",
        matches: (_pair: ProductPair) => true,
        stratum: "files",
      },
    ];
  }
  return CONDITIONS.flatMap((condition) => [
    {
      diagnosticOnly: false,
      id: `${condition}/warm`,
      matches: (pair: ProductPair) =>
        pair.condition === condition &&
        pair.stratum === "warm" &&
        pair.recallIdentity === "same-owner",
      stratum: "warm",
    },
    {
      diagnosticOnly: true,
      id: `${condition}/cold`,
      matches: (pair: ProductPair) =>
        pair.condition === condition &&
        pair.stratum === "cold" &&
        pair.recallIdentity === "same-owner",
      stratum: "cold",
    },
    ...["different-user", "different-organization"].map((identity) => ({
      diagnosticOnly: true,
      id: `${condition}/identity/${identity}`,
      matches: (pair: ProductPair) =>
        pair.condition === condition &&
        pair.stratum === "identity" &&
        pair.recallIdentity === identity,
      stratum: "identity",
    })),
  ]);
}

function evaluateArm(
  input: ProductAnalysisInput,
  arm: Paired["arms"][Harness]
) {
  const end = arm.end ?? {};
  const evaluation = object(end.evaluation);
  const usage = certifyProductUsage(end, input.budget);
  const completed =
    arm.valid &&
    end.status === "completed" &&
    usage.known &&
    !usage.budgetExceeded &&
    (usage.providerRequests ?? 0) > 0;
  const fileOracle = object(evaluation.oracle);
  const primary =
    input.track === "memory"
      ? completed &&
        evaluation.boundaryValid === true &&
        evaluation.finalFactsCorrect === true &&
        evaluation.success === true
      : completed &&
        end.boundaryValid === true &&
        end.inputIdentical === true &&
        object(evaluation.binding).pass === true &&
        typeof object(evaluation.selection).path === "string" &&
        fileOracle.pass === true &&
        evaluation.success === true &&
        end.success === true;
  return {
    artifactOracle: input.track === "files" ? fileOracle.pass === true : null,
    completed,
    contract:
      input.track === "memory" ? evaluation.finalContract === true : null,
    factual:
      input.track === "memory" ? evaluation.finalFactsCorrect === true : null,
    falseCompletion: evaluation.falseCompletion === true,
    integrityFailure:
      end.criticalIntegrityFailure === true ||
      fileOracle.integrityFailure === true,
    primary,
    strict:
      input.track === "memory"
        ? primary &&
          evaluation.strictSuccess === true &&
          evaluation.finalContract === true
        : null,
    usage,
  };
}

function pairedMetric(
  pairs: Paired[],
  input: ProductAnalysisInput,
  metric: "primary" | "strict" = "primary"
) {
  const counts = {
    atlasOnly: 0,
    bothPass: 0,
    hermesOnly: 0,
    neitherSuccessful: 0,
  };
  for (const pair of pairs) {
    const a = evaluateArm(input, pair.arms.atlas)[metric] === true;
    const h = evaluateArm(input, pair.arms.hermes)[metric] === true;
    if (a && h) {
      counts.bothPass += 1;
    } else if (a) {
      counts.atlasOnly += 1;
    } else if (h) {
      counts.hermesOnly += 1;
    } else {
      counts.neitherSuccessful += 1;
    }
  }
  const n = pairs.length;
  return {
    atlasRate: n ? (counts.bothPass + counts.atlasOnly) / n : null,
    counts,
    delta: n ? (counts.atlasOnly - counts.hermesOnly) / n : null,
    hermesRate: n ? (counts.bothPass + counts.hermesOnly) / n : null,
    pairs: n,
    pairsWithMissingOrAmbiguousArm: pairs.filter(
      (pair) => !(pair.arms.atlas.valid && pair.arms.hermes.valid)
    ).length,
  };
}

function armDiagnostics(
  pairs: Paired[],
  input: ProductAnalysisInput,
  harness: Harness
) {
  const values = pairs.map((pair) => evaluateArm(input, pair.arms[harness]));
  const rate = (key: "factual" | "contract" | "artifactOracle" | "strict") =>
    values.every((value) => value[key] === null)
      ? null
      : {
          denominator: values.length,
          numerator: values.filter((value) => value[key] === true).length,
          rate: values.length
            ? values.filter((value) => value[key] === true).length /
              values.length
            : null,
        };
  return {
    accountingUncertain: values.filter((value) => !value.usage.known).length,
    ambiguousFinal: pairs.filter(
      (pair) =>
        object(pair.arms[harness].end?.evaluation).ambiguousFinal === true
    ).length,
    artifactOracle: rate("artifactOracle"),
    boundaryFailures: pairs.filter((pair) =>
      input.track === "memory"
        ? object(pair.arms[harness].end?.evaluation).boundaryValid !== true
        : pair.arms[harness].end?.boundaryValid !== true
    ).length,
    budgetExceeded: values.filter((value) => value.usage.budgetExceeded).length,
    deliveryFailures:
      input.track === "files"
        ? pairs.filter(
            (pair) =>
              !string(
                object(object(pair.arms[harness].end?.evaluation).selection)
                  .path
              )
          ).length
        : null,
    factual: rate("factual"),
    falseCompletion: values.filter((value) => value.falseCompletion).length,
    finalContract: rate("contract"),
    integrityFailures: values.filter((value) => value.integrityFailure).length,
    invocationErrors: pairs.filter((pair) =>
      Boolean(pair.arms[harness].end?.infrastructureError)
    ).length,
    missingFacts: pairs.filter(
      (pair) =>
        array(object(pair.arms[harness].end?.evaluation).missingFacts).length >
        0
    ).length,
    statusCounts: pairs.reduce<Record<string, number>>((counts, pair) => {
      const status = pair.arms[harness].valid
        ? string(pair.arms[harness].end?.status) || "unknown"
        : "missing_or_ambiguous";
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {}),
    strict: rate("strict"),
    transferAccuracy: pairs.filter(
      (pair) =>
        object(pair.arms[harness].end?.transferEvaluation).finalFactsCorrect ===
        true
    ).length,
    transferredFacts: pairs.flatMap((pair) =>
      array(pair.arms[harness].end?.transferredFacts).map((fact) => ({
        fact,
        pairId: pair.definition.pairId,
      }))
    ),
  };
}

function executionResources(
  attempts: Attempt[],
  input: ProductAnalysisInput,
  harness: Harness
) {
  const relevant = attempts.filter((attempt) =>
    [...attempt.starts, ...attempt.ends].some((row) => row.harness === harness)
  );
  const rows = relevant.map((attempt) =>
    attempt.ends.length === 1 ? attempt.ends[0]! : {}
  );
  const evidence = rows.map((row) => certifyProductUsage(row, input.budget));
  return {
    attempts: relevant.length,
    cachedTokens: distribution(evidence.map((item) => item.cachedTokens)),
    costUsd: distribution(
      rows.map((row) => measured(object(row.usage).costUsd))
    ),
    generatedTokens: distribution(evidence.map((item) => item.generatedTokens)),
    invocationLatencyMs: distribution(
      rows.map((row) => measured(row.elapsedMs))
    ),
    observedGeneratedTokenLowerBounds: distribution(
      evidence.map((item) => item.observedGeneratedTokens)
    ),
    observedPromptTokenLowerBounds: distribution(
      evidence.map((item) => item.observedPromptTokens)
    ),
    privateGradingLatencyMs: distribution(
      rows.map((row) => measured(object(row.evaluation).gradingMs))
    ),
    promptTokens: distribution(evidence.map((item) => item.promptTokens)),
    providerRequests: distribution(
      evidence.map((item) => item.providerRequests)
    ),
    providerStatusCounts: rows
      .flatMap((row) => array(row.providerStatuses))
      .reduce<Record<string, number>>((counts, code) => {
        const key = String(code);
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
    scope:
      "All identifiable started/ended attempts, including failures and extra attempts; never only successful tasks. Unknown totals are not zero.",
    totalAttemptLatencyMs: distribution(
      rows.map((row) => measured(row.totalAttemptElapsedMs))
    ),
  };
}

export function analyzeProductRecords(input: ProductAnalysisInput) {
  const index = indexLedger(input);
  const issues = [
    ...input.provenanceIssues,
    ...scheduleIssues(input),
    ...index.issues,
  ];
  const critical = index.pairs.some((pair) =>
    ARMS.some((arm) => evaluateArm(input, pair.arms[arm]).integrityFailure)
  );
  const exploratory =
    input.phase !== "confirmatory" || input.transportMode !== "live";
  const groups = groupDefinitions(input).map((group) => {
    const pairs = index.pairs.filter((pair) => group.matches(pair.definition));
    const families = [
      ...new Set(pairs.map((pair) => pair.definition.family)),
    ].sort();
    const familyResults = families.map((family) => {
      const familyPairs = pairs.filter(
        (pair) => pair.definition.family === family
      );
      const instances = new Map<string, Paired[]>();
      for (const pair of familyPairs) {
        const key = instanceId(pair.definition);
        instances.set(key, [...(instances.get(key) ?? []), pair]);
      }
      return {
        family,
        ...pairedMetric(familyPairs, input),
        effect: mean(
          [...instances.values()].map(
            (rows) => pairedMetric(rows, input).delta!
          )
        ),
        instanceCount: instances.size,
      };
    });
    const bootstrap = group.diagnosticOnly
      ? null
      : productFamilyBootstrap(
          familyResults.flatMap((family) =>
            family.effect === null ? [] : [family.effect]
          ),
          input.track === "memory" ? 20_260_906 : 20_260_917
        );
    const claimInterval =
      input.track === "memory"
        ? bootstrap?.simultaneous97_5
        : bootstrap?.descriptive95;
    const equalFamilyAtlasRate = mean(
      familyResults.flatMap((family) =>
        family.atlasRate === null ? [] : [family.atlasRate]
      )
    );
    const floorPass =
      equalFamilyAtlasRate !== null &&
      equalFamilyAtlasRate >= 0.9 &&
      familyResults.length > 0 &&
      familyResults.every(
        (family) => family.atlasRate !== null && family.atlasRate >= 0.8
      ) &&
      !critical;
    const complete = pairs.every(
      (pair) => pair.arms.atlas.valid && pair.arms.hermes.valid
    );
    const comparativeAccountingKnown =
      pairs.length > 0 &&
      pairs.every((pair) =>
        ARMS.every((arm) => {
          const resource = evaluateArm(input, pair.arms[arm]).usage;
          return resource.known && (resource.providerRequests ?? 0) > 0;
        })
      );
    const expectedFamilyCount = input.track === "memory" ? 8 : 9;
    const adequate =
      !(group.diagnosticOnly || bootstrap?.degenerate) &&
      bootstrap?.clusters === expectedFamilyCount;
    const canClaim =
      !(exploratory || group.diagnosticOnly) &&
      issues.length === 0 &&
      floorPass &&
      complete &&
      comparativeAccountingKnown &&
      adequate;
    return {
      bootstrap,
      completePaired: pairedMetric(
        pairs.filter((pair) => pair.arms.atlas.valid && pair.arms.hermes.valid),
        input
      ),
      decision: {
        aggregateFloor: 0.9,
        comparativeAccountingKnown,
        complete,
        criticalIntegrityFailure: critical,
        exploratory,
        familyFloor: 0.8,
        floorPass,
        informationAdequate: adequate,
        intervalConfidence: input.track === "memory" ? 0.975 : 0.95,
        multiplicity:
          input.track === "memory"
            ? "Bonferroni over the two predeclared warm conditions; use 97.5% intervals for every qualifying decision."
            : "One predeclared file track.",
        noninferiority:
          canClaim && claimInterval && claimInterval.lower > -0.05
            ? "qualifies_within_scope"
            : "inconclusive_or_does_not_qualify",
        observedTie:
          complete &&
          comparativeAccountingKnown &&
          pairs.length > 0 &&
          pairedMetric(pairs, input).delta === 0,
        statement: exploratory
          ? "Exploratory implementation/development evidence; no confirmatory claim."
          : group.diagnosticOnly
            ? "Diagnostic control; no memory-quality or security comparison claim."
            : bootstrap?.degenerate
              ? "Degenerate family distribution: descriptive result only, not proof of equivalence or noninferiority."
              : "Report all failures and per-family rates; qualifications apply only to the preregistered synthetic distribution.",
        superiority:
          canClaim && claimInterval && claimInterval.lower > 0
            ? "qualifies_within_scope"
            : "inconclusive_or_does_not_qualify",
      },
      diagnosticOnly: group.diagnosticOnly,
      diagnostics: {
        atlas: armDiagnostics(pairs, input, "atlas"),
        hermes: armDiagnostics(pairs, input, "hermes"),
      },
      equalFamilyAtlasRate,
      families: familyResults,
      id: group.id,
      intentionToRun: pairedMetric(pairs, input),
      resources: Object.fromEntries(
        ARMS.map((harness) => [
          harness,
          executionResources(
            index.attempts.filter((attempt) =>
              [...attempt.starts, ...attempt.ends].some((row) =>
                pairs.some((pair) => pair.definition.pairId === row.pairId)
              )
            ),
            input,
            harness
          ),
        ])
      ),
      scope:
        group.stratum === "identity"
          ? "Absence/transfer diagnostic only: Atlas shared-profile facts and Hermes installation isolation are not equivalent tenant security tests."
          : group.stratum === "cold"
            ? "Fresh-state absence control only; not warm recall accuracy."
            : "This synthetic fixture distribution and the frozen model/runtime/capability configuration only.",
      strictIntentionToRun:
        input.track === "memory" ? pairedMetric(pairs, input, "strict") : null,
      transportAdmittedPaired: pairedMetric(
        pairs.filter((pair) =>
          ARMS.every(
            (arm) =>
              pair.arms[arm].valid &&
              pair.arms[arm].end?.transportAdmitted === true &&
              (count(object(pair.arms[arm].end?.usage).providerRequests) ?? 0) >
                0
          )
        ),
        input
      ),
    };
  });
  return {
    candidateSourceHash: input.candidateSourceHash,
    coverage: {
      batchErrors: index.events.filter((event) => event.event === "batch-error")
        .length,
      duplicateLifecycleRecords: index.attempts.filter(
        (attempt) => attempt.starts.length > 1 || attempt.ends.length > 1
      ).length,
      endsWithoutStart: index.attempts.filter(
        (attempt) => attempt.starts.length === 0 && attempt.ends.length > 0
      ).length,
      identifiableAttempts: index.attempts.length,
      pairPreparationErrors: index.events.filter(
        (event) => event.event === "pair-preparation-error"
      ).length,
      rawEndRecords: index.events.filter((event) => event.event === "end")
        .length,
      rawErrorRecords: index.events.filter((event) => event.event === "error")
        .length,
      rawStartRecords: index.events.filter((event) => event.event === "start")
        .length,
      scheduledArms: input.schedule.length * 2,
      scheduledArmsMissingOrAmbiguous: index.pairs.reduce(
        (sum, pair) => sum + ARMS.filter((arm) => !pair.arms[arm].valid).length,
        0
      ),
      scheduledPairs: input.schedule.length,
      startsWithoutEnd: index.attempts.filter(
        (attempt) => attempt.starts.length > 0 && attempt.ends.length === 0
      ).length,
    },
    groups,
    limits: [
      "No universal harness, provider, subscription, visual-quality or before/after improvement claim.",
      "Memory formatting/factual metrics are separate. File final JSON/strict chat formatting is not required and is reported as not applicable.",
      "A missing arm is unsuccessful for intention-to-run and remains explicitly missing; it is not an observed successful tie.",
      "Provider prices are not guessed. Resource distributions include failures, missing observations and extra attempts.",
    ],
    phase: input.phase,
    resources: {
      atlas: executionResources(index.attempts, input, "atlas"),
      hermes: executionResources(index.attempts, input, "hermes"),
    },
    schemaVersion: 1,
    track: input.track,
    transportMode: input.transportMode,
    validity: { issues: [...new Set(issues)], valid: issues.length === 0 },
  };
}

async function boundedRead(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size > BYTE_LIMIT) {
    throw new Error(`Unbounded/nonregular analysis input: ${path}`);
  }
  return readFile(path);
}
async function json(path: string): Promise<unknown> {
  return JSON.parse((await boundedRead(path)).toString());
}
async function optionalJson(path: string): Promise<unknown | null> {
  try {
    return await json(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
function safeRelative(path: string): boolean {
  return (
    Boolean(path) &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}
async function evidenceJson(
  path: string,
  issues: string[],
  label: string
): Promise<unknown | null> {
  try {
    return await optionalJson(path);
  } catch {
    issues.push(`unreadable_evidence:${label}`);
    return null;
  }
}

/** Inspect archive members without extracting or running archived source. */
async function archiveInventory(path: string): Promise<Record<string, string>> {
  const script =
    "import hashlib,json,sys,tarfile\nr={}\ntotal=0\nwith tarfile.open(sys.argv[1], 'r:gz') as a:\n for m in a:\n  if m.isdir(): continue\n  if not m.isfile() or m.size>20000000 or m.name in r: raise ValueError('invalid archive member')\n  total+=m.size\n  if total>500000000: raise ValueError('archive expansion limit')\n  f=a.extractfile(m)\n  r[m.name]=hashlib.sha256(f.read()).hexdigest()\nprint(json.dumps(r,sort_keys=True))";
  const process_ = Bun.spawn(["/usr/bin/python3", "-I", "-c", script, path], {
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const timer = setTimeout(() => process_.kill(), 30_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
      process_.exited,
    ]);
    if (exit !== 0) {
      throw new Error(`Archive verification failed: ${stderr}`);
    }
    return JSON.parse(stdout) as Record<string, string>;
  } finally {
    clearTimeout(timer);
  }
}

function sortedRecord(value: unknown): Row {
  return Object.fromEntries(
    Object.entries(object(value)).sort(([a], [b]) => a.localeCompare(b))
  );
}

async function verifyArchives(
  directory: string,
  source: Row,
  archives: Row,
  track: ProductTrack,
  issues: string[]
) {
  for (const [name, key] of [
    ["atlas-source.tar.gz", "atlasHashes"],
    ["hermes-source.tar.gz", "hermesHashes"],
    [
      `${track === "memory" ? "memory" : "file"}-protocol-source.tar.gz`,
      "controlHashes",
    ],
  ]) {
    try {
      const path = join(directory, name!);
      if (
        !HASH.test(string(archives[name!])) ||
        digest(await boundedRead(path)) !== archives[name!]
      ) {
        throw new Error("archive byte hash mismatch");
      }
      const inventory = await archiveInventory(path);
      if (
        Object.keys(inventory).some((entry) => !safeRelative(entry)) ||
        !equals(sortedRecord(inventory), sortedRecord(source[key!]))
      ) {
        throw new Error("archive member inventory/content mismatch");
      }
    } catch (error) {
      issues.push(`${basename(directory)}:${name}:${String(error)}`);
    }
  }
}

/** Only an unfrozen, explicitly scripted pilot may use its captured adapter inputs. */
async function offlinePilotEndpoint(
  directory: string,
  ledger: unknown[],
  issues: string[]
): Promise<string> {
  const endpoints = new Set<string>();
  for (const raw of ledger) {
    const end = object(raw);
    const id = string(end.id);
    if (end.event !== "end" || !id || !safeRelative(id) || id.includes("/")) {
      continue;
    }
    const trace = `trials/${id}/runner-input.json`;
    const input = object(
      await evidenceJson(join(directory, trace), issues, trace)
    );
    const endpoint = string(
      object(object(input.modelMetadata).evidence).endpoint
    );
    try {
      const parsed = new URL(endpoint);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      ) {
        throw new Error("Invalid endpoint.");
      }
      endpoints.add(endpoint);
    } catch {
      issues.push(`offline_pilot_endpoint_missing_or_malformed:${trace}`);
    }
  }
  if (endpoints.size !== 1) {
    issues.push("offline_pilot_endpoint_not_shared_by_all_arms");
    return "";
  }
  return [...endpoints][0]!;
}

/** Read a frozen/batch evidence set only; never compare it to the mutable checkout. */
export async function analyzeProductBatch(
  batchDirectory: string,
  track: ProductTrack
) {
  const directory = await realpath(resolve(batchDirectory));
  if (basename(dirname(directory)) !== "batches") {
    throw new Error("Expected a study batches/<batch> directory.");
  }
  const root = dirname(dirname(directory));
  const metadata = object(
    await json(
      join(directory, track === "memory" ? "schedule.json" : "batch.json")
    )
  );
  const source =
    track === "memory"
      ? object(await json(join(directory, "candidate-source.json")))
      : metadata;
  const phase = string(metadata.phase);
  const schedule = array(metadata.schedule) as ProductPair[];
  const issues: string[] = [];
  const frozenDirectory = join(root, "frozen");
  const manifestPath = join(frozenDirectory, "manifest.json");
  const frozenRaw = await optionalJson(manifestPath);
  const frozen = object(frozenRaw);
  const manifestBytes =
    frozenRaw === null ? null : await boundedRead(manifestPath);
  const frozenRequired =
    metadata.transportMode !== "offline-scripted" || phase !== "pilot";
  if (!frozenRaw && frozenRequired) {
    issues.push("frozen_manifest_missing");
  }
  if (metadata.batch !== basename(directory)) {
    issues.push("batch_identity_mismatch");
  }
  if (
    string(source.candidateSourceHash) !==
    digest(JSON.stringify(source.atlasHashes))
  ) {
    issues.push("candidate_source_hash_mismatch");
  }
  if (!object(source.controlHashes)[ANALYSIS_PATH]) {
    issues.push("analysis_implementation_not_in_source_inventory");
  }
  const executedAnalysisSha256 = digest(await readFile(import.meta.path));
  if (object(source.controlHashes)[ANALYSIS_PATH] !== executedAnalysisSha256) {
    issues.push("executed_analysis_differs_from_archived_implementation");
  }
  const archives = object(
    await optionalJson(join(directory, "source-archives.json"))
  );
  await verifyArchives(directory, source, archives, track, issues);
  const completed = object(
    await optionalJson(join(directory, "completed.json"))
  );
  if (
    completed.sourceUnchanged !== true ||
    completed.pairedTasks !== schedule.length ||
    completed.scheduledAttempts !== schedule.length * 2 ||
    (completed.candidateSourceHash !== undefined &&
      completed.candidateSourceHash !== source.candidateSourceHash)
  ) {
    issues.push("batch_incomplete_or_source_guard_failed");
  }
  if (await optionalJson(join(directory, "interrupted.json"))) {
    issues.push("batch_interrupted");
  }
  if (frozenRaw) {
    if (digest(manifestBytes!) !== metadata.manifestSha256) {
      issues.push("frozen_manifest_hash_mismatch");
    }
    for (const key of ["controlHashes", "hermesHashes"]) {
      if (!equals(source[key], frozen[key])) {
        issues.push(`frozen_${key}_mismatch`);
      }
    }
    if (
      !equals(metadata.budget, frozen.budget) ||
      metadata.model !== frozen.model
    ) {
      issues.push("frozen_model_or_budget_mismatch");
    }
    await verifyArchives(
      frozenDirectory,
      frozen,
      object(frozen.archives),
      track,
      issues
    );
    if (phase !== "pilot") {
      const frozenSchedule = await json(
        join(frozenDirectory, `${phase}-schedule.json`)
      );
      const hashes = object(
        track === "memory" ? frozen.scheduleHashes : frozen.schedules
      );
      if (
        !equals(schedule, frozenSchedule) ||
        digest(JSON.stringify(frozenSchedule)) !== hashes[phase]
      ) {
        issues.push("frozen_schedule_mismatch");
      }
      if (track === "memory") {
        const tasks = await json(join(directory, "evaluator-tasks.json"));
        const frozenTasks = await json(
          join(frozenDirectory, `${phase}-tasks.json`)
        );
        if (
          !equals(tasks, frozenTasks) ||
          digest(JSON.stringify(tasks)) !== object(frozen.taskHashes)[phase]
        ) {
          issues.push("frozen_memory_tasks_mismatch");
        }
      }
    }
    if (
      track === "files" &&
      (!equals(metadata.runtimeFingerprint, frozen.runtimeFingerprint) ||
        metadata.expectedPolicyHash !== frozen.codeSandboxPolicySha256 ||
        metadata.candidateContractSha256 !== frozen.candidateContractSha256)
    ) {
      issues.push("prepared_runtime_or_code_policy_mismatch");
    }
  }
  if (frozenRequired) {
    const admissionName =
      phase === "confirmatory"
        ? "confirmatory"
        : `${track === "files" && phase === "pilot" ? "live-pilot" : phase}-${string(source.candidateSourceHash)}`;
    const admission = object(
      await optionalJson(join(root, "admissions", `${admissionName}.json`))
    );
    if (
      admission.batch !== metadata.batch ||
      admission.candidateSourceHash !== source.candidateSourceHash ||
      (admission.manifestSha256 !== undefined &&
        admission.manifestSha256 !== metadata.manifestSha256)
    ) {
      issues.push("frozen_admission_missing_or_mismatch");
    }
  }
  const lines = (await boundedRead(join(directory, "attempts.jsonl")))
    .toString()
    .split("\n")
    .filter((line) => line.trim());
  const ledger: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      ledger.push(JSON.parse(line));
    } catch {
      issues.push(`invalid_ledger_json_line:${index + 1}`);
    }
  }
  const expectedEndpoint =
    !frozenRequired && frozenRaw === null
      ? await offlinePilotEndpoint(directory, ledger, issues)
      : string(frozen.endpoint);
  for (const raw of ledger) {
    const end = object(raw);
    if (end.event !== "end") {
      continue;
    }
    const id = string(end.id);
    if (!(id && safeRelative(id)) || id.includes("/")) {
      issues.push("unsafe_attempt_id");
      continue;
    }
    const trial = join(directory, "trials", id);
    const result = await evidenceJson(
      join(trial, "result.json"),
      issues,
      `trials/${id}/result.json`
    );
    if (result && !equals(result, end)) {
      issues.push(`end_result_mismatch:${id}`);
    }
    const usage = await optionalJson(
      join(trial, "wire/native-usage-final.json")
    );
    if (end.usageEvidence && !(usage && equals(usage, end.usageEvidence))) {
      issues.push(`final_usage_evidence_mismatch:${id}`);
    }
    if (end.status === "completed" && !result) {
      issues.push(`completed_result_missing:${id}`);
    }
    let consumedGeneratedTokens = 0;
    for (const rawRequest of array(object(end.usageEvidence).requests)) {
      const request = object(rawRequest);
      if (request.kind !== "success") {
        continue;
      }
      const requestIndex = count(request.index);
      if (requestIndex === null || requestIndex === 0) {
        issues.push(`invalid_wire_request_index:${id}`);
        continue;
      }
      const prefix = String(requestIndex).padStart(3, "0");
      const trace = `trials/${id}/wire/${prefix}`;
      const requestBody = await evidenceJson(
        join(trial, `wire/${prefix}-request.json`),
        issues,
        `${trace}-request.json`
      );
      const responseBody = await evidenceJson(
        join(trial, `wire/${prefix}-response.json`),
        issues,
        `${trace}-response.json`
      );
      if (!(requestBody && responseBody)) {
        issues.push(`wire_evidence_missing:${trace}`);
        continue;
      }
      issues.push(
        ...validateProductWire(requestBody, responseBody, request, {
          endpoint: expectedEndpoint,
          maxOutputTokens: count(object(metadata.budget).maxOutputTokens) ?? 0,
          model: string(frozen.model) || string(metadata.model),
          remainingGeneratedTokens:
            (count(object(metadata.budget).maxGeneratedTokens) ?? 0) -
            consumedGeneratedTokens,
        }).map((issue) => `${issue}:${trace}`)
      );
      consumedGeneratedTokens += count(request.generatedTokens) ?? 0;
    }
  }
  const budget = object(metadata.budget);
  const analysis = analyzeProductRecords({
    budget: {
      maxGeneratedTokens: count(budget.maxGeneratedTokens) ?? 0,
      maxOutputTokens: count(budget.maxOutputTokens) ?? 0,
      maxProviderRequests: count(budget.maxProviderRequests) ?? 0,
      timeoutMs: count(budget.timeoutMs) ?? 0,
    },
    candidateSourceHash: string(source.candidateSourceHash),
    ledger,
    phase,
    provenanceIssues: issues,
    schedule,
    track,
    transportMode: string(metadata.transportMode),
  });
  return {
    ...analysis,
    evidence: {
      archivedAnalysisSha256:
        object(source.controlHashes)[ANALYSIS_PATH] ?? null,
      archiveVerification:
        "Archived member contents checked against recorded inventories without executing or extracting archived code; mutable app/package checkout not read.",
      batchDirectory: directory,
      candidateSourceHash: source.candidateSourceHash,
      executedAnalysisSha256,
      manifestSha256: manifestBytes ? digest(manifestBytes) : null,
    },
  };
}

if (import.meta.main) {
  const [track, batch, output] = process.argv.slice(2);
  if (!((track === "memory" || track === "files") && batch)) {
    throw new Error(
      "Usage: bun product-analysis.ts memory|files STUDY/batches/BATCH [NEW_REPORT.json]"
    );
  }
  const result = await analyzeProductBatch(batch, track);
  if (output) {
    const destination = resolve(output);
    if (relative(resolve(batch), destination).startsWith(`..${sep}`)) {
      throw new Error("Write the report inside its batch directory.");
    }
    await writeFile(destination, JSON.stringify(result, null, 2), {
      flag: "wx",
    });
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
