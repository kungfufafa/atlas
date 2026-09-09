import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../harness-compare/provenance";
import {
  FILE_BUDGET,
  type FileSchedulePair,
  filePython,
  materializeFileSchedule,
  persistFileSourceAssignment,
  prepareFilePair,
  runFileAttempt,
} from "./file-run";
import { finalizeProductRuntimeIdentities } from "./product-identity";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceRoot =
  process.env.ATLAS_V3_CALLER_EVIDENCE ??
  "/private/tmp/atlas-native-file-v3-control-integration/caller-evidence";
await mkdir(evidenceRoot, { recursive: true });
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
async function fixture(
  mode: string,
  harness: "atlas" | "hermes" = "atlas",
  completePair = false
) {
  const directory = await mkdtemp(join(evidenceRoot, `${mode}-${harness}-`));
  const batch = "offline-fixture";
  const pair: FileSchedulePair = {
    family: "csv_join",
    order: ["atlas", "hermes"],
    pairId: "csv_join-v999-r0",
    repetition: 0,
    split: "development",
    variant: 999,
  };
  const scheduledArmsSha256 = await materializeFileSchedule(directory, batch, [
    pair,
  ]);
  const prepared = await prepareFilePair(
    join(directory, "pairs", pair.pairId),
    pair
  );
  const sourceAssignment = await persistFileSourceAssignment(
    directory,
    pair,
    prepared
  );
  const nativeParent = await mkdtemp("/private/tmp/agent-runtime-");
  const keyFile = join(directory, "synthetic-key");
  await writeFile(keyFile, "offline-fixture-no-real-credential");
  const source = {
    atlasHashes: {},
    candidateSourceHash: sha256("explicit-unscored-fixture"),
    controlHashes: {},
    hermesHashes: {},
  };
  await writeFile(
    join(directory, "batch.json"),
    JSON.stringify({
      batch,
      budget: FILE_BUDGET,
      measurementVersion: 3,
      model: "mimo-v2.5",
      phase: "pilot",
      schedule: [pair],
      scheduledArmsSha256,
      transportMode: "offline-scripted",
      ...source,
    })
  );
  for (const selectedHarness of completePair ? pair.order : [harness]) {
    await runFileAttempt(
      {
        fetchUpstream: async () =>
          Response.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "fixture", role: "assistant" },
              },
            ],
            ...(mode === "unknown-usage"
              ? {}
              : { usage: { completion_tokens: 2, prompt_tokens: 3 } }),
          }),
        phase: "pilot",
      },
      {
        batch,
        directory,
        expectedContractHash: "0".repeat(64),
        expectedPolicyHash: "0".repeat(64),
        harness: selectedHarness,
        keyFile,
        nativeParent,
        offlineNativeFixture: {
          args: [join(here, "file-control-fixture.py"), mode, selectedHarness],
          command: filePython,
          parentPersistenceDelayMs: mode === "parent-delay" ? 350 : undefined,
          timeoutMs:
            mode === "timeout" ? 150 : mode === "parent-delay" ? 300 : 10_000,
        },
        pair,
        prepared,
        source,
        sourceAssignment,
      }
    );
  }
  const runtimeIdentitiesSha256 =
    await finalizeProductRuntimeIdentities(directory);
  await writeFile(
    join(directory, "completed.json"),
    JSON.stringify({
      pairedTasks: 1,
      runtimeIdentitiesSha256,
      scheduledArmsSha256,
      scheduledAttempts: 2,
      sourceUnchanged: true,
    })
  );
  const trial = join(directory, "trials", `${batch}-${pair.pairId}-${harness}`);
  const result = await json(join(trial, "result.json"));
  const invocation = await json(join(trial, "invocation.json"));
  const callerReturn = await json(join(trial, "caller-return.json"));
  const processOutcome = await json(
    join(trial, "process/process-outcome.json")
  );
  await writeFile(
    join(directory, "fixture-receipt.json"),
    JSON.stringify({
      claimedFullBatch: completePair,
      directory,
      harness,
      mode,
      nativeParent,
      synthetic: true,
      trial,
    })
  );
  return { callerReturn, directory, invocation, processOutcome, result, trial };
}

