import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzePhase,
  type EndRecord,
  familyBootstrap,
  type StudySchedule,
  summarizeStudy,
  type TaskDescriptor,
} from "./analysis";
import { bootstrapSettings, sha256 } from "./provenance";
import { TASK_FAMILIES } from "./tasks";

const valid = { issues: [], valid: true };

function study(
  passes: (
    family: number,
    variant: number,
    harness: "atlas" | "hermes"
  ) => boolean
) {
  const tasks: TaskDescriptor[] = [];
  const schedule: StudySchedule = { phase: "holdout", schedule: [] };
  const records: EndRecord[] = [];
  for (const [familyIndex, family] of TASK_FAMILIES.entries()) {
    for (let variant = 0; variant < 5; variant++) {
      const taskId = `holdout:${family}:${variant}`;
      tasks.push({
        category: `category-${Math.floor(familyIndex / 2)}`,
        family,
        id: taskId,
      });
      for (let repetition = 0; repetition < 2; repetition++) {
        schedule.schedule.push({
          order: repetition ? ["hermes", "atlas"] : ["atlas", "hermes"],
          repetition,
          taskId,
        });
        for (const harness of ["atlas", "hermes"] as const) {
          const pass = passes(familyIndex, variant, harness);
          records.push({
            category: `category-${Math.floor(familyIndex / 2)}`,
            elapsedMs: pass ? 1000 : 3000,
            evaluation: {
              checks: [
                { detail: "", id: "final_contract", pass: true },
                { detail: "", id: "final_facts_correct", pass: true },
                { detail: "", id: "artifact:output.json", pass },
                { detail: "", id: "terminal_status", pass: true },
              ],
              falseCompletion: !pass,
              integrityFailure: false,
              pass,
              score: pass ? 1 : 0.75,
            },
            event: "end",
            family,
            harness,
            id: `${taskId}:${repetition}:${harness}`,
            repetition,
            status: "completed",
            taskId,
            usage: {
              cachedTokens: 0,
              generatedTokens: pass ? 10 : 20,
              promptTokens: 100,
              providerRequests: 1,
            },
          });
        }
      }
    }
  }
  return { records, schedule, tasks };
}

test("all passing ties remain descriptive and cannot prove noninferiority", () => {
  const input = study(() => true);
  const result = summarizeStudy(
    input.schedule,
    input.records,
    input.tasks,
    valid
  );
  expect(result.intentionToRun.counts).toEqual({
    atlasOnly: 0,
    bothFail: 0,
    bothPass: 120,
    hermesOnly: 0,
  });
  expect(result.familyBootstrap?.lower).toBe(0);
  expect(result.familyBootstrap?.upper).toBe(0);
  expect(result.familyBootstrap?.degenerate).toBe(true);
  expect(result.decision.classification).toBe("inconclusive");
  expect(result.decision.equivalenceClaim).toBe(false);
});

test("both-failing ties do not satisfy absolute quality floors", () => {
  const input = study(() => false);
  const result = summarizeStudy(
    input.schedule,
    input.records,
    input.tasks,
    valid
  );
  expect(result.intentionToRun.counts.bothFail).toBe(120);
  expect(result.intentionToRun.atlasSuccess).toBe(0);
  expect(result.decision.classification).toBe("inconclusive");
  expect(result.decision.reasons.some((reason) => reason.includes("90%"))).toBe(
    true
  );
  expect(result.perHarness.atlas?.resources.generatedTokens.total).toBe(2400);
  expect(result.perHarness.atlas?.resources.elapsedMs.mean).toBe(3000);
});

test("mixed family wins can satisfy the fixed superiority rule with complete evidence", () => {
  const input = study(
    (family, variant, harness) =>
      harness === "atlas" || family >= 6 || variant > 0
  );
  const result = summarizeStudy(
    input.schedule,
    input.records,
    input.tasks,
    valid
  );
  expect(result.intentionToRun.counts).toEqual({
    atlasOnly: 12,
    bothFail: 0,
    bothPass: 108,
    hermesOnly: 0,
  });
  expect(result.familyBootstrap?.clusters).toBe(12);
  expect(result.familyBootstrap?.pointEstimate).toBeCloseTo(0.1);
  expect(result.familyBootstrap!.lower).toBeGreaterThan(0);
  expect(result.decision.classification).toBe(
    "superior_on_declared_synthetic_suite"
  );
  expect(result.families).toHaveLength(12);
  expect(result.categories).toHaveLength(6);
});

