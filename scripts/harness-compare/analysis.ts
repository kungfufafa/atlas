import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { bootstrapSettings, sha256 } from "./provenance";
import { TASK_FAMILIES } from "./tasks";
import type { OracleCheck, TaskEvaluation } from "./types";

type Harness = "atlas" | "hermes";
const HARNESSES: Harness[] = ["atlas", "hermes"];

export interface ScheduleEntry {
  order: Harness[];
  repetition: number;
  taskId: string;
}

export interface StudySchedule {
  candidateSourceHash?: string;
  manifestPath?: string | null;
  manifestSha256?: string | null;
  phase: string;
  schedule: ScheduleEntry[];
  session?: string;
}

export interface TaskDescriptor {
  category: string;
  family: string;
  id: string;
}

export interface EndRecord {
  candidateSourceHash?: string;
  category?: string;
  criticalIntegrityFailure?: boolean;
  elapsedMs?: number | null;
  evaluation?: TaskEvaluation | null;
  event: string;
  family?: string;
  harness: Harness;
  id: string;
  infrastructureError?: string | null;
  repetition: number;
  status?: string;
  taskId: string;
  unavailable?: boolean;
  usage?: {
    budgetExceeded?: boolean;
    cachedTokens?: number;
    generatedTokens?: number;
    missingUsage?: boolean;
    observedCostUsd?: number;
    promptTokens?: number;
    providerRequests?: number;
  } | null;
}

interface PairedTrial {
  atlas?: EndRecord;
  category: string;
  family: string;
  hermes?: EndRecord;
  repetition: number;
  taskId: string;
}

interface Validity {
  issues: string[];
  valid: boolean;
}

function mean(values: number[]): number | null {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function quantile(sorted: number[], probability: number): number | null {
  if (!sorted.length) {
    return null;
  }
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return (
    sorted[lower]! * (1 - fraction) + sorted[Math.ceil(position)]! * fraction
  );
}

function distribution(values: Array<number | null | undefined>) {
  const measured = values
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
    )
    .sort((left, right) => left - right);
  return {
    mean: mean(measured),
    measuredCount: measured.length,
    median: quantile(measured, 0.5),
    missingCount: values.length - measured.length,
    p95: quantile(measured, 0.95),
    total: measured.length
      ? measured.reduce((sum, value) => sum + value, 0)
      : null,
  };
}

function admitted(record: EndRecord | undefined): record is EndRecord {
  return Boolean(record && record.unavailable !== true);
}

function success(record: EndRecord | undefined): boolean {
  return admitted(record) && record.evaluation?.pass === true;
}

function pairedCounts(pairs: PairedTrial[]) {
  const counts = { atlasOnly: 0, bothFail: 0, bothPass: 0, hermesOnly: 0 };
  for (const pair of pairs) {
    const atlas = success(pair.atlas);
    const hermes = success(pair.hermes);
    if (atlas && hermes) {
      counts.bothPass++;
    } else if (atlas) {
      counts.atlasOnly++;
    } else if (hermes) {
      counts.hermesOnly++;
    } else {
      counts.bothFail++;
    }
  }
  const denominator = pairs.length;
  return {
    atlasSuccess: denominator
      ? (counts.bothPass + counts.atlasOnly) / denominator
      : null,
    counts,
    difference: denominator
      ? (counts.atlasOnly - counts.hermesOnly) / denominator
      : null,
    hermesSuccess: denominator
      ? (counts.bothPass + counts.hermesOnly) / denominator
      : null,
    pairs: denominator,
  };
}

function familyDifference(pairs: PairedTrial[]): number | null {
  const byInstance = new Map<string, number[]>();
  for (const pair of pairs) {
    const values = byInstance.get(pair.taskId) ?? [];
    values.push(Number(success(pair.atlas)) - Number(success(pair.hermes)));
    byInstance.set(pair.taskId, values);
  }
  return mean([...byInstance.values()].map((values) => mean(values)!));
}

/** Resample entire family effects; repeats and seeds never become independent clusters. */
export function familyBootstrap(effects: number[]) {
  if (!effects.length) {
    return null;
  }
  let state: number = bootstrapSettings.seed;
  const samples: number[] = [];
  for (let draw = 0; draw < bootstrapSettings.draws; draw++) {
    let total = 0;
    let drawsRemaining = effects.length;
    while (drawsRemaining-- > 0) {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      total += effects[Math.floor((state / 4_294_967_296) * effects.length)]!;
    }
    samples.push(total / effects.length);
  }
  samples.sort((left, right) => left - right);
  const lower = quantile(samples, 0.025)!;
  const upper = quantile(samples, 0.975)!;
  return {
    ...bootstrapSettings,
    clusters: effects.length,
    degenerate: upper - lower <= 1e-12,
    lower,
    method:
      "Percentile paired bootstrap of equal-weight family effects; repeats averaged within seeded instance.",
    pointEstimate: mean(effects),
    upper,
  };
}

