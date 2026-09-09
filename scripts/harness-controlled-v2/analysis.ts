import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type EndRecord,
  type StudySchedule,
  summarizeStudy,
  type TaskDescriptor,
} from "../harness-compare/analysis";
import {
  bootstrapSettings,
  sha256,
  shuffleSeed,
} from "../harness-compare/provenance";
import {
  comparisonLimits,
  comparisonModel,
  upstreamEndpoint,
} from "../harness-compare/proxy";
import type { HarnessTask, TaskEvaluation } from "../harness-compare/types";
import { type CertifiedUsage, object, readUsage } from "./accounting";
import {
  archiveMembers,
  buildSchedule,
  controlHashes,
  equalHashEntries,
  type FrozenManifest,
  type Phase,
} from "./provenance";
import { CONTROLLED_V2_VERSION } from "./tasks";

export interface V2EndRecord extends Omit<EndRecord, "usage"> {
  originalEvaluation?: TaskEvaluation;
  phase?: string;
  rawEvaluation?: TaskEvaluation;
  rawTerminalStatus?: string;
  timedOut?: boolean;
  transportAdmitted?: boolean;
  usage?: CertifiedUsage | null;
}

function asOriginal(record: V2EndRecord): EndRecord {
  return {
    ...record,
    usage: record.usage
      ? {
          budgetExceeded: record.usage.budgetExceeded,
          cachedTokens: record.usage.cachedTokens ?? undefined,
          generatedTokens: record.usage.generatedTokens ?? undefined,
          missingUsage: record.usage.accountingUncertain,
          promptTokens: record.usage.promptTokens ?? undefined,
          providerRequests: record.usage.providerRequests,
        }
      : null,
  };
}

