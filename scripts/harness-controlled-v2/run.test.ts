import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { bootstrapSettings, sha256 } from "../harness-compare/provenance";
import {
  comparisonLimits,
  comparisonModel,
  upstreamEndpoint,
} from "../harness-compare/proxy";
import { object } from "./accounting";
import { analyzePhase } from "./analysis";
import {
  archiveSnapshot,
  buildSchedule,
  repository,
  type SourceSnapshot,
  suite,
} from "./provenance";
import { runBatch } from "./run";
import { CONTROLLED_V2_VERSION } from "./tasks";

/** Synthetic evidence validation only: does not call freezeStudy or a provider. */
async function analysisFixture(original: string) {
  const root = await mkdtemp("/private/tmp/v2-synthetic-analysis-fixture-");
  const directory = join(root, "batches", basename(original));
  const frozen = join(root, "frozen");
  await cp(original, directory, { recursive: true });
  await mkdir(frozen);
  await mkdir(join(root, "admissions"));
  const candidate = JSON.parse(
    await readFile(join(directory, "candidate-source.json"), "utf8")
  ) as SourceSnapshot;
  const schedule = JSON.parse(
    await readFile(join(directory, "schedule.json"), "utf8")
  );
  const tasks = JSON.parse(
    await readFile(join(directory, "evaluator-tasks.json"), "utf8")
  );
  const archives = JSON.parse(
    await readFile(join(directory, "archives.json"), "utf8")
  );
  for (const name of [...Object.keys(archives), "archives.json"]) {
    await cp(join(directory, name), join(frozen, name));
  }
  const protocol = await readFile(
    join(repository, "scripts/harness-controlled-v2/protocol.md")
  );
  await writeFile(join(frozen, "protocol.md"), protocol);
  await writeFile(
    join(frozen, "runtime.json"),
    JSON.stringify({ syntheticEvidenceFixtureOnly: true })
  );
  await writeFile(join(frozen, "pilot-tasks.json"), JSON.stringify(tasks));
  await writeFile(
    join(frozen, "pilot-schedule.json"),
    JSON.stringify(schedule.schedule)
  );
  const manifest = {
    ...candidate,
    archives,
    bootstrapSettings,
    endpoint: upstreamEndpoint,
    limits: comparisonLimits,
    model: comparisonModel,
    protocolSha256: sha256(protocol),
    runtimeSha256: sha256(await readFile(join(frozen, "runtime.json"))),
    scheduleHashes: { pilot: sha256(JSON.stringify(schedule.schedule)) },
    syntheticEvidenceFixtureOnly: true,
    taskHashes: { pilot: sha256(JSON.stringify(tasks)) },
    version: CONTROLLED_V2_VERSION,
  };
  const manifestPath = join(frozen, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  schedule.manifestPath = manifestPath;
  schedule.manifestSha256 = sha256(await readFile(manifestPath));
  // This explicitly labeled fixture simulates admission metadata; its phase is always unscored pilot.
  schedule.transportMode = "live";
  schedule.syntheticEvidenceFixtureOnly = true;
  await writeFile(join(directory, "schedule.json"), JSON.stringify(schedule));
  const admission = {
    batch: schedule.session,
    candidateSourceHash: schedule.candidateSourceHash,
    manifestSha256: schedule.manifestSha256,
    syntheticEvidenceFixtureOnly: true,
  };
  const admissionPath = join(
    root,
    "admissions",
    `pilot-${schedule.candidateSourceHash}.json`
  );
  await writeFile(admissionPath, JSON.stringify(admission));
  return { admission, admissionPath, candidate, directory, root, schedule };
}

async function validateEvidenceMutations(original: string) {
  const fixture = await analysisFixture(original);
  const valid = await analyzePhase(fixture.directory);
  expect(valid.validity).toEqual({ issues: [], valid: true });
  expect(valid.decision.classification).toBe("exploratory_only");
  await writeFile(
    fixture.admissionPath,
    JSON.stringify({ ...fixture.admission, batch: "wrong-admission" })
  );
  expect(
    (await analyzePhase(fixture.directory)).validity.issues.some((issue) =>
      issue.includes("unique phase admission")
    )
  ).toBe(true);
  await writeFile(fixture.admissionPath, JSON.stringify(fixture.admission));
  const ledgerPath = join(fixture.directory, "attempts.jsonl");
  const originalLedger = await readFile(ledgerPath, "utf8");
  const records = originalLedger
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)));
  const starts = records.filter((record) => record.event === "start");
  starts[0]!.harness = "hermes";
  await writeFile(
    ledgerPath,
    records.map((record) => JSON.stringify(record)).join("\n")
  );
  const badOrder = await analyzePhase(fixture.directory);
  expect(
    badOrder.validity.issues.some((issue) =>
      issue.includes("adjacent-pair schedule")
    )
  ).toBe(true);
  expect(
    badOrder.validity.issues.some((issue) => issue.includes("End attribution"))
  ).toBe(true);
  await writeFile(ledgerPath, originalLedger);
  // A newly checksummed tar can still carry the wrong source members; member identity must catch it.
  const alternate = join(fixture.root, "alternate-archives");
  await mkdir(alternate);
  const changed = await archiveSnapshot(alternate, {
    ...fixture.candidate,
    atlasHashes: {
      "package.json": fixture.candidate.atlasHashes["package.json"]!,
    },
  });
  await cp(
    join(alternate, "atlas-source.tar.gz"),
    join(fixture.directory, "atlas-source.tar.gz")
  );
  const archives = JSON.parse(
    await readFile(join(fixture.directory, "archives.json"), "utf8")
  );
  archives["atlas-source.tar.gz"] = changed["atlas-source.tar.gz"];
  await writeFile(
    join(fixture.directory, "archives.json"),
    JSON.stringify(archives)
  );
  expect(
    (await analyzePhase(fixture.directory)).validity.issues.some((issue) =>
      issue.includes("Archive members do not match")
    )
  ).toBe(true);
  process.stdout.write(
    `${JSON.stringify({ evidence: fixture.directory, syntheticEvidenceFixtureOnly: true })}\n`
  );
}

