import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  analyzeProductBatch,
  analyzeProductRecords,
  certifyProductUsage,
  type ProductAnalysisInput,
  type ProductPair,
  type ProductTrack,
  productFamilyBootstrap,
  validateProductWire,
} from "./product-analysis";

type Row = Record<string, unknown>;
const MEMORY = [
  "durable_fact",
  "implicit_preference",
  "corrected_fact",
  "distractor_recall",
  "unsupported_fact",
  "forgotten_preference",
  "cross_language",
  "episodic_decision",
];
const FILES = [
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
const BUDGET = {
  maxGeneratedTokens: 12_000,
  maxOutputTokens: 4096,
  maxProviderRequests: 24,
  timeoutMs: 300_000,
};
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const asRow = (value: unknown) => value as Row;

function usage() {
  return {
    elapsedMs: 100,
    usage: {
      budgetExceeded: false,
      cachedTokens: null,
      costUsd: null,
      generatedTokens: 10,
      observedGeneratedTokens: 10,
      observedPromptTokens: 30,
      promptTokens: 30,
      providerRequests: 1,
    },
    usageEvidence: {
      cachedTokens: null,
      finalized: true,
      generatedTokens: 10,
      inFlightRequests: 0,
      mandatoryUsageKnown: true,
      observationError: false,
      observedGeneratedTokens: 10,
      observedPromptTokens: 30,
      promptTokens: 30,
      requests: [
        {
          cachedTokens: null,
          generatedTokens: 10,
          index: 1,
          kind: "success",
          promptTokens: 30,
          status: 200,
        },
      ],
    },
  };
}

function wire() {
  return {
    expected: {
      endpoint: "https://synthetic.invalid/v1",
      maxOutputTokens: 4096,
      model: "synthetic",
      remainingGeneratedTokens: 12_000,
    },
    request: {
      effective: {
        max_tokens: 4096,
        model: "synthetic",
        stream: false,
        temperature: 0.2,
      },
      model: "synthetic",
      request: { model: "synthetic" },
      upstreamEndpoint: "https://synthetic.invalid/v1",
    },
    response: {
      response: {
        model: "synthetic",
        usage: { completion_tokens: 10, prompt_tokens: 30 },
      },
      status: 200,
    },
  };
}

function fixture(track: ProductTrack): ProductAnalysisInput {
  const schedule: ProductPair[] = [];
  const families = track === "memory" ? MEMORY : FILES;
  for (const condition of track === "memory"
    ? ["native-default", "explicit-memory"]
    : [undefined]) {
    const blocks =
      track === "memory"
        ? [
            { families, recallIdentity: "same-owner", stratum: "warm" },
            {
              families: MEMORY.slice(0, 2),
              recallIdentity: "same-owner",
              stratum: "cold",
            },
            {
              families: MEMORY.slice(0, 1),
              recallIdentity: "different-user",
              stratum: "identity",
            },
            {
              families: MEMORY.slice(0, 1),
              recallIdentity: "different-organization",
              stratum: "identity",
            },
          ]
        : [{ families, recallIdentity: undefined, stratum: undefined }];
    for (const block of blocks) {
      for (const family of block.families) {
        for (let variant = 0; variant < 3; variant += 1) {
          for (const repetition of [0, 1]) {
            const id = [
              condition,
              block.stratum,
              block.recallIdentity,
              family,
              variant,
            ]
              .filter((value) => value !== undefined)
              .join("-");
            schedule.push({
              condition,
              family,
              order:
                repetition === 0 ? ["atlas", "hermes"] : ["hermes", "atlas"],
              pairId: `${id}-r${repetition}`,
              recallIdentity: block.recallIdentity,
              repetition,
              seed: variant + 101,
              stratum: block.stratum,
              taskId:
                track === "memory"
                  ? `${condition}-${family}-${variant}`
                  : undefined,
              variant,
            } as ProductPair);
          }
        }
      }
    }
  }
  const ledger: Row[] = [];
  for (const pair of schedule) {
    for (const harness of pair.order) {
      const start = {
        ...pair,
        at: "2026-09-06T12:00:00.000Z",
        candidateSourceHash: "candidate",
        event: "start",
        harness,
        id: `${pair.pairId}-${harness}`,
        phase: "confirmatory",
      };
      const evaluation =
        track === "memory"
          ? {
              boundaryValid: true,
              falseCompletion: false,
              finalContract: true,
              finalFactsCorrect: true,
              missingFacts: [],
              strictSuccess: true,
              success: true,
              wrongFacts: [],
            }
          : {
              binding: { pass: true },
              gradingMs: 3,
              oracle: { checks: [], integrityFailure: false, pass: true },
              selection: { path: "artifacts/result.csv" },
              success: true,
            };
      ledger.push(start, {
        ...start,
        event: "end",
        status: "completed",
        ...usage(),
        boundaryValid: true,
        evaluation,
        exitCode: 0,
        inputIdentical: true,
        providerStatuses: [200],
        success: true,
        totalAttemptElapsedMs: 110,
        transportAdmitted: true,
      });
    }
  }
  return {
    budget: BUDGET,
    candidateSourceHash: "candidate",
    ledger,
    phase: "confirmatory",
    provenanceIssues: [],
    schedule,
    track,
    transportMode: "live",
  };
}

function ends(input: ProductAnalysisInput): Row[] {
  return input.ledger.map(asRow).filter((row) => row.event === "end");
}
function fail(record: Row) {
  const evaluation = asRow(record.evaluation);
  evaluation.success = false;
  evaluation.finalFactsCorrect = false;
  evaluation.finalContract = false;
  evaluation.strictSuccess = false;
  record.success = false;
  if (evaluation.oracle) {
    asRow(evaluation.oracle).pass = false;
  }
}

test("wire audit rejects wrong models, altered settings and usage without disclosing bodies", () => {
  const fixture_ = wire();
  const requestUsage = usage().usageEvidence.requests[0]!;
  expect(
    validateProductWire(
      fixture_.request,
      fixture_.response,
      requestUsage,
      fixture_.expected
    )
  ).toEqual([]);
  const changedModel = structuredClone(fixture_);
  changedModel.response.response.model = "unregistered-alias";
  expect(
    validateProductWire(
      changedModel.request,
      changedModel.response,
      requestUsage,
      changedModel.expected
    )
  ).toContain("returned_model_mismatch");
  const altered = structuredClone(fixture_);
  altered.request.effective.model = "other-model";
  altered.request.effective.temperature = 0.9;
  const failures = validateProductWire(
    altered.request,
    altered.response,
    requestUsage,
    altered.expected
  );
  expect(failures).toContain("effective_model_mismatch");
  expect(failures).toContain("effective_settings_mismatch");
  const shortened = structuredClone(fixture_);
  shortened.request.effective.max_tokens = 1;
  expect(
    validateProductWire(
      shortened.request,
      shortened.response,
      requestUsage,
      shortened.expected
    )
  ).toContain("effective_settings_mismatch");
  shortened.request.effective.max_tokens = 2000;
  shortened.expected.remainingGeneratedTokens = 2000;
  expect(
    validateProductWire(
      shortened.request,
      shortened.response,
      requestUsage,
      shortened.expected
    )
  ).toEqual([]);
  asRow(shortened.request.effective).reasoning = { effort: "high" };
  expect(
    validateProductWire(
      shortened.request,
      shortened.response,
      requestUsage,
      shortened.expected
    )
  ).toContain("undeclared_reasoning_control:reasoning");
  const noUsage = structuredClone(fixture_);
  noUsage.response.response.usage.completion_tokens = 0;
  expect(
    validateProductWire(
      noUsage.request,
      noUsage.response,
      requestUsage,
      noUsage.expected
    )
  ).toContain("response_usage_mismatch");
});

test("all-passing complete file ties remain inconclusive and unknown cache does not fail", () => {
  const report = analyzeProductRecords(fixture("files"));
  expect(report.validity.valid).toBe(true);
  expect(report.coverage.scheduledPairs).toBe(54);
  expect(report.coverage.rawEndRecords).toBe(108);
  expect(report.groups[0]?.intentionToRun.counts.bothPass).toBe(54);
  expect(report.groups[0]?.decision.floorPass).toBe(true);
  expect(report.groups[0]?.bootstrap?.degenerate).toBe(true);
  expect(report.groups[0]?.decision.noninferiority).toBe(
    "inconclusive_or_does_not_qualify"
  );
  expect(report.groups[0]?.decision.observedTie).toBe(true);
  expect(report.resources.atlas.cachedTokens.missingCount).toBe(54);
  expect(report.resources.atlas.generatedTokens.total).toBe(540);
  expect(report.groups[0]?.strictIntentionToRun).toBeNull();
});

test("missing and duplicate arms stay in intention-to-run, invalidate claims and never pick the passing attempt", () => {
  const input = fixture("files");
  const removed = String(asRow(input.ledger[0]).id);
  input.ledger = input.ledger.filter((raw) => asRow(raw).id !== removed);
  const duplicate = structuredClone(
    ends(input).find((row) => row.harness === "atlas")!
  );
  input.ledger.push(
    { ...duplicate, event: "start", id: `${duplicate.id}-retry` },
    { ...duplicate, id: `${duplicate.id}-retry` }
  );
  const report = analyzeProductRecords(input);
  expect(report.validity.valid).toBe(false);
  expect(report.coverage.scheduledArmsMissingOrAmbiguous).toBe(2);
  expect(report.groups[0]?.intentionToRun.pairs).toBe(54);
  expect(report.groups[0]?.intentionToRun.counts.hermesOnly).toBe(2);
  expect(report.groups[0]?.completePaired.pairs).toBe(52);
  expect(report.resources.atlas.attempts).toBe(54);
  expect(report.groups[0]?.decision.noninferiority).toBe(
    "inconclusive_or_does_not_qualify"
  );
});

test("start-only, duplicate end and orphan end retain lifecycle counts and uncertain observations", () => {
  const input = fixture("files");
  const original = ends(input);
  input.ledger = input.ledger.filter(
    (raw) =>
      !(
        (asRow(raw).event === "end" && asRow(raw).id === original[0]?.id) ||
        (asRow(raw).event === "start" && asRow(raw).id === original[1]?.id)
      )
  );
  input.ledger.push(structuredClone(original[2]!));
  const report = analyzeProductRecords(input);
  expect(report.coverage.startsWithoutEnd).toBe(1);
  expect(report.coverage.endsWithoutStart).toBe(1);
  expect(report.coverage.duplicateLifecycleRecords).toBe(1);
  expect(report.validity.valid).toBe(false);
  expect(report.groups[0]?.intentionToRun.pairs).toBe(54);
});

test("entirely missing observations do not receive an observed tie label", () => {
  const input = fixture("files");
  input.ledger = [];
  const report = analyzeProductRecords(input);
  expect(report.groups[0]?.intentionToRun.counts.neitherSuccessful).toBe(54);
  expect(report.groups[0]?.decision.observedTie).toBe(false);
  expect(report.coverage.scheduledArmsMissingOrAmbiguous).toBe(108);
});

test("usage errors invalidate certification even if final output is right, while cache-only omissions do not", () => {
  const correct = { ...usage(), status: "completed" };
  expect(certifyProductUsage(correct, BUDGET).known).toBe(true);
  expect(certifyProductUsage(correct, BUDGET).cachedTokens).toBeNull();
  const responseError = structuredClone(correct);
  responseError.usageEvidence.requests[0]!.status = 502;
  responseError.usageEvidence.requests[0]!.kind = "http-error";
  expect(certifyProductUsage(responseError, BUDGET).known).toBe(false);
  expect(certifyProductUsage(responseError, BUDGET).budgetExceeded).toBe(false);
  const uncertain = structuredClone(correct);
  uncertain.usageEvidence.finalized = false;
  expect(certifyProductUsage(uncertain, BUDGET).known).toBe(false);
  expect(certifyProductUsage({}, BUDGET).budgetExceeded).toBe(false);
  const measuredOverrun = structuredClone(correct);
  measuredOverrun.elapsedMs = BUDGET.timeoutMs + 1;
  const overrunEvidence = certifyProductUsage(measuredOverrun, BUDGET);
  expect(overrunEvidence.known).toBe(true);
  expect(overrunEvidence.budgetExceeded).toBe(true);
  expect(overrunEvidence.generatedTokens).toBe(10);
  const input = fixture("files");
  Object.assign(ends(input)[0]!, responseError);
  const report = analyzeProductRecords(input);
  expect(report.groups[0]?.intentionToRun.counts.hermesOnly).toBe(1);
  expect(report.resources.atlas.generatedTokens.total).toBeNull();
  expect(report.resources.atlas.generatedTokens.observedTotal).toBe(530);
});

test("memory conditions and diagnostic controls never pool or conceal condition losses", () => {
  const input = fixture("memory");
  for (const row of ends(input)) {
    if (
      row.condition === "native-default" &&
      row.stratum === "warm" &&
      row.harness === "atlas"
    ) {
      fail(row);
    }
  }
  const report = analyzeProductRecords(input);
  expect(report.validity.valid).toBe(true);
  expect(report.coverage.scheduledPairs).toBe(144);
  const defaultWarm = report.groups.find(
    (group) => group.id === "native-default/warm"
  )!;
  const explicitWarm = report.groups.find(
    (group) => group.id === "explicit-memory/warm"
  )!;
  expect(defaultWarm.intentionToRun.atlasRate).toBe(0);
  expect(explicitWarm.intentionToRun.atlasRate).toBe(1);
  expect(defaultWarm.intentionToRun.pairs).toBe(48);
  expect(report.groups.filter((group) => group.diagnosticOnly)).toHaveLength(6);
  expect(
    report.groups
      .filter((group) => group.diagnosticOnly)
      .every(
        (group) =>
          group.bootstrap === null &&
          group.decision.noninferiority === "inconclusive_or_does_not_qualify"
      )
  ).toBe(true);
  expect(explicitWarm.decision.intervalConfidence).toBe(0.975);
});

test("a benign extra field lowers strict memory score without changing factual primary score", () => {
  const input = fixture("memory");
  const row = ends(input).find(
    (record) => record.harness === "atlas" && record.stratum === "warm"
  )!;
  asRow(row.evaluation).finalContract = false;
  asRow(row.evaluation).strictSuccess = false;
  const report = analyzeProductRecords(input);
  const group = report.groups.find(
    (entry) => entry.id === `${row.condition}/warm`
  )!;
  expect(group.intentionToRun.atlasRate).toBe(1);
  expect(group.strictIntentionToRun?.atlasRate).toBe(47 / 48);
  expect(group.diagnostics.atlas.falseCompletion).toBe(0);
});

test("family and integrity floors veto an attractive aggregate; exploratory runs never claim", () => {
  const input = fixture("files");
  for (const [index, family] of FILES.entries()) {
    for (const row of ends(input)
      .filter(
        (record) => record.harness === "hermes" && record.family === family
      )
      .slice(0, 3 + (index % 3))) {
      fail(row);
    }
  }
  const pass = analyzeProductRecords(input);
  expect(pass.groups[0]?.decision.superiority).toBe("qualifies_within_scope");
  for (const row of ends(input)
    .filter(
      (record) => record.harness === "atlas" && record.family === FILES[0]
    )
    .slice(0, 2)) {
    fail(row);
  }
  const floor = analyzeProductRecords(input);
  expect(floor.groups[0]?.equalFamilyAtlasRate).toBeGreaterThan(0.9);
  expect(floor.groups[0]?.decision.floorPass).toBe(false);
  expect(floor.groups[0]?.decision.superiority).toBe(
    "inconclusive_or_does_not_qualify"
  );
  const critical = fixture("files");
  ends(critical)[0]!.criticalIntegrityFailure = true;
  expect(analyzeProductRecords(critical).groups[0]?.decision.floorPass).toBe(
    false
  );
  input.phase = "pilot";
  for (const row of input.ledger.map(asRow)) {
    row.phase = "pilot";
  }
  const pilot = analyzeProductRecords(input);
  expect(pilot.groups[0]?.decision.exploratory).toBe(true);
  expect(pilot.groups[0]?.decision.noninferiority).toBe(
    "inconclusive_or_does_not_qualify"
  );
});

test("bootstrap is deterministic and clusters families while averaging correlated repetitions", () => {
  const a = productFamilyBootstrap([-1, 0, 1], 20_260_917)!;
  expect(a).toEqual(productFamilyBootstrap([-1, 0, 1], 20_260_917)!);
  expect(a.draws).toBe(100_000);
  expect(a.pointEstimate).toBe(0);
  expect(a.simultaneous97_5.lower).toBeLessThanOrEqual(a.descriptive95.lower);
  expect(a.simultaneous97_5.upper).toBeGreaterThanOrEqual(
    a.descriptive95.upper
  );
  const input = fixture("files");
  fail(
    ends(input).find(
      (row) => row.harness === "hermes" && row.family === FILES[0]
    )!
  );
  const report = analyzeProductRecords(input);
  expect(
    report.groups[0]?.families.find((family) => family.family === FILES[0])
      ?.effect
  ).toBe(1 / 6);
  expect(report.groups[0]?.bootstrap?.clusters).toBe(9);
});

test("unknown comparator usage or elapsed time cannot manufacture a superiority or noninferiority claim", () => {
  const base = fixture("files");
  for (const [index, family] of FILES.entries()) {
    for (const row of ends(base)
      .filter(
        (record) => record.harness === "hermes" && record.family === family
      )
      .slice(0, 3 + (index % 3))) {
      fail(row);
    }
  }
  expect(analyzeProductRecords(base).groups[0]?.decision.superiority).toBe(
    "qualifies_within_scope"
  );
  for (const change of ["usage", "elapsed"] as const) {
    const input = structuredClone(base);
    const row = ends(input).find((record) => record.harness === "hermes")!;
    if (change === "usage") {
      asRow(row.usageEvidence).mandatoryUsageKnown = false;
    } else {
      delete row.elapsedMs;
    }
    const report = analyzeProductRecords(input);
    expect(report.groups[0]?.decision.comparativeAccountingKnown).toBe(false);
    expect(report.groups[0]?.decision.noninferiority).toBe(
      "inconclusive_or_does_not_qualify"
    );
    expect(report.groups[0]?.decision.superiority).toBe(
      "inconclusive_or_does_not_qualify"
    );
    expect(report.groups[0]?.intentionToRun.pairs).toBe(54);
    expect(certifyProductUsage(row, BUDGET).budgetExceeded).toBe(false);
  }
});

async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}
async function archive(
  root: string,
  files: Record<string, string>,
  destination: string
) {
  const child = Bun.spawn(
    ["/usr/bin/tar", "-czf", destination, "--null", "-T", "-"],
    { cwd: root, stderr: "pipe", stdin: "pipe", stdout: "pipe" }
  );
  child.stdin.write(Object.keys(files).join("\0") + "\0");
  child.stdin.end();
  if (await child.exited) {
    throw new Error(await new Response(child.stderr).text());
  }
  return sha(await readFile(destination));
}