test("missing execution counts as failure in ITT but never vanishes from denominators", () => {
  const input = study(() => true);
  input.records.splice(
    input.records.findIndex((record) => record.harness === "hermes"),
    1
  );
  const result = summarizeStudy(
    input.schedule,
    input.records,
    input.tasks,
    valid
  );
  expect(result.intentionToRun.pairs).toBe(120);
  expect(result.intentionToRun.counts).toEqual({
    atlasOnly: 1,
    bothFail: 0,
    bothPass: 119,
    hermesOnly: 0,
  });
  expect(result.admittedPairs.pairs).toBe(119);
  expect(result.missingExecutions).toHaveLength(1);
  expect(result.allEndedAttempts).toBe(239);
  expect(result.decision.classification).toBe("inconclusive");
});

test("explicit unavailable records remain separate and retain any consumed resources", () => {
  const input = study(() => true);
  const record = input.records.find((item) => item.harness === "hermes")!;
  record.unavailable = true;
  record.infrastructureError = "Externally verified outage.";
  record.evaluation = null;
  record.status = "failed";
  const result = summarizeStudy(
    input.schedule,
    input.records,
    input.tasks,
    valid
  );
  expect(result.unavailableExecutions).toHaveLength(1);
  expect(result.missingExecutions).toHaveLength(0);
  expect(result.admittedPairs.pairs).toBe(119);
  expect(result.perHarness.hermes?.resources.generatedTokens.total).toBe(1200);
  expect(result.perHarness.hermes?.unavailable).toBe(1);
  expect(result.decision.classification).toBe("inconclusive");
});

test("protocol failures do not become artifact failures or false-completion accusations", () => {
  const input = study(() => true);
  const record = input.records[0]!;
  record.evaluation!.pass = false;
  record.evaluation!.checks[0]!.pass = false;
  const result = summarizeStudy(
    input.schedule,
    input.records,
    input.tasks,
    valid
  );
  expect(result.perHarness.atlas?.protocolFailures).toBe(1);
  expect(result.perHarness.atlas?.artifactCorrect).toBe(120);
  expect(result.perHarness.atlas?.artifactFailures).toBe(0);
  expect(result.perHarness.atlas?.factualFailures).toBe(0);
  expect(result.perHarness.atlas?.falseCompletion).toBe(0);
  expect(result.intentionToRun.counts.hermesOnly).toBe(1);
});

test("duplicates are invalid and cannot select a better retry, while all costs remain counted", () => {
  const input = study(() => true);
  input.records.push(structuredClone(input.records[0]!));
  const result = summarizeStudy(
    input.schedule,
    input.records,
    input.tasks,
    valid
  );
  expect(result.validity.valid).toBe(false);
  expect(result.decision.classification).toBe("invalid");
  expect(result.intentionToRun.pairs).toBe(120);
  expect(result.allEndedAttempts).toBe(241);
  expect(result.perHarness.atlas?.resources.generatedTokens.total).toBe(1210);
});

test("source drift and nonconfirmatory phases cannot produce a confirmatory claim", () => {
  const input = study(
    (family, variant, harness) =>
      harness === "atlas" || family >= 6 || variant > 0
  );
  const changed = summarizeStudy(input.schedule, input.records, input.tasks, {
    issues: ["Candidate changed."],
    valid: false,
  });
  expect(changed.decision.classification).toBe("invalid");
  input.schedule.phase = "development";
  const exploratory = summarizeStudy(
    input.schedule,
    input.records,
    input.tasks,
    valid
  );
  expect(exploratory.decision.classification).toBe("exploratory_only");
});