test("live pilot cannot access credentials or run before an explicit freeze", async () => {
  const root = await mkdtemp("/private/tmp/v2-unfrozen-admission-");
  await expect(
    runBatch({
      keyFile: join(root, "must-not-be-read"),
      phase: "pilot",
      studyRoot: root,
    })
  ).rejects.toThrow("manifest.json");
  await expect(
    runBatch({
      fetchUpstream: async () => new Response(),
      phase: "development",
      studyRoot: root,
    })
  ).rejects.toThrow("unscored pilots");
});

test("complete development schedule is deterministic, balanced and adjacent", () => {
  const tasks = suite("development");
  const schedule = buildSchedule(tasks, "development");
  expect(schedule).toHaveLength(36);
  expect(schedule).toEqual(buildSchedule(tasks, "development"));
  expect(new Set(schedule.map((entry) => entry.taskId)).size).toBe(36);
  expect(schedule.filter((entry) => entry.order[0] === "atlas")).toHaveLength(
    18
  );
  expect(schedule.every((entry) => new Set(entry.order).size === 2)).toBe(true);
  // The repetition algorithm is independent of holdout fixture contents.
  const repeated = buildSchedule(tasks, "confirmatory");
  expect(
    repeated
      .slice(36)
      .every(
        (entry, index) =>
          entry.taskId === schedule[index]!.taskId &&
          entry.order[0] !== schedule[index]!.order[0]
      )
  ).toBe(true);
});

function scriptedTransport(missingUsage = false) {
  const requests = new Map<string, number>();
  return async (url: string, init: RequestInit): Promise<Response> => {
    if (url !== `${upstreamEndpoint}/chat/completions`) {
      throw new Error("Unexpected upstream target in offline fixture.");
    }
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== "Bearer offline-placeholder") {
      throw new Error("Offline fixture received an unexpected credential.");
    }
    const runId = headers.get("x-opencode-session")!;
    const index = (requests.get(runId) ?? 0) + 1;
    requests.set(runId, index);
    const body = object(JSON.parse(String(init.body)));
    const schemas = body.tools as Array<{ function: { name: string } }>;
    const name = index === 1 ? "read_file" : "write_file";
    const tool = !missingUsage && index <= 2;
    if (tool && !schemas.some((schema) => schema.function.name === name)) {
      throw new Error(`Native runner omitted ${name}.`);
    }
    const message = tool
      ? {
          content: null,
          reasoning_content: "Offline transport fixture only.",
          role: "assistant",
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify(
                  index === 1
                    ? { path: "input.txt" }
                    : {
                        content: '{"status":"READY"}',
                        path: "artifacts/pilot.json",
                      }
                ),
                name,
              },
              id: `scripted-${index}`,
              type: "function",
            },
          ],
        }
      : { content: '{"status":"READY"}', role: "assistant" };
    return Response.json({
      choices: [
        { finish_reason: tool ? "tool_calls" : "stop", index: 0, message },
      ],
      created: 1,
      id: `offline-${index}`,
      model: comparisonModel,
      object: "chat.completion",
      ...(missingUsage
        ? {}
        : {
            usage: {
              completion_tokens: 5,
              prompt_tokens: 20,
              total_tokens: 25,
            },
          }),
    });
  };
}

