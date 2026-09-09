import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeSyntheticFileParents } from "./file-parent-evidence-fixtures";
import {
  analyzeProductBatch,
  analyzeProductRecords,
  certifyProductUsage,
  type ProductAnalysisInput,
  type ProductPair,
  type ProductTrack,
  productFamilyBootstrap,
  validateProductHeaderProfile,
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
      endpoint: "https://opencode.ai/zen/go/v1",
      maxOutputTokens: 4096,
      model: "mimo-v2.5",
      remainingGeneratedTokens: 12_000,
    },
    request: {
      effective: {
        max_tokens: 4096,
        model: "mimo-v2.5",
        stream: false,
        temperature: 0.2,
      },
      model: "mimo-v2.5",
      request: { model: "mimo-v2.5" },
      upstreamEndpoint: "https://opencode.ai/zen/go/v1",
    },
    response: {
      response: {
        model: "mimo-v2.5",
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
    fileParentEvidence:
      track === "files"
        ? new Map(
            ledger
              .filter((event) => event.event === "start")
              .map((event) => [
                String(event.id),
                {
                  failures: [],
                  nativeIdentity: "bound" as const,
                  nativeObservation: null,
                  nativeRequirementsMet: true,
                  parentVerified: true,
                  processEligible: true,
                },
              ])
          )
        : undefined,
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

test("all-passing file ties qualify only as finite census and unknown cache does not fail", () => {
  const report = analyzeProductRecords(fixture("files"));
  expect(report.validity.valid).toBe(true);
  expect(report.coverage.scheduledPairs).toBe(54);
  expect(report.coverage.rawEndRecords).toBe(108);
  expect(report.groups[0]?.intentionToRun.counts.bothPass).toBe(54);
  expect(report.groups[0]?.decision.floorPass).toBe(true);
  expect(report.groups[0]?.bootstrap).toBeNull();
  expect(report.groups[0]?.decision.finiteCensus?.eligible).toBe(true);
  expect(report.groups[0]?.decision.noninferiority).toBe(
    "not_evaluated_finite_census"
  );
  expect(report.groups[0]?.decision.observedTie).toBe(true);
  expect(report.resources.atlas.cachedTokens.missingCount).toBe(54);
  expect(report.resources.atlas.generatedTokens.total).toBe(540);
  expect(report.groups[0]?.strictIntentionToRun).toBeNull();
});
test("file native JSON alone cannot certify primary completion without a verified parent", () => {
  const input = fixture("files");
  input.fileParentEvidence = undefined;
  const report = analyzeProductRecords(input);
  expect(report.validity.valid).toBe(false);
  expect(report.groups[0]?.intentionToRun.counts.neitherSuccessful).toBe(54);
  expect(report.groups[0]?.decision.finiteCensus?.eligible).toBe(false);
});
test("all-failing ties keep the full census and cannot satisfy descriptive floors", () => {
  const input = fixture("files");
  for (const row of ends(input)) {
    fail(row);
  }
  const report = analyzeProductRecords(input);
  expect(report.validity.valid).toBe(true);
  expect(report.groups[0]?.intentionToRun.counts.neitherSuccessful).toBe(54);
  expect(report.groups[0]?.decision.observedTie).toBe(true);
  expect(report.groups[0]?.decision.floorPass).toBe(false);
  expect(report.groups[0]?.decision.finiteCensus?.eligible).toBe(false);
});
test("a complete file census meeting Atlas floors still cannot qualify below Hermes count", () => {
  const input = fixture("files");
  fail(ends(input).find((row) => row.harness === "atlas")!);
  const report = analyzeProductRecords(input);
  expect(report.groups[0]?.decision.floorPass).toBe(true);
  expect(report.groups[0]?.decision.finiteCensus?.atlasPrimaryCount).toBe(53);
  expect(report.groups[0]?.decision.finiteCensus?.hermesPrimaryCount).toBe(54);
  expect(report.groups[0]?.decision.finiteCensus?.eligible).toBe(false);
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
    "not_evaluated_finite_census"
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
  expect(pass.groups[0]?.decision.finiteCensus?.eligible).toBe(true);
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
    "not_evaluated_finite_census"
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
    "not_evaluated_finite_census"
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
  expect(report.groups[0]?.bootstrap).toBeNull();
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
  expect(
    analyzeProductRecords(base).groups[0]?.decision.finiteCensus?.eligible
  ).toBe(true);
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
    expect(report.groups[0]?.decision.finiteCensus?.eligible).toBe(true);
    expect(report.groups[0]?.decision.noninferiority).toBe(
      "not_evaluated_finite_census"
    );
    expect(report.groups[0]?.decision.superiority).toBe(
      "not_evaluated_finite_census"
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
  phase: "confirmatory" | "pilot" = "confirmatory",
  capturedEndpoint = wire().expected.endpoint
) {
  const root = await mkdtemp("/private/tmp/product-analysis-archive-test-");
  const sourceRoot = join(root, "synthetic-source");
  const directory = join(root, "batches", "synthetic-confirmation");
  const frozen = join(root, "frozen");
  const input = fixture("files");
  const contents: Record<string, string> = {
    "apps/synthetic.txt": "synthetic product source",
    "hermes.py": "# synthetic pinned source",
    "scripts/harness-native-files-mimo-v3/product-analysis.ts": await readFile(
      join(import.meta.dir, "product-analysis.ts"),
      "utf8"
    ),
    "scripts/harness-native-files-mimo-v3/product-identity.ts": await readFile(
      join(import.meta.dir, "product-identity.ts"),
      "utf8"
    ),
  };
  for (const name of [
    "product-model-profile.json",
    "product-model-probe-completed.json",
    "product-model-probe-tool-request.json",
    "product-model-probe-tool-response.json",
    "file-parent-evidence.ts",
    "file-process-outcome.ts",
    "file-process-runner.ts",
    "file-invocation.ts",
    "product-model.ts",
    "product-proxy-broker.ts",
    "file-markdown-vendor.mjs",
    "file-markdown-vendor.d.mts",
    "file-markdown-package.json",
    "file-markdown-license.txt",
    "file-markdown-dependency.json",
    "file-delivery-markdown.ts",
    "file-markdown-dependency.ts",
  ]) {
    contents[`scripts/harness-native-files-mimo-v3/${name}`] = await readFile(
      join(import.meta.dir, name),
      "utf8"
    );
  }
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
  const controlHashes: Record<string, string> = {
    "scripts/harness-native-files-mimo-v3/product-analysis.ts": sha(
      contents["scripts/harness-native-files-mimo-v3/product-analysis.ts"]
    ),
    "scripts/harness-native-files-mimo-v3/product-identity.ts": sha(
      contents["scripts/harness-native-files-mimo-v3/product-identity.ts"]
    ),
  };
  for (const name of [
    "product-model-profile.json",
    "product-model-probe-completed.json",
    "product-model-probe-tool-request.json",
    "product-model-probe-tool-response.json",
    "file-parent-evidence.ts",
    "file-process-outcome.ts",
    "file-process-runner.ts",
    "file-invocation.ts",
    "product-model.ts",
    "product-proxy-broker.ts",
    "file-markdown-vendor.mjs",
    "file-markdown-vendor.d.mts",
    "file-markdown-package.json",
    "file-markdown-license.txt",
    "file-markdown-dependency.json",
    "file-delivery-markdown.ts",
    "file-markdown-dependency.ts",
  ]) {
    const path = `scripts/harness-native-files-mimo-v3/${name}`;
    controlHashes[path] = sha(contents[path]);
  }
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
    endpoint: "https://opencode.ai/zen/go/v1",
    model: "mimo-v2.5",
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
    model: "mimo-v2.5",
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
  for (const event of input.ledger.map(asRow)) {
    event.id = `synthetic-confirmation-${event.id}`;
  }
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
          modelMetadata: { evidence: { endpoint: capturedEndpoint } },
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
        join(
          directory,
          "trials",
          String(row.id),
          "wire/001-upstream-profile.json"
        ),
        {
          endpoint: "https://opencode.ai/zen/go/v1",
          model: "mimo-v2.5",
          userAgent: "Atlas-Hermes-Compatibility-Probe/1.0 (nonstreaming)",
        }
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
  await writeSyntheticFileParents(
    directory,
    input.schedule,
    input.ledger.map(asRow)
  );
  return {
    directory,
    firstAttemptId: String(asRow(input.ledger[0]).id),
    root,
    sourceRoot,
  };
}

test("offline archival verification ignores changed checkout stand-in and rejects missing admission or altered archive", async () => {
  const fixture_ = await archivalFixture(
    "confirmatory",
    "https://ignored-for-live.invalid/v1"
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
    "not_evaluated_finite_census"
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

test("MiMo profile rejects missing, wrong model and changed User-Agent evidence", () => {
  const correct = {
    endpoint: "https://opencode.ai/zen/go/v1",
    model: "mimo-v2.5",
    userAgent: "Atlas-Hermes-Compatibility-Probe/1.0 (nonstreaming)",
  };
  expect(validateProductHeaderProfile(correct)).toEqual([]);
  for (const value of [
    null,
    {},
    { ...correct, userAgent: "other" },
    { ...correct, model: "other" },
    { ...correct, endpoint: "https://other.invalid" },
  ]) {
    expect(validateProductHeaderProfile(value)).toEqual([
      "upstream_header_profile_mismatch",
    ]);
  }
});

test("historical evidence rejects substituted compatibility receipts and missing header traces", async () => {
  const fixture_ = await archivalFixture();
  const metadataPath = join(fixture_.directory, "batch.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.controlHashes[
    "scripts/harness-native-files-mimo-v3/product-model-probe-completed.json"
  ] = "f".repeat(64);
  await json(metadataPath, metadata);
  const substituted = await analyzeProductBatch(fixture_.directory, "files");
  expect(substituted.validity.issues).toContain(
    "model_evidence_inventory_mismatch:scripts/harness-native-files-mimo-v3/product-model-probe-completed.json"
  );
  const profilePath = join(
    fixture_.directory,
    "trials",
    fixture_.firstAttemptId,
    "wire/001-upstream-profile.json"
  );
  await rm(profilePath);
  const missing = await analyzeProductBatch(fixture_.directory, "files");
  expect(
    missing.validity.issues.some((issue) =>
      issue.startsWith("upstream_header_profile_mismatch:")
    )
  ).toBe(true);
}, 30_000);

async function replaceSyntheticControlArchive(
  fixture_: Awaited<ReturnType<typeof archivalFixture>>,
  controlHashes: Record<string, string>,
  members: Record<string, string>
) {
  const archiveName = "file-protocol-source.tar.gz";
  const archivePath = join(fixture_.directory, archiveName);
  const archiveHash = await archive(fixture_.sourceRoot, members, archivePath);
  const archives = JSON.parse(
    await readFile(join(fixture_.directory, "source-archives.json"), "utf8")
  );
  archives[archiveName] = archiveHash;
  await json(join(fixture_.directory, "source-archives.json"), archives);
  await writeFile(
    join(fixture_.root, "frozen", archiveName),
    await readFile(archivePath)
  );
  const manifestPath = join(fixture_.root, "frozen/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.archives = archives;
  manifest.controlHashes = controlHashes;
  await json(manifestPath, manifest);
  const metadataPath = join(fixture_.directory, "batch.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.controlHashes = controlHashes;
  metadata.manifestSha256 = sha(await readFile(manifestPath));
  await json(metadataPath, metadata);
}

test("parser archive membership and bytes remain mandatory after outer archive hashes are recomputed", async () => {
  const fixture_ = await archivalFixture();
  try {
    const metadata = JSON.parse(
      await readFile(join(fixture_.directory, "batch.json"), "utf8")
    );
    const controlHashes = metadata.controlHashes as Record<string, string>;
    expect(
      (await analyzeProductBatch(fixture_.directory, "files")).validity.issues
    ).toEqual([]);
    for (const name of [
      "file-delivery-markdown.ts",
      "file-markdown-vendor.mjs",
    ]) {
      const path = `scripts/harness-native-files-mimo-v3/${name}`;
      const sourcePath = join(fixture_.sourceRoot, path);
      const original = await readFile(sourcePath);
      for (const change of ["missing", "tampered"]) {
        const members = { ...controlHashes };
        if (change === "missing") {
          delete members[path];
        } else {
          await writeFile(sourcePath, "altered archived parser bytes\n");
        }
        await replaceSyntheticControlArchive(fixture_, controlHashes, members);
        // Historical validation must inspect the archive even when the current
        // checkout stand-in is restored to the correct bytes before analysis.
        await writeFile(sourcePath, original);
        const invalid = await analyzeProductBatch(fixture_.directory, "files");
        expect(invalid.validity.valid).toBe(false);
        expect(
          invalid.validity.issues.some((issue) =>
            issue.includes("archive member inventory/content mismatch")
          )
        ).toBe(true);
        expect(
          invalid.validity.issues.some((issue) =>
            issue.includes("archive byte hash mismatch")
          )
        ).toBe(false);
        expect(invalid.groups[0]?.intentionToRun.pairs).toBe(54);
      }
    }
  } finally {
    await rm(fixture_.root, { force: true, recursive: true });
  }
}, 30_000);

test("parser implementation and dependency declarations cannot be coherently omitted from historical inventories", async () => {
  const fixture_ = await archivalFixture();
  try {
    const metadata = JSON.parse(
      await readFile(join(fixture_.directory, "batch.json"), "utf8")
    );
    const original = metadata.controlHashes as Record<string, string>;
    for (const name of [
      "file-delivery-markdown.ts",
      "file-markdown-dependency.ts",
      "file-markdown-dependency.json",
    ]) {
      const path = `scripts/harness-native-files-mimo-v3/${name}`;
      const incomplete = { ...original };
      delete incomplete[path];
      // Remove the same member from both inventories and both archives. A
      // checksummed, internally consistent bundle still needs required controls.
      await replaceSyntheticControlArchive(fixture_, incomplete, incomplete);
      const invalid = await analyzeProductBatch(fixture_.directory, "files");
      expect(invalid.validity.valid).toBe(false);
      expect(invalid.validity.issues).toContain(
        name.endsWith(".json")
          ? `model_evidence_inventory_mismatch:${path}`
          : `markdown_parser_implementation_not_in_source_inventory:${name}`
      );
      expect(
        invalid.validity.issues.some((issue) =>
          issue.includes("archive member inventory/content mismatch")
        )
      ).toBe(false);
      expect(invalid.groups[0]?.intentionToRun.pairs).toBe(54);
    }
  } finally {
    await rm(fixture_.root, { force: true, recursive: true });
  }
}, 30_000);

/** Synthetic C9 accounting envelope matching the retained local finalizer failure; never rewrites that original run. */
async function uncertainAccountingFixture() {
  const fixture_ = await archivalFixture();
  const path = join(fixture_.directory, "attempts.jsonl");
  const ledger = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);
  const end = ledger.find(
    (row) => row.id === fixture_.firstAttemptId && row.event === "end"
  )!;
  const trial = join(fixture_.directory, "trials", fixture_.firstAttemptId);
  const evidence = asRow(end.usageEvidence);
  const request = asRow((evidence.requests as unknown[])[0]);
  const requests = [1, 2].map((index) => ({
    ...request,
    generatedTokens: 10,
    index,
    promptTokens: 20,
  }));
  Object.assign(evidence, {
    finalized: false,
    generatedTokens: null,
    mandatoryUsageKnown: false,
    observationError: false,
    observedGeneratedTokens: 20,
    observedPromptTokens: 40,
    promptTokens: null,
    requests,
  });
  Object.assign(asRow(end.usage), {
    generatedTokens: null,
    mandatoryUsageKnown: false,
    missingUsage: true,
    observedGeneratedTokens: 20,
    observedPromptTokens: 40,
    promptTokens: null,
    providerRequests: 2,
  });
  Object.assign(end, { status: "accounting_uncertain", success: false });
  const response = JSON.parse(
    await readFile(join(trial, "wire/001-response.json"), "utf8")
  ) as Row;
  Object.assign(asRow(asRow(response.response).usage), {
    completion_tokens: 10,
    prompt_tokens: 20,
  });
  await json(join(trial, "wire/001-response.json"), response);
  for (const suffix of [
    "request.json",
    "response.json",
    "upstream-profile.json",
  ]) {
    await writeFile(
      join(trial, `wire/002-${suffix}`),
      await readFile(join(trial, `wire/001-${suffix}`))
    );
  }
  const finalPath = join(trial, "wire/native-usage-final.json");
  const journalPath = join(trial, "wire/native-usage-observations.jsonl");
  await rm(finalPath);
  await writeFile(
    journalPath,
    requests.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
  const persist = async () => {
    await json(join(trial, "result.json"), end);
    await writeFile(
      path,
      ledger.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    );
  };
  await persist();
  return {
    ...fixture_,
    end,
    evidence,
    finalPath,
    journalPath,
    persist,
    requests,
  };
}

test("missing final accounting receipt with verified parent retains failed arm and exact known request subtotals", async () => {
  const f = await uncertainAccountingFixture();
  try {
    const result = await analyzeProductBatch(f.directory, "files");
    expect(result.validity.issues).toEqual([]);
    expect(result.groups[0]?.intentionToRun.counts.hermesOnly).toBe(1);
    expect(result.groups[0]?.intentionToRun.pairs).toBe(54);
    expect(result.resources.atlas.generatedTokens.total).toBeNull();
    expect(
      result.resources.atlas.observedGeneratedTokenLowerBounds.observedTotal
    ).toBe(550);
    expect(
      result.resources.atlas.observedPromptTokenLowerBounds.observedTotal
    ).toBe(1630);
    expect(result.groups[0]?.decision.comparativeAccountingKnown).toBe(false);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
}, 15_000);

test("an existing conflicting, null or malformed final accounting file remains structural", async () => {
  const f = await uncertainAccountingFixture();
  try {
    for (const content of ["{}", "null", "{"]) {
      await writeFile(f.finalPath, content);
      const result = await analyzeProductBatch(f.directory, "files");
      expect(result.validity.valid).toBe(false);
      expect(
        result.validity.issues.some((issue) =>
          issue.includes("final_usage_evidence")
        )
      ).toBe(true);
    }
    await rm(f.finalPath);
    await symlink(join(f.root, "absent-final-target.json"), f.finalPath);
    const dangling = await analyzeProductBatch(f.directory, "files");
    expect(dangling.validity.valid).toBe(false);
    expect(
      dangling.validity.issues.some((issue) =>
        issue.startsWith("unreadable_final_usage_evidence:")
      )
    ).toBe(true);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
}, 15_000);

test("the absent final receipt exception requires uncertainty, verified parent and matching observed subtotals", async () => {
  const f = await uncertainAccountingFixture();
  try {
    f.evidence.finalized = true;
    f.evidence.mandatoryUsageKnown = true;
    f.evidence.generatedTokens = 20;
    f.evidence.promptTokens = 40;
    Object.assign(asRow(f.end.usage), {
      generatedTokens: 20,
      promptTokens: 40,
    });
    await f.persist();
    expect(
      (await analyzeProductBatch(f.directory, "files")).validity.valid
    ).toBe(false);
    Object.assign(f.evidence, {
      finalized: false,
      generatedTokens: null,
      mandatoryUsageKnown: false,
      observedPromptTokens: 41,
      promptTokens: null,
    });
    Object.assign(asRow(f.end.usage), {
      generatedTokens: null,
      observedPromptTokens: 41,
      promptTokens: null,
    });
    await f.persist();
    expect(
      (await analyzeProductBatch(f.directory, "files")).validity.valid
    ).toBe(false);
    f.evidence.observedPromptTokens = 40;
    asRow(f.end.usage).observedPromptTokens = 40;
    await f.persist();
    const trial = join(f.directory, "trials", f.firstAttemptId);
    await rm(join(trial, "process/parent-runtime-identity.json"));
    const result = await analyzeProductBatch(f.directory, "files");
    expect(result.validity.valid).toBe(false);
    expect(
      result.validity.issues.some((issue) =>
        issue.startsWith("final_usage_evidence_mismatch:")
      )
    ).toBe(true);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
}, 15_000);

test("lost journal writes require explicit observation error and conflicting retained records still fail", async () => {
  const f = await uncertainAccountingFixture();
  try {
    await rm(f.journalPath);
    expect(
      (await analyzeProductBatch(f.directory, "files")).validity.valid
    ).toBe(false);
    f.evidence.observationError = true;
    f.evidence.finalized = true;
    await f.persist();
    const lost = await analyzeProductBatch(f.directory, "files");
    expect(lost.validity.issues).toEqual([]);
    expect(lost.resources.atlas.generatedTokens.total).toBeNull();
    expect(lost.groups[0]?.intentionToRun.counts.hermesOnly).toBe(1);
    const conflict = f.requests.map((request) => ({ ...request }));
    conflict[0]!.generatedTokens = 99;
    await writeFile(
      f.journalPath,
      conflict.map((request) => JSON.stringify(request)).join("\n") + "\n"
    );
    expect(
      (await analyzeProductBatch(f.directory, "files")).validity.valid
    ).toBe(false);
    await writeFile(f.journalPath, "{");
    expect(
      (await analyzeProductBatch(f.directory, "files")).validity.valid
    ).toBe(false);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
}, 15_000);

test("later journal completion cannot promote captured totals and its successful wire evidence remains mandatory", async () => {
  const f = await uncertainAccountingFixture();
  try {
    const pending = asRow((f.evidence.requests as unknown[])[1]);
    Object.assign(pending, {
      generatedTokens: null,
      kind: "pending",
      promptTokens: null,
      status: null,
    });
    Object.assign(f.evidence, {
      inFlightRequests: 1,
      observationError: true,
      observedGeneratedTokens: 10,
      observedPromptTokens: 20,
    });
    Object.assign(asRow(f.end.usage), {
      observedGeneratedTokens: 10,
      observedPromptTokens: 20,
    });
    await f.persist();
    const result = await analyzeProductBatch(f.directory, "files");
    expect(result.validity.issues).toEqual([]);
    expect(result.resources.atlas.generatedTokens.total).toBeNull();
    expect(
      result.resources.atlas.observedGeneratedTokenLowerBounds.observedTotal
    ).toBe(540);
    expect(
      result.resources.atlas.observedPromptTokenLowerBounds.observedTotal
    ).toBe(1610);
    expect(result.groups[0]?.intentionToRun.counts.hermesOnly).toBe(1);
    await rm(
      join(f.directory, "trials", f.firstAttemptId, "wire/002-response.json")
    );
    const missing = await analyzeProductBatch(f.directory, "files");
    expect(missing.validity.valid).toBe(false);
    expect(
      missing.validity.issues.some((issue) =>
        issue.startsWith("wire_evidence_missing:")
      )
    ).toBe(true);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
}, 15_000);

test("frozen FILE V3 rejects a different individually valid Atlas source archive across phases", async () => {
  const f = await archivalFixture();
  try {
    const frozen = join(f.root, "frozen");
    const manifestPath = join(frozen, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Row;
    const replacement = "a different individually valid frozen Atlas source";
    await writeFile(join(f.sourceRoot, "apps/synthetic.txt"), replacement);
    const atlasHashes = { "apps/synthetic.txt": sha(replacement) };
    const archiveHash = await archive(
      f.sourceRoot,
      atlasHashes,
      join(frozen, "atlas-source.tar.gz")
    );
    Object.assign(manifest, {
      atlasHashes,
      candidateSourceHash: sha(JSON.stringify(atlasHashes)),
    });
    asRow(manifest.archives)["atlas-source.tar.gz"] = archiveHash;
    await json(manifestPath, manifest);
    const batchPath = join(f.directory, "batch.json");
    const batch = JSON.parse(await readFile(batchPath, "utf8")) as Row;
    batch.manifestSha256 = sha(await readFile(manifestPath));
    await json(batchPath, batch);
    const result = await analyzeProductBatch(f.directory, "files");
    expect(result.validity.issues).toContain("frozen_atlasHashes_mismatch");
    expect(result.validity.issues).toContain(
      "frozen_candidateSourceHash_mismatch"
    );
    expect(result.validity.issues).toHaveLength(2);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
}, 15_000);

test("a frozen FILE V3 pilot must use its exact preregistered schedule and schedule hash", async () => {
  const f = await archivalFixture("pilot");
  try {
    const frozen = join(f.root, "frozen");
    const manifestPath = join(frozen, "manifest.json");
    const batchPath = join(f.directory, "batch.json");
    const batch = JSON.parse(await readFile(batchPath, "utf8")) as Row;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Row;
    const schedule = batch.schedule as Row[];
    const different = [...schedule].reverse();
    await json(join(frozen, "pilot-schedule.json"), different);
    asRow(manifest.schedules).pilot = sha(JSON.stringify(different));
    await json(manifestPath, manifest);
    batch.manifestSha256 = sha(await readFile(manifestPath));
    await json(batchPath, batch);
    await json(
      join(
        f.root,
        "admissions",
        `live-pilot-${String(batch.candidateSourceHash)}.json`
      ),
      { batch: batch.batch, candidateSourceHash: batch.candidateSourceHash }
    );
    const mismatch = await analyzeProductBatch(f.directory, "files");
    expect(mismatch.validity.issues).toEqual(["frozen_schedule_mismatch"]);
    await json(join(frozen, "pilot-schedule.json"), schedule);
    asRow(manifest.schedules).pilot = sha(JSON.stringify(schedule));
    await json(manifestPath, manifest);
    batch.manifestSha256 = sha(await readFile(manifestPath));
    await json(batchPath, batch);
    expect(
      (await analyzeProductBatch(f.directory, "files")).validity.issues
    ).toEqual([]);
    asRow(manifest.schedules).pilot = sha("a wrong schedule hash");
    await json(manifestPath, manifest);
    batch.manifestSha256 = sha(await readFile(manifestPath));
    await json(batchPath, batch);
    expect(
      (await analyzeProductBatch(f.directory, "files")).validity.issues
    ).toEqual(["frozen_schedule_mismatch"]);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
}, 15_000);