for (const mode of [
  "empty",
  "broken",
  "partial",
  "missing-id",
  "foreign-id",
  "timeout",
  "nonzero",
  "unknown-usage",
]) {
  test(`actual caller preserves ${mode} as a failed scheduled arm`, async () => {
    const f = await fixture(mode);
    expect(f.result.success).toBe(false);
    expect(f.result.status).not.toBe("completed");
    expect(f.processOutcome.expected.transportId).toBe(f.result.transportId);
    expect(f.processOutcome.receiptComplete).toBe(true);
    expect(f.invocation.attemptStarted.monotonicMs).toBeLessThanOrEqual(
      f.invocation.invocationStarted.monotonicMs
    );
    expect(f.callerReturn.outerInvocationElapsedMs).toBeGreaterThanOrEqual(
      f.processOutcome.elapsedMonotonicMs
    );
    expect(
      f.invocation.deadline.atMonotonicMs -
        f.invocation.attemptStarted.monotonicMs
    ).toBe(mode === "timeout" ? 150 : 10_000);
    if (
      [
        "empty",
        "broken",
        "partial",
        "missing-id",
        "foreign-id",
        "timeout",
      ].includes(mode)
    ) {
      expect(await readFile(join(f.trial, "observation.json"), "utf8")).toBe(
        "null"
      );
      expect(f.result.evaluation.oracle).toBeNull();
    }
    if (mode === "foreign-id") {
      expect(f.processOutcome.native.identity).toBe("conflict");
    }
    if (mode === "missing-id") {
      expect(f.processOutcome.native.identity).toBe("unavailable");
    }
    if (mode === "nonzero") {
      expect(f.processOutcome.exit.code).toBe(7);
    }
    if (mode === "timeout") {
      expect(f.processOutcome.timedOut).toBe(true);
      expect(() => process.kill(f.processOutcome.pid, 0)).toThrow();
    }
    if (mode === "unknown-usage") {
      expect(f.result.status).toBe("accounting_uncertain");
      expect(f.result.usage.generatedTokens).toBeNull();
      expect(f.result.usage.mandatoryUsageKnown).toBe(false);
    }
  }, 20_000);
}
for (const harness of ["atlas", "hermes"] as const) {
  test(`actual caller ${harness} positive control retains raw identity, broker usage and exact CSV oracle`, async () => {
    const f = await fixture("success", harness);
    expect(f.result.success).toBe(true);
    expect(f.result.evaluation.oracle.pass).toBe(true);
    expect(f.result.usage.generatedTokens).toBe(2);
    expect(f.result.usage.promptTokens).toBe(3);
    expect(f.result.usageEvidence.finalized).toBe(true);
    expect(f.result.inspectionAllowed).toBe(true);
    expect(f.processOutcome.processFailure).toBe(false);
    expect(await readFile(join(f.trial, "observation.json"))).toEqual(
      await readFile(join(f.trial, "process/runner-stdout.json"))
    );
    expect(f.result.processEvidence.invocation.sha256).toBe(
      sha256(await readFile(join(f.trial, "invocation.json")))
    );
  }, 20_000);
}

test("actual caller includes delayed parent evidence persistence in the deadline boundary", async () => {
  const f = await fixture("parent-delay");
  expect(f.processOutcome.processFailure).toBe(false);
  expect(f.processOutcome.native.reportedStatus).toBe("completed");
  expect(f.invocation.processHelperReturned.monotonicMs).toBeLessThan(
    f.invocation.deadline.atMonotonicMs
  );
  expect(f.callerReturn.callerInvocationReturned.monotonicMs).toBeGreaterThan(
    f.invocation.deadline.atMonotonicMs
  );
  expect(f.result.elapsedMs).toBe(f.callerReturn.outerInvocationElapsedMs);
  expect(f.result.status).toBe("budget_exceeded");
  expect(f.result.success).toBe(false);
  expect(f.result.inspectionAllowed).toBe(true);
  expect(f.result.evaluation.oracle.pass).toBe(true);
}, 20_000);