test("bootstrap is deterministic and a constant positive effect also triggers the degeneracy guard", () => {
  const effects = Array.from({ length: 12 }, () => 0.2);
  const first = familyBootstrap(effects);
  const second = familyBootstrap(effects);
  expect(first).toEqual(second);
  expect(first?.degenerate).toBe(true);
  expect(first?.draws).toBe(100_000);
  expect(first?.seed).toBe(20_260_906);
});

test("a critical integrity failure blocks an otherwise eligible claim", () => {
  const input = study(
    (family, variant, harness) =>
      harness === "atlas" || family >= 6 || variant > 0
  );
  input.records[0]!.criticalIntegrityFailure = true;
  const result = summarizeStudy(
    input.schedule,
    input.records,
    input.tasks,
    valid
  );
  expect(result.decision.classification).toBe("inconclusive");
  expect(result.perHarness.atlas?.criticalIntegrityFailures).toBe(1);
});

async function archivedPhase(complete: boolean) {
  const root = await mkdtemp("/private/tmp/atlas-analysis-test-");
  const frozen = join(root, "frozen");
  const phase = join(root, "phase");
  await mkdir(frozen);
  await mkdir(phase);
  const input = study(() => true);
  const files = { "apps/server/captured.ts": "a".repeat(64) };
  const candidateSourceHash = sha256(JSON.stringify(files));
  const names = [
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
  ];
  const manifest = {
    bootstrapSettings,
    harnessHashes: Object.fromEntries(
      names.map((name) => [`scripts/harness-compare/${name}`, "b".repeat(64)])
    ),
    hermesHashes: { "run_agent.py": "c".repeat(64) },
    protocolSha256: sha256("frozen protocol"),
    repetitions: { holdout: 2 },
    sourceHashes: files,
    taskHashes: { holdout: sha256(JSON.stringify(input.tasks)) },
  };
  const manifestBytes = JSON.stringify(manifest);
  const schedule = {
    ...input.schedule,
    candidateSourceHash,
    manifestPath: join(frozen, "manifest.json"),
    manifestSha256: sha256(manifestBytes),
  };
  await writeFile(join(frozen, "manifest.json"), manifestBytes);
  await writeFile(join(frozen, "protocol.md"), "frozen protocol");
  await writeFile(join(frozen, "holdout.json"), JSON.stringify(input.tasks));
  await writeFile(join(phase, "schedule.json"), JSON.stringify(schedule));
  await writeFile(
    join(phase, "candidate-source.json"),
    JSON.stringify({ candidateSourceHash, files })
  );
  await writeFile(
    join(phase, "attempts.jsonl"),
    input.records
      .map((record) => JSON.stringify({ ...record, candidateSourceHash }))
      .join("\n")
  );
  if (complete) {
    await writeFile(
      join(phase, "completed.json"),
      JSON.stringify({
        candidateSourceHash,
        pairedTasks: 120,
        sourceUnchanged: true,
      })
    );
  }
  return { frozen, phase, root };
}

test("immutable CLI analysis validates archived manifests without requiring today's source to match", async () => {
  const fixture = await archivedPhase(true);
  try {
    const report = await analyzePhase(fixture.phase);
    expect(report.validity.valid).toBe(true);
    expect(report.intentionToRun.pairs).toBe(120);
    expect(report.decision.classification).toBe("inconclusive");
    await writeFile(join(fixture.frozen, "protocol.md"), "changed protocol");
    const changed = await analyzePhase(fixture.phase);
    expect(changed.validity.valid).toBe(false);
    expect(changed.decision.classification).toBe("invalid");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("an incomplete captured phase stays invalid while preserving every scheduled family and pair", async () => {
  const fixture = await archivedPhase(false);
  try {
    await writeFile(join(fixture.phase, "attempts.jsonl"), "");
    const report = await analyzePhase(fixture.phase);
    expect(report.validity.valid).toBe(false);
    expect(report.intentionToRun.counts.bothFail).toBe(120);
    expect(report.missingExecutions).toHaveLength(240);
    expect(report.families.filter((family) => family.pairs > 0)).toHaveLength(
      12
    );
    expect(report.categories).toHaveLength(6);
    expect(report.decision.classification).toBe("invalid");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});