function checkFailure(checks: OracleCheck[], prefix: string): boolean {
  return checks.some((check) => check.id.startsWith(prefix) && !check.pass);
}

function diagnostics(records: EndRecord[]) {
  let artifactCorrect = 0;
  let artifactFailures = 0;
  let factualFailures = 0;
  let protocolFailures = 0;
  let evidenceFailures = 0;
  for (const record of records) {
    const checks = record.evaluation?.checks ?? [];
    const artifacts = checks.filter((check) =>
      check.id.startsWith("artifact:")
    );
    if (artifacts.length && artifacts.every((check) => check.pass)) {
      artifactCorrect++;
    }
    if (artifacts.some((check) => !check.pass)) {
      artifactFailures++;
    }
    if (checkFailure(checks, "final_facts_correct")) {
      factualFailures++;
    }
    if (checkFailure(checks, "final_contract")) {
      protocolFailures++;
    }
    if (
      checks.some(
        (check) =>
          /^(?:read_evidence:|write_evidence:|document_evidence:|recovery_)/.test(
            check.id
          ) && !check.pass
      )
    ) {
      evidenceFailures++;
    }
  }
  return {
    artifactCorrect,
    artifactFailures,
    criticalIntegrityFailures: records.filter(
      (record) => record.criticalIntegrityFailure
    ).length,
    endedAttempts: records.length,
    evaluatedAttempts: records.filter((record) => record.evaluation != null)
      .length,
    evidenceFailures,
    factualFailures,
    falseCompletion: records.filter(
      (record) => record.evaluation?.falseCompletion
    ).length,
    integrityFailures: records.filter(
      (record) => record.evaluation?.integrityFailure
    ).length,
    missingUsage: records.filter(
      (record) => record.usage?.missingUsage || !record.usage
    ).length,
    protocolFailures,
    resources: {
      cachedTokens: distribution(
        records.map((record) => record.usage?.cachedTokens)
      ),
      elapsedMs: distribution(records.map((record) => record.elapsedMs)),
      generatedTokens: distribution(
        records.map((record) => record.usage?.generatedTokens)
      ),
      observedCostUsd: distribution(
        records.map((record) => record.usage?.observedCostUsd)
      ),
      promptTokens: distribution(
        records.map((record) => record.usage?.promptTokens)
      ),
      providerRequests: distribution(
        records.map((record) => record.usage?.providerRequests)
      ),
      scope:
        "All ended attempts including failures, unavailable executions and duplicates; no successful-run-only filtering.",
    },
    unavailable: records.filter((record) => record.unavailable).length,
  };
}

function buildPairs(
  schedule: StudySchedule,
  records: EndRecord[],
  tasks: TaskDescriptor[],
  issues: string[]
): PairedTrial[] {
  const descriptors = new Map(tasks.map((task) => [task.id, task]));
  const ended = new Map<string, EndRecord>();
  for (const record of records) {
    const key = JSON.stringify([
      record.taskId,
      record.repetition,
      record.harness,
    ]);
    if (ended.has(key)) {
      issues.push(
        `Duplicate end record for ${key}; no best-result selection is allowed.`
      );
    } else {
      ended.set(key, record);
    }
  }
  const scheduled = new Set<string>();
  const pairs: PairedTrial[] = [];
  for (const item of schedule.schedule) {
    const key = JSON.stringify([item.taskId, item.repetition]);
    if (scheduled.has(key)) {
      issues.push(`Duplicate scheduled pair ${key}.`);
    }
    scheduled.add(key);
    if (
      item.order.length !== 2 ||
      new Set(item.order).size !== 2 ||
      item.order.some((arm) => !HARNESSES.includes(arm))
    ) {
      issues.push(`Invalid harness order for ${key}.`);
    }
    const descriptor = descriptors.get(item.taskId);
    if (!descriptor) {
      issues.push(`No frozen task descriptor for ${item.taskId}.`);
    }
    const pair: PairedTrial = {
      category: descriptor?.category ?? "unknown",
      family: descriptor?.family ?? "unknown",
      repetition: item.repetition,
      taskId: item.taskId,
    };
    for (const harness of HARNESSES) {
      pair[harness] = ended.get(
        JSON.stringify([item.taskId, item.repetition, harness])
      );
    }
    pairs.push(pair);
  }
  for (const record of records) {
    if (!scheduled.has(JSON.stringify([record.taskId, record.repetition]))) {
      issues.push(`Unscheduled end record ${record.id}.`);
    }
    if (
      record.evaluation?.pass &&
      (record.status !== "completed" ||
        !record.evaluation.checks.length ||
        record.evaluation.checks.some((check) => !check.pass) ||
        record.usage?.budgetExceeded ||
        record.usage?.missingUsage)
    ) {
      issues.push(`Inconsistent passing outcome ${record.id}.`);
    }
  }
  return pairs;
}