/** Synthetic evidence files only: never freezes or runs a real study. */
async function archivalFixture(
  phase: "confirmatory" | "pilot" = "confirmatory"
) {
  const root = await mkdtemp("/private/tmp/product-analysis-archive-test-");
  const sourceRoot = join(root, "synthetic-source");
  const directory = join(root, "batches", "synthetic-confirmation");
  const frozen = join(root, "frozen");
  const input = fixture("files");
  const contents = {
    "apps/synthetic.txt": "synthetic product source",
    "hermes.py": "# synthetic pinned source",
    "scripts/harness-product-compare-v2/product-analysis.ts": await readFile(
      join(import.meta.dir, "product-analysis.ts"),
      "utf8"
    ),
    "scripts/harness-product-compare-v2/product-identity.ts": await readFile(
      join(import.meta.dir, "product-identity.ts"),
      "utf8"
    ),
  };
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), content);
  }
  await mkdir(directory, { recursive: true });
  await mkdir(frozen);
  const atlasHashes = {
    "apps/synthetic.txt": sha(contents["apps/synthetic.txt"]),
  };
  const hermesHashes = { "hermes.py": sha(contents["hermes.py"]) };
  const controlHashes = {
    "scripts/harness-product-compare-v2/product-analysis.ts": sha(
      contents["scripts/harness-product-compare-v2/product-analysis.ts"]
    ),
    "scripts/harness-product-compare-v2/product-identity.ts": sha(
      contents["scripts/harness-product-compare-v2/product-identity.ts"]
    ),
  };
  const source = {
    atlasHashes,
    candidateSourceHash: sha(JSON.stringify(atlasHashes)),
    controlHashes,
    hermesHashes,
  };
  const archives: Record<string, string> = {};
  for (const [name, map] of [
    ["atlas-source.tar.gz", atlasHashes],
    ["hermes-source.tar.gz", hermesHashes],
    ["file-protocol-source.tar.gz", controlHashes],
  ] as const) {
    archives[name] = await archive(sourceRoot, map, join(frozen, name));
    await writeFile(join(directory, name), await readFile(join(frozen, name)));
  }
  const manifest = {
    ...source,
    archives,
    budget: BUDGET,
    candidateContractSha256: "contract",
    codeSandboxPolicySha256: "policy",
    endpoint: "https://synthetic.invalid/v1",
    model: "synthetic",
    runtimeFingerprint: {},
    schedules: { confirmatory: sha(JSON.stringify(input.schedule)) },
  };
  await json(join(frozen, "manifest.json"), manifest);
  await json(join(frozen, "confirmatory-schedule.json"), input.schedule);
  await json(join(directory, "source-archives.json"), archives);
  await json(join(directory, "batch.json"), {
    ...source,
    batch: "synthetic-confirmation",
    budget: BUDGET,
    candidateContractSha256: "contract",
    expectedPolicyHash: "policy",
    manifestSha256: sha(await readFile(join(frozen, "manifest.json"))),
    model: "synthetic",
    phase,
    runtimeFingerprint: {},
    schedule: input.schedule,
    transportMode: "live",
  });
  await json(join(root, "admissions/confirmatory.json"), {
    batch: "synthetic-confirmation",
    candidateSourceHash: source.candidateSourceHash,
  });
  await json(join(directory, "completed.json"), {
    pairedTasks: 54,
    scheduledAttempts: 108,
    sourceUnchanged: true,
  });
  const mappings = new Map<string, Record<string, unknown>>();
  for (const row of input.ledger
    .map(asRow)
    .filter((entry) => entry.event === "start")) {
    const mapping = {
      attemptId: row.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      harness: row.harness,
      nativeStateRoot: `/private/tmp/agent-runtime-synthetic/state-${mappings.size}`,
      pairId: row.pairId,
      repetition: row.repetition,
      schemaVersion: 1,
      taskId: row.taskId ?? null,
      transportId: `transport-${randomUUID()}`,
    };
    mappings.set(String(row.id), mapping);
    await json(
      join(directory, "trials", String(row.id), "runtime-identity.json"),
      mapping
    );
  }
  for (const row of input.ledger.map(asRow)) {
    const mapping = mappings.get(String(row.id))!;
    row.transportId = mapping.transportId;
    row.identitySha256 = sha(JSON.stringify(mapping, null, 2));
    row.candidateSourceHash = source.candidateSourceHash;
    row.phase = phase;
    if (row.event === "end") {
      await json(
        join(directory, "trials", String(row.id), "runner-input.json"),
        {
          modelMetadata: { evidence: { endpoint: wire().expected.endpoint } },
          proxyBaseUrl: "http://127.0.0.1:34567",
          runId: mapping.transportId,
          stateRoot: mapping.nativeStateRoot,
        }
      );
      await json(
        join(directory, "trials", String(row.id), "observation.json"),
        { framework: mapping.harness, runId: mapping.transportId }
      );
      await json(
        join(
          directory,
          "trials",
          String(row.id),
          "wire/native-transport-binding.json"
        ),
        {
          chatPath: `/runs/${mapping.transportId}/v1/chat/completions`,
          modelPath: `/runs/${mapping.transportId}/v1/models`,
          publicOrigin: "http://127.0.0.1:34567",
          schemaVersion: 1,
          transportId: mapping.transportId,
        }
      );
      await json(join(directory, "trials", String(row.id), "result.json"), row);
      await json(
        join(
          directory,
          "trials",
          String(row.id),
          "wire/native-usage-final.json"
        ),
        row.usageEvidence
      );
      await json(
        join(directory, "trials", String(row.id), "wire/001-request.json"),
        wire().request
      );
      await json(
        join(directory, "trials", String(row.id), "wire/001-response.json"),
        wire().response
      );
    }
  }
  const index = {
    entries: input.ledger
      .map(asRow)
      .filter((row) => row.event === "start")
      .map((row) => ({
        attemptId: row.id,
        identitySha256: row.identitySha256,
      })),
    schemaVersion: 1,
  };
  await json(join(directory, "runtime-identities.json"), index);
  await json(join(directory, "completed.json"), {
    pairedTasks: 54,
    runtimeIdentitiesSha256: sha(JSON.stringify(index, null, 2)),
    scheduledAttempts: 108,
    sourceUnchanged: true,
  });
  await writeFile(
    join(directory, "attempts.jsonl"),
    input.ledger.map((row) => JSON.stringify(row)).join("\n") + "\n"
  );
  return {
    directory,
    firstAttemptId: String(asRow(input.ledger[0]).id),
    root,
    sourceRoot,
  };
}