test("complete scheduled pair retains both caller lifecycles and shared exact source assignment", async () => {
  const f = await fixture("success", "atlas", true);
  const rows = (await readFile(join(f.directory, "attempts.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.event === "start")).toHaveLength(2);
  const ends = rows.filter((row) => row.event === "end");
  expect(ends).toHaveLength(2);
  expect(ends.every((row) => row.success)).toBe(true);
  expect(ends[0].sourceAssignment).toEqual(ends[1].sourceAssignment);
  expect(ends[0].identitySha256).not.toBe(ends[1].identitySha256);
  expect(ends[0].transportId).not.toBe(ends[1].transportId);
  await writeFile(
    join(evidenceRoot, "complete-pair-path.json"),
    JSON.stringify({ directory: f.directory })
  );
}, 20_000);

test("synthetic native commands cannot enter a scored caller before identity or process effects", async () => {
  const directory = await mkdtemp(join(evidenceRoot, "denied-fixture-"));
  const pair: FileSchedulePair = {
    family: "csv_join",
    order: ["atlas", "hermes"],
    pairId: "denied-v999-r0",
    repetition: 0,
    split: "development",
    variant: 999,
  };
  await expect(
    runFileAttempt(
      {
        fetchUpstream: async () => {
          throw new Error("must not be called");
        },
        phase: "development",
      },
      {
        batch: "offline-denied",
        directory,
        expectedContractHash: "0".repeat(64),
        expectedPolicyHash: "0".repeat(64),
        harness: "atlas",
        keyFile: join(directory, "nonexistent-key"),
        nativeParent: join(directory, "nonexistent-native"),
        offlineNativeFixture: {
          args: [join(here, "file-control-fixture.py"), "success", "atlas"],
          command: filePython,
        },
        pair,
        prepared: null,
        source: {
          atlasHashes: {},
          candidateSourceHash: "0".repeat(64),
          controlHashes: {},
          hermesHashes: {},
        },
        sourceAssignment: null,
      }
    )
  ).rejects.toThrow("unscored offline pilot");
  await expect(readFile(join(directory, "attempts.jsonl"))).rejects.toThrow();
});

test("Hermes native inspection remains distinct from a late caller primary failure", async () => {
  const f = await fixture("parent-delay", "hermes");
  expect(f.processOutcome.processFailure).toBe(false);
  expect(f.invocation.processHelperReturned.monotonicMs).toBeLessThan(
    f.invocation.deadline.atMonotonicMs
  );
  expect(f.callerReturn.callerInvocationReturned.monotonicMs).toBeGreaterThan(
    f.invocation.deadline.atMonotonicMs
  );
  expect(f.result.status).toBe("budget_exceeded");
  expect(f.result.success).toBe(false);
  expect(f.result.inspectionAllowed).toBe(true);
  expect(f.result.evaluation.oracle.pass).toBe(true);
}, 20_000);

test("duplicate native source-copy receipts cannot certify identical assigned inputs", async () => {
  const f = await fixture("duplicate-source");
  expect(f.processOutcome.processFailure).toBe(false);
  expect(f.result.status).toBe("completed");
  expect(f.result.inputIdentical).toBe(false);
  expect(f.result.success).toBe(false);
}, 20_000);

test("post-process selection failure retains already computed parent and native evidence", async () => {
  const f = await fixture("invalid-metadata");
  expect(f.processOutcome.processFailure).toBe(false);
  expect(f.result.status).toBe("failed");
  expect(f.result.success).toBe(false);
  expect(f.result.evaluation).toBeNull();
  expect(f.result.inputIdentical).toBe(true);
  expect(f.result.boundaryValid).toBe(true);
  expect(f.result.inspectionAllowed).toBe(true);
  expect(f.result.processEvidence.callerReturn.sha256).toBe(
    sha256(await readFile(join(f.trial, "caller-return.json")))
  );
  expect(f.result.usageEvidence.finalized).toBe(true);
}, 20_000);