/** Captured strict scores remain immutable; diagnostics never rescue a failed attempt. */
export function summarizeV2(
  schedule: StudySchedule,
  ledger: V2EndRecord[],
  tasks: TaskDescriptor[],
  validity: { issues: string[]; valid: boolean }
) {
  const issues = [...validity.issues];
  const ended = ledger.filter((record) => record.event === "end");
  for (const record of ended) {
    if (
      record.evaluation?.pass &&
      (!record.usage?.withinBudgetCertified ||
        record.evaluation.checks.find(
          (check) => check.id === "final_contract_envelope"
        )?.pass !== true)
    ) {
      issues.push(
        `Passing V2 result lacks certified usage or a passing envelope: ${record.id}`
      );
    }
  }
  const originalSchedule = {
    ...schedule,
    phase: schedule.phase === "confirmatory" ? "holdout" : schedule.phase,
  };
  const summary = summarizeStudy(
    originalSchedule,
    ended.map(asOriginal),
    tasks,
    { issues, valid: validity.valid && issues.length === 0 }
  );
  const byKey = new Map<string, V2EndRecord | undefined>();
  for (const record of ended) {
    const key = JSON.stringify([
      record.taskId,
      record.repetition,
      record.harness,
    ]);
    byKey.set(key, byKey.has(key) ? undefined : record);
  }
  const subset = (predicate: (record: V2EndRecord) => boolean) => {
    const counts = { atlasOnly: 0, bothFail: 0, bothPass: 0, hermesOnly: 0 };
    let pairs = 0;
    for (const pair of schedule.schedule) {
      const atlas = byKey.get(
        JSON.stringify([pair.taskId, pair.repetition, "atlas"])
      );
      const hermes = byKey.get(
        JSON.stringify([pair.taskId, pair.repetition, "hermes"])
      );
      if (!(atlas && hermes && predicate(atlas) && predicate(hermes))) {
        continue;
      }
      pairs++;
      if (atlas.evaluation?.pass && hermes.evaluation?.pass) {
        counts.bothPass++;
      } else if (atlas.evaluation?.pass) {
        counts.atlasOnly++;
      } else if (hermes.evaluation?.pass) {
        counts.hermesOnly++;
      } else {
        counts.bothFail++;
      }
    }
    return { counts, pairs };
  };
  const perHarness = Object.fromEntries(
    Object.entries(summary.perHarness).map(([harness, diagnostics]) => [
      harness,
      {
        ...diagnostics,
        resources: {
          ...diagnostics.resources,
          ...Object.fromEntries(
            Object.entries(diagnostics.resources)
              .filter(([, value]) => typeof value === "object")
              .map(([key, value]) => {
                const measured = value as {
                  total: number | null;
                  measuredCount: number;
                  missingCount: number;
                };
                const values = schedule.schedule.map((pair) => {
                  const record = byKey.get(
                    JSON.stringify([pair.taskId, pair.repetition, harness])
                  );
                  return key === "elapsedMs"
                    ? record?.elapsedMs
                    : object(record?.usage)[key];
                });
                const knownValues = values.filter(
                  (value): value is number =>
                    typeof value === "number" &&
                    Number.isFinite(value) &&
                    value >= 0
                );
                return [
                  key,
                  {
                    ...measured,
                    missingCount: values.length - knownValues.length,
                    observedSum: measured.total,
                    total:
                      knownValues.length === values.length && values.length > 0
                        ? knownValues.reduce((sum, value) => sum + value, 0)
                        : null,
                  },
                ];
              })
          ),
          scope:
            "All scheduled attempts including failures. Totals are null if any value is missing; observedSum is only the measured partial sum.",
        },
      },
    ])
  );
  return {
    ...summary,
    accounting: Object.fromEntries(
      (["atlas", "hermes"] as const).map((harness) => {
        const records = ended.filter((record) => record.harness === harness);
        return [
          harness,
          {
            cacheUnknownAttempts: records.filter(
              (record) => record.usage?.cachedTokens == null
            ).length,
            certifiedAttempts: records.filter(
              (record) => record.usage && !record.usage.accountingUncertain
            ).length,
            claimedCompletionContradicted: records.filter(
              (record) => record.rawEvaluation?.falseCompletion
            ).length,
            finalEnvelopeFailures: records.filter(
              (record) =>
                record.evaluation?.checks.find(
                  (check) => check.id === "final_contract_envelope"
                )?.pass === false
            ).length,
            knownPartialGeneratedTokens: records.reduce(
              (total, record) =>
                total + (record.usage?.observedGeneratedTokens ?? 0),
              0
            ),
            knownPartialPromptTokens: records.reduce(
              (total, record) =>
                total + (record.usage?.observedPromptTokens ?? 0),
              0
            ),
            originalFinalContractPass: records.filter(
              (record) =>
                record.rawEvaluation?.checks.find(
                  (check) => check.id === "final_contract"
                )?.pass
            ).length,
            provenBudgetExceeded: records.filter(
              (record) => record.usage?.budgetExceeded
            ).length,
            uncertifiableAttempts: records.filter(
              (record) => !record.usage || record.usage.accountingUncertain
            ).length,
          },
        ];
      })
    ),
    certifiedUsagePairs: subset(
      (record) => record.usage?.mandatoryUsageKnown === true
    ),
    limitations: [
      ...summary.limitations,
      "V2 is a separately frozen contract clarification and envelope tightening. V1 and native-product results are retained separately and never pooled.",
      "Non-2xx, transport errors or missing mandatory usage make the entire attempt uncertifiable and failed, even if later requests recover. Known partial token sums are lower bounds, not complete totals.",
      "Cached usage omission remains unknown and does not invalidate otherwise certified mandatory usage. No monetary cost or subscription quota is inferred.",
      "The original falseCompletion diagnostic includes exact artifact-schema defects; it is not a claim of deception. Envelope-only defects are reported separately.",
      "Only the last final answer and final artifact state are scored; intermediate turns and exactly-once transitions are not measured.",
    ],
    perHarness,
    phase: schedule.phase,
    transportAdmittedPairs: subset(
      (record) => record.transportAdmitted === true
    ),
    version: CONTROLLED_V2_VERSION,
  };
}

function hashMap(value: unknown): Record<string, string> {
  const map = object(value);
  if (
    !Object.keys(map).length ||
    Object.values(map).some(
      (entry) => typeof entry !== "string" || !/^[a-f0-9]{64}$/.test(entry)
    )
  ) {
    throw new Error("Missing or malformed provenance hashes.");
  }
  return map as Record<string, string>;
}

async function json(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(path, "utf8")));
}

async function verifyArchives(
  directory: string,
  sources: {
    atlasHashes: Record<string, string>;
    controlHashes: Record<string, string>;
    hermesHashes: Record<string, string>;
  },
  expected?: Record<string, string>
) {
  const archives = hashMap(await json(join(directory, "archives.json")));
  for (const name of [
    "atlas-source.tar.gz",
    "control-source.tar.gz",
    "hermes-source.tar.gz",
  ]) {
    if (
      !archives[name] ||
      (expected && archives[name] !== expected[name]) ||
      sha256(await readFile(join(directory, name))) !== archives[name]
    ) {
      throw new Error(`Missing or changed source archive: ${name}`);
    }
    const expectedMembers =
      name === "atlas-source.tar.gz"
        ? sources.atlasHashes
        : name === "control-source.tar.gz"
          ? sources.controlHashes
          : sources.hermesHashes;
    if (
      !equalHashEntries(
        await archiveMembers(join(directory, name)),
        expectedMembers
      )
    ) {
      throw new Error(
        `Archive members do not match captured source identity: ${name}`
      );
    }
  }
}