test("offline archival verification ignores changed checkout stand-in and rejects missing admission or altered archive", async () => {
  const fixture_ = await archivalFixture();
  await json(
    join(
      fixture_.directory,
      "trials",
      fixture_.firstAttemptId,
      "runner-input.json"
    ),
    {
      ...JSON.parse(
        await readFile(
          join(
            fixture_.directory,
            "trials",
            fixture_.firstAttemptId,
            "runner-input.json"
          ),
          "utf8"
        )
      ),
      modelMetadata: {
        evidence: { endpoint: "https://ignored-for-live.invalid/v1" },
      },
    }
  );
  await writeFile(
    join(fixture_.sourceRoot, "apps/synthetic.txt"),
    "new candidate after run"
  );
  const valid = await analyzeProductBatch(fixture_.directory, "files");
  expect(valid.validity.issues).toEqual([]);
  expect(valid.groups[0]?.intentionToRun.counts.bothPass).toBe(54);
  await json(join(fixture_.root, "admissions/confirmatory.json"), {
    batch: "a-different-admission",
  });
  const invalid = await analyzeProductBatch(fixture_.directory, "files");
  expect(invalid.validity.issues).toContain(
    "frozen_admission_missing_or_mismatch"
  );
  await writeFile(join(fixture_.directory, "atlas-source.tar.gz"), "corrupted");
  const corrupted = await analyzeProductBatch(fixture_.directory, "files");
  expect(corrupted.validity.valid).toBe(false);
  expect(
    corrupted.validity.issues.some((issue) =>
      issue.includes("archive byte hash mismatch")
    )
  ).toBe(true);
}, 30_000);