test("actual stock Atlas and Hermes loops finish a retained offline pilot with isolated state and complete evidence", async () => {
  const root = await mkdtemp("/private/tmp/v2-native-offline-pilot-");
  const keyFile = join(root, "placeholder-key");
  await writeFile(keyFile, "offline-placeholder", { mode: 0o600 });
  const directory = await runBatch({
    fetchUpstream: scriptedTransport(),
    keyFile,
    phase: "pilot",
    studyRoot: root,
  });
  const ledger = (await readFile(join(directory, "attempts.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)));
  const ended = ledger.filter((record) => record.event === "end");
  expect(ledger.filter((record) => record.event === "start")).toHaveLength(2);
  expect(ended).toHaveLength(2);
  for (const record of ended) {
    expect(record.status).toBe("completed");
    expect(object(record.evaluation).pass).toBe(true);
    expect(object(record.usage)).toMatchObject({
      cachedTokens: null,
      generatedTokens: 15,
      providerRequests: 3,
      withinBudgetCertified: true,
    });
    expect(
      String(record.nativeStateRoot).startsWith(join(root, "native-state"))
    ).toBe(true);
    const trial = join(directory, "trials", String(record.id));
    const input = await readFile(join(trial, "runner-input.json"), "utf8");
    expect(input).not.toContain("offline-placeholder");
    expect(input).not.toContain('"expected"');
    expect(
      (await readFile(join(trial, "runner-stdout.json"))).length
    ).toBeGreaterThan(100);
    expect(
      await readFile(join(trial, "wire/workspace/artifacts/pilot.json"), "utf8")
    ).toBe('{"status":"READY"}');
  }
  expect(new Set(ended.map((record) => record.nativeStateRoot)).size).toBe(2);
  expect(
    JSON.parse(await readFile(join(directory, "completed.json"), "utf8"))
      .sourceUnchanged
  ).toBe(true);
  const summary = await analyzePhase(directory);
  expect(summary.intentionToRun.counts.bothPass).toBe(1);
  expect(summary.decision.classification).toBe("invalid");
  expect(
    summary.validity.issues.some((issue) =>
      issue.includes("offline pilot is unscored")
    )
  ).toBe(true);
  await validateEvidenceMutations(directory);
  process.stdout.write(
    `${JSON.stringify({ evidence: directory, offlineOnly: true })}\n`
  );
}, 90_000);

test("actual native terminal replies with missing usage remain failed without inferred overruns", async () => {
  const root = await mkdtemp("/private/tmp/v2-native-unknown-usage-");
  const keyFile = join(root, "placeholder-key");
  await writeFile(keyFile, "offline-placeholder", { mode: 0o600 });
  const directory = await runBatch({
    fetchUpstream: scriptedTransport(true),
    keyFile,
    phase: "pilot",
    studyRoot: root,
  });
  const ended = (await readFile(join(directory, "attempts.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)))
    .filter((record) => record.event === "end");
  expect(ended).toHaveLength(2);
  for (const record of ended) {
    expect(record.status).toBe("failed");
    expect(record.rawTerminalStatus).toBe("completed");
    expect(object(record.usage)).toMatchObject({
      budgetExceeded: false,
      generatedTokens: null,
      providerRequests: 1,
      withinBudgetCertified: false,
    });
    expect(object(record.evaluation).pass).toBe(false);
  }
  process.stdout.write(
    `${JSON.stringify({ evidence: directory, offlineOnly: true })}\n`
  );
}, 90_000);