/** Summarize captured scores only; never regenerate scores or choose a favorable retry. */
export function summarizeStudy(
  schedule: StudySchedule,
  ledger: EndRecord[],
  tasks: TaskDescriptor[],
  validity: Validity
) {
  const issues = [...validity.issues];
  const records = ledger.filter((record) => record.event === "end");
  const pairs = buildPairs(schedule, records, tasks, issues);
  const observed = pairs.filter(
    (pair) => admitted(pair.atlas) && admitted(pair.hermes)
  );
  const missing = pairs.flatMap((pair) =>
    HARNESSES.filter((harness) => !pair[harness]).map((harness) => ({
      harness,
      repetition: pair.repetition,
      taskId: pair.taskId,
    }))
  );
  const unavailable = pairs.flatMap((pair) =>
    HARNESSES.filter((harness) => pair[harness]?.unavailable).map(
      (harness) => ({
        harness,
        reason:
          pair[harness]?.infrastructureError ??
          "Explicit unavailable execution.",
        repetition: pair.repetition,
        taskId: pair.taskId,
      })
    )
  );
  const names = [
    ...new Set([...TASK_FAMILIES, ...pairs.map((pair) => pair.family)]),
  ].sort();
  const families = names.map((family) => {
    const selected = pairs.filter((pair) => pair.family === family);
    return {
      family,
      ...pairedCounts(selected),
      admittedPairs: pairedCounts(
        selected.filter((pair) => admitted(pair.atlas) && admitted(pair.hermes))
      ),
      equalWeightDifference: familyDifference(selected),
      instances: new Set(selected.map((pair) => pair.taskId)).size,
    };
  });
  const categories = [...new Set(pairs.map((pair) => pair.category))]
    .sort()
    .map((category) => ({
      category,
      ...pairedCounts(pairs.filter((pair) => pair.category === category)),
    }));
  const effects = families
    .filter((family) => family.pairs > 0)
    .map((family) => family.equalWeightDifference!);
  const interval = familyBootstrap(effects);
  const perHarness = Object.fromEntries(
    HARNESSES.map((harness) => [
      harness,
      diagnostics(records.filter((record) => record.harness === harness)),
    ])
  );
  const intentionToRun = pairedCounts(pairs);
  const reasons: string[] = [];
  if (!validity.valid || issues.length) {
    reasons.push(
      "Manifest, source, schedule or ledger validity checks failed."
    );
  }
  if (schedule.phase !== "holdout") {
    reasons.push(
      "Pilot and development results are unscored or exploratory, not confirmatory."
    );
  }
  if (missing.length || unavailable.length) {
    reasons.push(
      "Some scheduled executions are missing or unavailable; intention-to-run still counts them as failures."
    );
  }
  if (
    families.filter((family) => family.pairs > 0).length !== 12 ||
    TASK_FAMILIES.some(
      (name) =>
        !families.some((family) => family.family === name && family.pairs > 0)
    )
  ) {
    reasons.push("All twelve preregistered task families are required.");
  }
  if (!interval || interval.degenerate) {
    reasons.push(
      "The family-bootstrap distribution is degenerate or unavailable; an observed tie does not establish equivalence or noninferiority."
    );
  }
  if ((intentionToRun.atlasSuccess ?? 0) < 0.9) {
    reasons.push("Atlas aggregate strict success is below 90%.");
  }
  if (
    families.some(
      (family) => family.pairs === 0 || (family.atlasSuccess ?? 0) < 0.8
    )
  ) {
    reasons.push("Atlas strict success is below 80% in at least one family.");
  }
  if (
    records.some(
      (record) => record.harness === "atlas" && record.criticalIntegrityFailure
    )
  ) {
    reasons.push("Atlas has a critical integrity failure.");
  }
  const regressedFamilies = families
    .filter((family) => (family.equalWeightDifference ?? 0) < -0.1 - 1e-12)
    .map((family) => family.family);
  if (regressedFamilies.length) {
    reasons.push(
      "At least one family regresses by more than ten percentage points."
    );
  }
  if (records.some((record) => !record.usage || record.usage.missingUsage)) {
    reasons.push(
      "Usage was unmeasured for at least one ended execution; shared-budget validity is unresolved."
    );
  }
  let decision = "inconclusive";
  if (!validity.valid || issues.length) {
    decision = "invalid";
  } else if (schedule.phase !== "holdout") {
    decision = "exploratory_only";
  } else if (!reasons.length && interval) {
    if (interval.lower > 0) {
      decision = "superior_on_declared_synthetic_suite";
    } else if (interval.lower > -0.05) {
      decision = "noninferior_on_declared_synthetic_suite";
    } else {
      reasons.push(
        "The 95% lower endpoint does not exceed the -5 percentage point noninferiority margin."
      );
    }
  }
  return {
    admittedPairs: pairedCounts(observed),
    allEndedAttempts: records.length,
    candidateSourceHash: schedule.candidateSourceHash ?? null,
    categories,
    decision: {
      classification: decision,
      equivalenceClaim: false,
      reasons,
      regressedFamilies,
    },
    families,
    familyBootstrap: interval,
    intentionToRun,
    limitations: [
      "Results concern the frozen synthetic task distribution, exact model/provider, harness revisions and resource limits only.",
      "Twelve task families are the uncertainty clusters; repeated variants are not independent task concepts.",
      "Diagnostic artifact/factual/protocol outcomes do not relax strict task success.",
      "Unknown costs remain unknown; token counts are not monetary cost or subscription-quota evidence.",
    ],
    missingExecutions: missing,
    perHarness,
    phase: schedule.phase,
    session: schedule.session ?? null,
    unavailableExecutions: unavailable,
    validity: { issues, valid: validity.valid && issues.length === 0 },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function hashes(value: unknown): Record<string, string> {
  const result = object(value);
  if (
    !Object.keys(result).length ||
    Object.values(result).some(
      (entry) => typeof entry !== "string" || !/^[a-f0-9]{64}$/.test(entry)
    )
  ) {
    throw new Error("Missing or malformed frozen source hashes.");
  }
  return result as Record<string, string>;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(path, "utf8")));
}