/** Read-only historical analysis: verify captured sources, never compare the current mutable candidate. */
export async function analyzePhase(directoryInput: string) {
  const directory = resolve(directoryInput);
  const schedule = (await json(
    join(directory, "schedule.json")
  )) as unknown as StudySchedule & {
    transportMode?: string;
    bootstrapSettings?: unknown;
    shuffleSeed?: number;
  };
  const issues: string[] = [];
  let tasks: HarnessTask[] = [];
  const records: V2EndRecord[] = [];
  try {
    tasks = JSON.parse(
      await readFile(join(directory, "evaluator-tasks.json"), "utf8")
    );
  } catch {
    issues.push("Captured task descriptors are missing or malformed.");
  }
  try {
    const raw = await readFile(join(directory, "attempts.jsonl"), "utf8");
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        issues.push(
          `Malformed ledger line ${index + 1}; partial evidence retained.`
        );
      }
    }
  } catch {
    issues.push(
      "Attempt ledger missing; all scheduled attempts remain failures."
    );
  }
  try {
    if (!(schedule.manifestPath && schedule.manifestSha256)) {
      throw new Error(
        "No frozen manifest reference (offline pilot is unscored and cannot support inference)."
      );
    }
    const bytes = await readFile(schedule.manifestPath);
    if (sha256(bytes) !== schedule.manifestSha256) {
      throw new Error("Frozen manifest checksum mismatch.");
    }
    const manifest = JSON.parse(bytes.toString()) as FrozenManifest & {
      runtimeSha256: string;
    };
    const frozenDir = dirname(schedule.manifestPath);
    const controls = hashMap(manifest.controlHashes);
    for (const path of [
      "scripts/harness-controlled-v2/accounting.ts",
      "scripts/harness-controlled-v2/analysis.ts",
      "scripts/harness-controlled-v2/oracles.ts",
      "scripts/harness-controlled-v2/run.ts",
      "scripts/harness-controlled-v2/tasks.ts",
      "scripts/harness-controlled-v2/provenance.ts",
      "scripts/harness-controlled-v2/protocol.md",
      "scripts/harness-compare/atlas-runner.ts",
      "scripts/harness-compare/hermes_runner.py",
      "scripts/harness-compare/proxy.ts",
      "scripts/harness-compare/tools.ts",
      "scripts/harness-compare/oracles.ts",
      "scripts/harness-compare/analysis.ts",
      "scripts/harness-compare/tasks.ts",
      "scripts/harness-compare/types.ts",
      "scripts/harness-compare/provenance.ts",
    ]) {
      if (!controls[path]) {
        throw new Error(`Frozen controls omit ${path}.`);
      }
    }
    hashMap(manifest.atlasHashes);
    hashMap(manifest.hermesHashes);
    if (!equalHashEntries(await controlHashes(), controls)) {
      throw new Error(
        "Executing analyzer or its frozen control dependencies differ from this study; use the archived analyzer version."
      );
    }
    if (
      manifest.version !== CONTROLLED_V2_VERSION ||
      manifest.model !== comparisonModel ||
      manifest.endpoint !== upstreamEndpoint ||
      JSON.stringify(manifest.limits) !== JSON.stringify(comparisonLimits) ||
      JSON.stringify(manifest.bootstrapSettings) !==
        JSON.stringify(bootstrapSettings) ||
      JSON.stringify(schedule.bootstrapSettings) !==
        JSON.stringify(bootstrapSettings) ||
      schedule.shuffleSeed !== shuffleSeed ||
      schedule.transportMode !== "live"
    ) {
      throw new Error(
        "Wrong study version/model/budget/statistical settings/transport."
      );
    }
    if (
      sha256(await readFile(join(frozenDir, "protocol.md"))) !==
        manifest.protocolSha256 ||
      sha256(await readFile(join(frozenDir, "runtime.json"))) !==
        manifest.runtimeSha256
    ) {
      throw new Error("Frozen protocol/runtime evidence changed.");
    }
    const phase = schedule.phase as Phase;
    if (!["pilot", "development", "confirmatory"].includes(phase)) {
      throw new Error("Unknown V2 phase.");
    }
    const frozenTasks = JSON.parse(
      await readFile(join(frozenDir, `${phase}-tasks.json`), "utf8")
    );
    const frozenSchedule = JSON.parse(
      await readFile(join(frozenDir, `${phase}-schedule.json`), "utf8")
    );
    if (
      sha256(JSON.stringify(frozenTasks)) !== manifest.taskHashes[phase] ||
      JSON.stringify(tasks) !== JSON.stringify(frozenTasks) ||
      sha256(JSON.stringify(frozenSchedule)) !==
        manifest.scheduleHashes[phase] ||
      JSON.stringify(schedule.schedule) !== JSON.stringify(frozenSchedule) ||
      JSON.stringify(buildSchedule(tasks, phase)) !==
        JSON.stringify(schedule.schedule)
    ) {
      throw new Error(
        "Captured tasks or complete adjacent-pair schedule differ from freeze."
      );
    }
    await verifyArchives(frozenDir, manifest, manifest.archives);
    const candidate = await json(join(directory, "candidate-source.json"));
    if (
      candidate.candidateSourceHash !== schedule.candidateSourceHash ||
      sha256(JSON.stringify(hashMap(candidate.atlasHashes))) !==
        schedule.candidateSourceHash ||
      JSON.stringify(candidate.controlHashes) !==
        JSON.stringify(manifest.controlHashes) ||
      JSON.stringify(candidate.hermesHashes) !==
        JSON.stringify(manifest.hermesHashes)
    ) {
      throw new Error("Captured candidate/control/Hermes identities mismatch.");
    }
    await verifyArchives(directory, {
      atlasHashes: hashMap(candidate.atlasHashes),
      controlHashes: hashMap(candidate.controlHashes),
      hermesHashes: hashMap(candidate.hermesHashes),
    });
    const completed = await json(join(directory, "completed.json"));
    if (
      completed.sourceUnchanged !== true ||
      completed.candidateSourceHash !== schedule.candidateSourceHash ||
      completed.pairedTasks !== schedule.schedule.length
    ) {
      throw new Error("No complete unchanged-source attestation.");
    }
    const admissionId =
      phase === "confirmatory"
        ? "confirmatory"
        : `${phase}-${schedule.candidateSourceHash}`;
    const admission = await json(
      join(frozenDir, "../admissions", `${admissionId}.json`)
    );
    if (
      admission.batch !== schedule.session ||
      admission.manifestSha256 !== schedule.manifestSha256 ||
      admission.candidateSourceHash !== schedule.candidateSourceHash
    ) {
      throw new Error("Missing or mismatched unique phase admission.");
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const starts = new Map<string, number>();
  const startRecords = new Map<string, V2EndRecord>();
  const plannedOrder = schedule.schedule.flatMap((pair) =>
    pair.order.map((harness) =>
      JSON.stringify([pair.taskId, pair.repetition, harness])
    )
  );
  const observedOrder = records
    .filter((record) => record.event === "start")
    .map((record) =>
      JSON.stringify([record.taskId, record.repetition, record.harness])
    );
  if (JSON.stringify(plannedOrder) !== JSON.stringify(observedOrder)) {
    issues.push(
      "Actual starts do not match the full frozen adjacent-pair schedule."
    );
  }
  for (const record of records) {
    if (record.event === "start") {
      starts.set(record.id, (starts.get(record.id) ?? 0) + 1);
      startRecords.set(record.id, record);
    }
    if (record.event !== "end") {
      continue;
    }
    if (
      starts.get(record.id) !== 1 ||
      record.candidateSourceHash !== schedule.candidateSourceHash
    ) {
      issues.push(
        `Missing/duplicate preceding start or candidate mismatch: ${record.id}`
      );
    }
    const start = startRecords.get(record.id);
    const identity = (value: V2EndRecord | undefined) =>
      JSON.stringify([
        value?.taskId,
        value?.repetition,
        value?.harness,
        value?.phase,
        value?.candidateSourceHash,
      ]);
    if (
      !start ||
      identity(start) !== identity(record) ||
      record.phase !== schedule.phase
    ) {
      issues.push(
        `End attribution does not match its preceding start: ${record.id}`
      );
    }
    if (!record.usage) {
      continue;
    }
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(record.id)) {
        throw new Error("Unsafe attempt ID.");
      }
      const captured = await readUsage(
        join(directory, "trials", record.id, "wire"),
        record.usage.providerRequests,
        record.elapsedMs ?? null,
        record.timedOut === true
      );
      if (JSON.stringify(captured) !== JSON.stringify(record.usage)) {
        throw new Error("Recorded usage differs from retained wire evidence.");
      }
      const persisted = await json(
        join(directory, "trials", record.id, "result.json")
      );
      if (JSON.stringify(persisted) !== JSON.stringify(record)) {
        throw new Error("End ledger differs from persisted result.");
      }
    } catch (error) {
      issues.push(
        `${record.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  for (const [id, count] of starts) {
    if (count !== 1) {
      issues.push(`Duplicate start record: ${id}`);
    }
  }
  return summarizeV2(schedule, records, tasks, {
    issues,
    valid: issues.length === 0,
  });
}

if (import.meta.main) {
  if (process.argv.length !== 3) {
    throw new Error(
      "Usage: bun scripts/harness-controlled-v2/analysis.ts PHASE_DIRECTORY"
    );
  }
  process.stdout.write(
    `${JSON.stringify(await analyzePhase(process.argv[2]!), null, 2)}\n`
  );
}