test("unfrozen scripted pilots use one shared captured input endpoint and reject missing, malformed or differing endpoints", async () => {
  const fixture_ = await archivalFixture("pilot");
  await rm(join(fixture_.root, "frozen"), { recursive: true });
  const metadataPath = join(fixture_.directory, "batch.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.phase = "pilot";
  metadata.transportMode = "offline-scripted";
  metadata.manifestSha256 = null;
  await json(metadataPath, metadata);
  const valid = await analyzeProductBatch(fixture_.directory, "files");
  expect(valid.validity.issues).toEqual([]);
  expect(valid.groups[0]?.decision.superiority).toBe(
    "inconclusive_or_does_not_qualify"
  );
  const inputPath = join(
    fixture_.directory,
    "trials",
    fixture_.firstAttemptId,
    "runner-input.json"
  );
  await json(inputPath, {
    modelMetadata: { evidence: { endpoint: "https://different.invalid/v1" } },
  });
  const differing = await analyzeProductBatch(fixture_.directory, "files");
  expect(differing.validity.issues).toContain(
    "offline_pilot_endpoint_not_shared_by_all_arms"
  );
  for (const endpoint of [undefined, "not a URL"]) {
    await json(inputPath, { modelMetadata: { evidence: { endpoint } } });
    const invalid = await analyzeProductBatch(fixture_.directory, "files");
    expect(invalid.validity.valid).toBe(false);
    expect(
      invalid.validity.issues.some((issue) =>
        issue.startsWith("offline_pilot_endpoint_missing_or_malformed:")
      )
    ).toBe(true);
  }
  metadata.transportMode = "live";
  await json(metadataPath, metadata);
  const live = await analyzeProductBatch(fixture_.directory, "files");
  expect(live.validity.issues).toContain("frozen_manifest_missing");
  expect(
    live.validity.issues.some((issue) =>
      issue.startsWith("upstream_endpoint_mismatch:")
    )
  ).toBe(true);
}, 30_000);

test("historical identity audit rejects changed mappings, captured adapter identities and private model labels", async () => {
  const fixture_ = await archivalFixture();
  const trial = join(fixture_.directory, "trials", fixture_.firstAttemptId);
  const mappingPath = join(trial, "runtime-identity.json");
  const original = await readFile(mappingPath);
  const mapping = JSON.parse(original.toString());
  await json(mappingPath, { ...mapping, taskId: "altered-task" });
  const changed = await analyzeProductBatch(fixture_.directory, "files");
  expect(
    changed.validity.issues.some((issue) =>
      issue.startsWith("runtime_identity_mismatch:")
    )
  ).toBe(true);
  await writeFile(mappingPath, original);
  const inputPath = join(trial, "runner-input.json");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  await json(inputPath, { ...input, runId: "a-descriptive-run-id" });
  const wrongInput = await analyzeProductBatch(fixture_.directory, "files");
  expect(wrongInput.validity.issues).toContain(
    `runtime_input_identity_mismatch:${fixture_.firstAttemptId}`
  );
  await json(inputPath, input);
  const wirePath = join(trial, "wire/001-request.json");
  const request = JSON.parse(await readFile(wirePath, "utf8"));
  await json(wirePath, {
    ...request,
    effective: {
      ...request.effective,
      messages: [{ content: `Workspace: ${trial}`, role: "system" }],
    },
  });
  const exposed = await analyzeProductBatch(fixture_.directory, "files");
  expect(
    exposed.validity.issues.some((issue) =>
      issue.startsWith("private_evaluator_identity_in_model_context:")
    )
  ).toBe(true);
  await json(wirePath, {});
  const malformed = await analyzeProductBatch(fixture_.directory, "files");
  expect(malformed.validity.valid).toBe(false);
  expect(
    malformed.validity.issues.some((issue) =>
      issue.startsWith("effective_model_mismatch:")
    )
  ).toBe(true);
  expect(malformed.groups[0]?.intentionToRun.pairs).toBe(54);
  await json(wirePath, request);
  await rm(join(fixture_.directory, "runtime-identities.json"));
  const missing = await analyzeProductBatch(fixture_.directory, "files");
  expect(missing.validity.issues).toContain(
    "runtime_identity_index_missing_or_malformed"
  );
}, 30_000);