async function verifyPhase(phaseDir: string, schedule: StudySchedule) {
  const issues: string[] = [];
  let tasks: TaskDescriptor[] = [];
  try {
    if (!(schedule.manifestPath && schedule.manifestSha256)) {
      throw new Error("No immutable frozen manifest reference in schedule.");
    }
    const bytes = await readFile(schedule.manifestPath);
    if (sha256(bytes) !== schedule.manifestSha256) {
      throw new Error("Frozen manifest checksum mismatch.");
    }
    const manifest = object(JSON.parse(bytes.toString("utf8")));
    const harnessHashes = hashes(manifest.harnessHashes);
    for (const name of [
      "analysis.ts",
      "analysis.test.ts",
      "run.ts",
      "proxy.ts",
      "oracles.ts",
      "tasks.ts",
      "tools.ts",
      "atlas-runner.ts",
      "hermes_runner.py",
      "provenance.ts",
      "types.ts",
    ]) {
      if (!harnessHashes[`scripts/harness-compare/${name}`]) {
        throw new Error(`Frozen harness manifest omits ${name}.`);
      }
    }
    // Historical analyses validate captured manifests and the runner's final
    // attestation; authorized later source edits do not invalidate old trials.
    hashes(manifest.hermesHashes);
    hashes(manifest.sourceHashes);
    const protocol = await readFile(
      join(dirname(schedule.manifestPath), "protocol.md")
    );
    if (sha256(protocol) !== manifest.protocolSha256) {
      throw new Error("Frozen protocol checksum mismatch.");
    }
    if (
      JSON.stringify(manifest.bootstrapSettings) !==
      JSON.stringify(bootstrapSettings)
    ) {
      throw new Error(
        "Bootstrap settings differ from the frozen analysis settings."
      );
    }
    const candidate = await readJson(join(phaseDir, "candidate-source.json"));
    if (
      sha256(JSON.stringify(hashes(candidate.files))) !==
        schedule.candidateSourceHash ||
      candidate.candidateSourceHash !== schedule.candidateSourceHash
    ) {
      throw new Error("Candidate source manifest checksum mismatch.");
    }
    const taskBytes = await readFile(
      join(dirname(schedule.manifestPath), `${schedule.phase}.json`),
      "utf8"
    );
    const parsed = JSON.parse(taskBytes) as TaskDescriptor[];
    if (
      sha256(JSON.stringify(parsed)) !==
      object(manifest.taskHashes)[schedule.phase]
    ) {
      throw new Error("Frozen task checksum mismatch.");
    }
    tasks = parsed;
    const completed = await readJson(join(phaseDir, "completed.json"));
    if (
      completed.sourceUnchanged !== true ||
      completed.candidateSourceHash !== schedule.candidateSourceHash ||
      completed.pairedTasks !== schedule.schedule.length
    ) {
      throw new Error("No complete unchanged-source phase attestation.");
    }
    const repetitions = object(manifest.repetitions)[schedule.phase];
    if (
      typeof repetitions !== "number" ||
      schedule.schedule.length !== tasks.length * repetitions
    ) {
      throw new Error("Schedule does not cover the complete declared phase.");
    }
    for (const task of tasks) {
      for (let repetition = 0; repetition < repetitions; repetition++) {
        if (
          schedule.schedule.filter(
            (entry) =>
              entry.taskId === task.id && entry.repetition === repetition
          ).length !== 1
        ) {
          throw new Error(
            `Missing or duplicate frozen task/repetition: ${task.id}/${repetition}.`
          );
        }
      }
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return { issues, tasks, valid: issues.length === 0 };
}

/** Immutable read-only CLI; callers may redirect stdout to a new report artifact. */
export async function analyzePhase(phaseDir: string) {
  const scheduleBytes = await readFile(join(phaseDir, "schedule.json"), "utf8");
  const schedule = JSON.parse(scheduleBytes) as StudySchedule;
  let ledgerBytes = "";
  const ledgerIssues: string[] = [];
  try {
    ledgerBytes = await readFile(join(phaseDir, "attempts.jsonl"), "utf8");
  } catch {
    ledgerIssues.push(
      "Attempt ledger is missing; all scheduled executions are missing."
    );
  }
  const ledger: EndRecord[] = [];
  for (const [index, line] of ledgerBytes.split("\n").entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = object(JSON.parse(line));
      if (record.event !== "end") {
        continue;
      }
      if (
        !HARNESSES.includes(record.harness as Harness) ||
        typeof record.taskId !== "string" ||
        !Number.isInteger(record.repetition) ||
        typeof record.id !== "string"
      ) {
        throw new Error("Malformed end record.");
      }
      if (record.candidateSourceHash !== schedule.candidateSourceHash) {
        ledgerIssues.push(
          `Candidate source differs in end record ${record.id}.`
        );
      }
      ledger.push(record as unknown as EndRecord);
    } catch {
      ledgerIssues.push(
        `Malformed ledger line ${index + 1}; retained as a validity failure.`
      );
    }
  }
  const validation = await verifyPhase(phaseDir, schedule);
  validation.issues.push(...ledgerIssues);
  validation.valid = validation.issues.length === 0;
  // Missing phase completion must not erase scheduled-family diagnostics.
  if (!validation.tasks.length) {
    validation.tasks = [
      ...new Map(
        schedule.schedule.map((entry) => [
          entry.taskId,
          {
            category:
              ledger.find((record) => record.taskId === entry.taskId)
                ?.category ?? "unknown",
            family:
              ledger.find((record) => record.taskId === entry.taskId)?.family ??
              entry.taskId.split(":")[1] ??
              "unknown",
            id: entry.taskId,
          },
        ])
      ).values(),
    ];
  }
  return {
    evidence: {
      frozenManifestSha256: schedule.manifestSha256 ?? null,
      ledgerSha256: sha256(ledgerBytes),
      phaseDir: resolve(phaseDir),
      scheduleSha256: sha256(scheduleBytes),
    },
    ...summarizeStudy(schedule, ledger, validation.tasks, validation),
  };
}

if (import.meta.main) {
  const phaseDir = process.argv[2];
  if (!phaseDir) {
    throw new Error(
      "Usage: bun scripts/harness-compare/analysis.ts <phase-directory>"
    );
  }
  const report = await analyzePhase(phaseDir);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.validity.valid) {
    process.exitCode = 2;
  }
}
