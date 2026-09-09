import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atlasSourceHashes,
  hermesSourceHashes,
  sha256,
  shuffle,
} from "../harness-compare/provenance";
import { evaluateMemoryTask, unknownMemoryExpectation } from "./memory-oracles";
import { MEMORY_SEEDS, memoryTaskInput, memoryTaskSet } from "./memory-tasks";
import {
  MEMORY_BUDGET,
  type MemoryCondition,
  type MemoryIdentity,
  type MemoryRunRequest,
  type MemoryRunResult,
  type MemorySplit,
  type MemoryTask,
} from "./memory-types";
import {
  createProductRuntimeIdentity,
  finalizeProductRuntimeIdentities,
} from "./product-identity";
import { modelMetadata, verifyModelEvidence } from "./product-model";
import { type ProductUsageEvidence, startProductProxy } from "./product-proxy";
import {
  type ComparisonRun,
  comparisonLimits,
  comparisonModel,
  upstreamEndpoint,
} from "./product-proxy-broker";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evaluationRoot = "/private/tmp/atlas-hermes-evaluation";
const hermesRoot = join(evaluationRoot, "source");
const python = join(evaluationRoot, "venv/bin/python");
const defaultStudyRoot = join(evaluationRoot, "memory-mimo-study-v1");
const protocolPath = "docs/architecture/hermes-memory-mimo-preregistration.md";
const conditions: readonly MemoryCondition[] = [
  "native-default",
  "explicit-memory",
];
const identityControls: readonly MemoryIdentity[] = [
  "different-user",
  "different-organization",
];
const sharedDependencies = [
  "scripts/harness-compare/provenance.ts",
  "scripts/harness-compare/tools.ts",
  "scripts/harness-compare/types.ts",
];
const safeCharacters = /^[a-zA-Z0-9_-]+$/;
const sourceFile =
  /^(?:memory[-_].+|product-(?:proxy|analysis|identity|model)(?:[-.].+)?)\.(?:ts|py|json)$/;
export const memoryShuffleSeed = 20_260_906;
export const memoryBootstrapSettings = {
  draws: 100_000,
  seed: 20_260_906,
} as const;
type Harness = "atlas" | "hermes";
type Phase = MemorySplit | "pilot";

export interface MemorySchedulePair {
  condition: MemoryCondition;
  family: MemoryTask["family"];
  order: [Harness, Harness];
  pairId: string;
  recallIdentity: MemoryIdentity;
  repetition: number;
  seed: number;
  stratum: "warm" | "cold" | "identity";
  taskId: string;
}

interface FrozenManifest {
  archives: Record<string, string>;
  atlasHashes: Record<string, string>;
  baselineSourceHash: string;
  bootstrap: typeof memoryBootstrapSettings;
  budget: typeof MEMORY_BUDGET;
  controlHashes: Record<string, string>;
  endpoint: string;
  frozenAt: string;
  hermesHashes: Record<string, string>;
  model: string;
  scheduleHashes: Record<MemorySplit, string>;
  taskHashes: Record<MemorySplit, string>;
}

function suite(split: MemorySplit): MemoryTask[] {
  return conditions.flatMap((condition) => memoryTaskSet(split, condition));
}

/** Balance first arm within condition/control blocks, then shuffle whole pairs. */
export function buildMemorySchedule(split: MemorySplit): MemorySchedulePair[] {
  const tasks = suite(split);
  const base: MemorySchedulePair[] = [];
  let blockIndex = 0;
  for (const condition of conditions) {
    const candidates = tasks.filter((task) => task.condition === condition);
    const blocks = [
      {
        identity: "same-owner" as const,
        stratum: "warm" as const,
        tasks: candidates,
      },
      {
        identity: "same-owner" as const,
        stratum: "cold" as const,
        tasks: candidates.filter((task) =>
          ["durable_fact", "implicit_preference"].includes(task.family)
        ),
      },
      ...identityControls.map((identity) => ({
        identity,
        stratum: "identity" as const,
        tasks: candidates.filter((task) => task.family === "durable_fact"),
      })),
    ];
    for (const block of blocks) {
      const ordered = shuffle(block.tasks, memoryShuffleSeed + blockIndex);
      for (const [index, task] of ordered.entries()) {
        const atlasFirst = (index + blockIndex) % 2 === 0;
        base.push({
          condition,
          family: task.family,
          order: atlasFirst ? ["atlas", "hermes"] : ["hermes", "atlas"],
          pairId: `${task.id.replaceAll("/", "-")}-${block.stratum}-${block.identity}`,
          recallIdentity: block.identity,
          repetition: 0,
          seed: task.seed,
          stratum: block.stratum,
          taskId: task.id,
        });
      }
      blockIndex += 1;
    }
  }
  const schedule: MemorySchedulePair[] = [];
  const repetitions = split === "confirmatory" ? 2 : 1;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const repeated = base.map(
      (pair): MemorySchedulePair => ({
        ...pair,
        order: repetition === 0 ? pair.order : [pair.order[1], pair.order[0]],
        pairId: `${pair.pairId}-r${repetition}`,
        repetition,
      })
    );
    schedule.push(...shuffle(repeated, memoryShuffleSeed + 100 + repetition));
  }
  if (new Set(schedule.map((pair) => pair.pairId)).size !== schedule.length) {
    throw new Error("Duplicate native-memory pair IDs.");
  }
  return schedule;
}

async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (true) {
    try {
      const existing = await realpath(ancestor);
      if (
        !(
          existing === "/private/tmp" ||
          existing.startsWith(`/private/tmp${sep}`)
        )
      ) {
        throw new Error(
          "Study artifacts and native state must be under /private/tmp."
        );
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(absolute, { recursive: true });
  const actual = await realpath(absolute);
  if (!actual.startsWith(`/private/tmp${sep}`)) {
    throw new Error(
      "Study artifacts and native state must be under /private/tmp."
    );
  }
  return actual;
}

async function jsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), { flag: "wx" });
}

async function ledger(directory: string, value: unknown): Promise<void> {
  await appendFile(
    join(directory, "attempts.jsonl"),
    `${JSON.stringify(value)}\n`
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function memoryControlHashes(): Promise<Record<string, string>> {
  await verifyModelEvidence();
  const directory = join(repository, "scripts/harness-native-mimo-v1");
  const paths = [
    protocolPath,
    ...sharedDependencies,
    ...(await readdir(directory))
      .filter((name) => sourceFile.test(name))
      .map((name) => `scripts/harness-native-mimo-v1/${name}`),
  ].sort();
  const result: Record<string, string> = {};
  for (const path of paths) {
    result[path] = sha256(await readFile(join(repository, path)));
  }
  return result;
}

async function sourceSnapshot() {
  const [atlasHashes, controlHashes, hermesHashes] = await Promise.all([
    atlasSourceHashes(repository),
    memoryControlHashes(),
    hermesSourceHashes(hermesRoot),
  ]);
  return {
    atlasHashes,
    candidateSourceHash: sha256(JSON.stringify(atlasHashes)),
    controlHashes,
    hermesHashes,
  };
}

async function archiveFiles(
  root: string,
  files: Record<string, string>,
  destination: string
): Promise<string> {
  const archive = Bun.spawn(["tar", "-czf", destination, "--null", "-T", "-"], {
    cwd: root,
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  archive.stdin.write(`${Object.keys(files).join("\0")}\0`);
  archive.stdin.end();
  const [stderr, , code] = await Promise.all([
    new Response(archive.stderr).text(),
    new Response(archive.stdout).text(),
    archive.exited,
  ]);
  if (code !== 0) {
    throw new Error(`Source archive failed: ${stderr}`);
  }
  return sha256(await readFile(destination));
}

async function archiveSnapshot(
  directory: string,
  snapshot: Awaited<ReturnType<typeof sourceSnapshot>>
) {
  const archives = {
    "atlas-source.tar.gz": await archiveFiles(
      repository,
      snapshot.atlasHashes,
      join(directory, "atlas-source.tar.gz")
    ),
    "hermes-source.tar.gz": await archiveFiles(
      hermesRoot,
      snapshot.hermesHashes,
      join(directory, "hermes-source.tar.gz")
    ),
    "memory-protocol-source.tar.gz": await archiveFiles(
      repository,
      snapshot.controlHashes,
      join(directory, "memory-protocol-source.tar.gz")
    ),
  };
  await jsonFile(join(directory, "source-archives.json"), archives);
  return archives;
}

function sameHashes(
  actual: Record<string, string>,
  expected: Record<string, string>,
  label: string
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} source inventory/content changed; this batch is invalid.`
    );
  }
}

function assertLimits(): void {
  if (
    !(
      MEMORY_BUDGET.maxGeneratedTokens === comparisonLimits.generatedTokens &&
      MEMORY_BUDGET.maxProviderRequests === comparisonLimits.providerRequests &&
      MEMORY_BUDGET.maxOutputTokens === comparisonLimits.perResponseTokens &&
      MEMORY_BUDGET.timeoutMs === comparisonLimits.timeoutMs
    )
  ) {
    throw new Error(
      "Memory protocol budget differs from authoritative proxy enforcement."
    );
  }
}

/** Calling this is an explicit freeze action. Importing this module does not freeze. */
export async function freezeMemoryStudy(
  studyRoot = defaultStudyRoot
): Promise<void> {
  assertLimits();
  const root = await privateDirectory(studyRoot);
  const directory = join(root, "frozen");
  await mkdir(directory); // Never overwrite or repair a partially written freeze.
  const snapshot = await sourceSnapshot();
  const tasks = {
    confirmatory: suite("confirmatory"),
    development: suite("development"),
  };
  const schedules = {
    confirmatory: buildMemorySchedule("confirmatory"),
    development: buildMemorySchedule("development"),
  };
  const protocol = await readFile(join(repository, protocolPath));
  for (const split of ["development", "confirmatory"] as const) {
    await jsonFile(join(directory, `${split}-tasks.json`), tasks[split]);
    await jsonFile(join(directory, `${split}-schedule.json`), schedules[split]);
  }
  await writeFile(join(directory, "protocol.md"), protocol, { flag: "wx" });
  const archives = await archiveSnapshot(directory, snapshot);
  const setup = await readFile(
    join(evaluationRoot, "setup-manifest.json"),
    "utf8"
  );
  const requirements = await readFile(
    join(evaluationRoot, "installed-requirements.txt")
  );
  await writeFile(
    join(directory, "hermes-installed-requirements.txt"),
    requirements,
    { flag: "wx" }
  );
  const manifest = {
    ...snapshot,
    archives,
    baselineSourceHash: snapshot.candidateSourceHash,
    bootstrap: memoryBootstrapSettings,
    budget: MEMORY_BUDGET,
    bunVersion: Bun.version,
    endpoint: upstreamEndpoint,
    frozenAt: new Date().toISOString(),
    hermesRequirementsSha256: sha256(requirements),
    hermesSetup: JSON.parse(setup),
    model: comparisonModel,
    modelMetadata: modelMetadata(),
    normalization: {
      maxOutputTokens: 4096,
      reasoning: "Upstream default; optional thinking/effort omitted upstream",
      streaming: false,
      temperature: 0.2,
    },
    protocolSha256: sha256(protocol),
    repetitions: { confirmatory: 2, development: 1 },
    scheduleHashes: {
      confirmatory: sha256(JSON.stringify(schedules.confirmatory)),
      development: sha256(JSON.stringify(schedules.development)),
    },
    seeds: MEMORY_SEEDS,
    shuffleSeed: memoryShuffleSeed,
    taskHashes: {
      confirmatory: sha256(JSON.stringify(tasks.confirmatory)),
      development: sha256(JSON.stringify(tasks.development)),
    },
  };
  const after = await sourceSnapshot();
  sameHashes(after.atlasHashes, snapshot.atlasHashes, "Atlas during freeze");
  sameHashes(
    after.controlHashes,
    snapshot.controlHashes,
    "Protocol during freeze"
  );
  sameHashes(after.hermesHashes, snapshot.hermesHashes, "Hermes during freeze");
  await jsonFile(join(directory, "manifest.json"), manifest);
  process.stdout.write(
    `${JSON.stringify({ directory, event: "memory-frozen", pairs: { confirmatory: schedules.confirmatory.length, development: schedules.development.length }, sourceHash: snapshot.candidateSourceHash })}\n`
  );
}

function pilotTasks(): MemoryTask[] {
  return conditions.map((condition) => ({
    condition,
    expected: { status: "READY" },
    family: "durable_fact",
    id: `memory-transport-pilot/${condition}`,
    recallTurns: [
      'What was the transport status word? Return only a JSON object with key "status"; use null if unknown.',
    ],
    seed: 0,
    split: "development",
    trainingTurns: [
      `For this transport check the status word is READY. Acknowledge briefly.${condition === "explicit-memory" ? " Retain this status through your native memory tools for a later conversation." : ""}`,
    ],
  }));
}

async function loadPlan(
  root: string,
  phase: Phase,
  offlinePilot = false
): Promise<{
  frozen: FrozenManifest | null;
  manifestPath: string | null;
  manifestSha256: string | null;
  schedule: MemorySchedulePair[];
  tasks: MemoryTask[];
}> {
  if (phase === "pilot") {
    const tasks = pilotTasks();
    const schedule = tasks.map(
      (task, index): MemorySchedulePair => ({
        condition: task.condition,
        family: task.family,
        order: index % 2 === 0 ? ["atlas", "hermes"] : ["hermes", "atlas"],
        pairId: `${task.id.replaceAll("/", "-")}-warm-same-owner-r0`,
        recallIdentity: "same-owner",
        repetition: 0,
        seed: 0,
        stratum: "warm",
        taskId: task.id,
      })
    );
    // A live transport pilot is still paid inference: require the same frozen
    // protocol admission. Only an explicitly injected offline transport bypasses it.
    const admission = offlinePilot ? null : await loadPlan(root, "development");
    return {
      frozen: admission?.frozen ?? null,
      manifestPath: admission?.manifestPath ?? null,
      manifestSha256: admission?.manifestSha256 ?? null,
      schedule,
      tasks,
    };
  }
  const directory = join(root, "frozen");
  const manifestPath = join(directory, "manifest.json");
  const raw = await readFile(manifestPath);
  const frozen = JSON.parse(raw.toString()) as FrozenManifest;
  for (const name of [
    "atlas-source.tar.gz",
    "memory-protocol-source.tar.gz",
    "hermes-source.tar.gz",
  ]) {
    if (
      sha256(await readFile(join(directory, name))) !== frozen.archives[name]
    ) {
      throw new Error(`Frozen source archive changed: ${name}`);
    }
  }
  const tasks: MemoryTask[] = JSON.parse(
    await readFile(join(directory, `${phase}-tasks.json`), "utf8")
  );
  const schedule: MemorySchedulePair[] = JSON.parse(
    await readFile(join(directory, `${phase}-schedule.json`), "utf8")
  );
  if (
    sha256(JSON.stringify(tasks)) !== frozen.taskHashes[phase] ||
    sha256(JSON.stringify(schedule)) !== frozen.scheduleHashes[phase] ||
    frozen.model !== comparisonModel ||
    frozen.endpoint !== upstreamEndpoint ||
    JSON.stringify(frozen.budget) !== JSON.stringify(MEMORY_BUDGET) ||
    JSON.stringify(tasks) !== JSON.stringify(suite(phase)) ||
    JSON.stringify(schedule) !== JSON.stringify(buildMemorySchedule(phase))
  ) {
    throw new Error("Frozen memory task/schedule/model manifest changed.");
  }
  return { frozen, manifestPath, manifestSha256: sha256(raw), schedule, tasks };
}

function emptyResult(
  input: MemoryRunRequest,
  harness: Harness,
  error: string
): MemoryRunResult {
  return {
    condition: input.condition,
    elapsedMs: 0,
    error,
    evidence: {},
    finalText: "",
    framework: harness,
    model: input.model,
    nativeEvents: [],
    runId: input.runId,
    sessions: [],
    snapshots: [],
    status: "failed",
  };
}

async function runAdapter(
  input: MemoryRunRequest,
  harness: Harness,
  directory: string,
  nativeRoot: string,
  startedAt: number
) {
  const inputPath = join(directory, "runner-input.json");
  await jsonFile(inputPath, input);
  const stdoutPath = join(directory, "runner-stdout.json");
  const stderrPath = join(directory, "runner-stderr.log");
  const stdout = await open(stdoutPath, "wx");
  const stderr = await open(stderrPath, "wx");
  const command =
    harness === "atlas"
      ? [
          process.execPath,
          join(
            repository,
            "scripts/harness-native-mimo-v1/memory-atlas-runner.ts"
          ),
        ]
      : [
          python,
          join(
            repository,
            "scripts/harness-native-mimo-v1/memory_hermes_runner.py"
          ),
        ];
  let invocationError: string | null = null;
  let timedOut = false;
  let exitCode = -1;
  try {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: nativeRoot,
      detached: true,
      env: {
        NO_COLOR: "1",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PYTHONDONTWRITEBYTECODE: "1",
        TMPDIR: "/private/tmp",
      },
      stdio: ["pipe", stdout.fd, stderr.fd],
    });
    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const remaining = Math.max(
      1,
      startedAt + MEMORY_BUDGET.timeoutMs - Date.now()
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
    }, remaining);
    const hardTimeout = setTimeout(
      () => terminate("SIGKILL"),
      remaining + 2000
    );
    try {
      const completion = new Promise<number>((accept) => {
        child.once("error", (error) => {
          invocationError = errorText(error);
          accept(-1);
        });
        child.once("close", (code) => accept(code ?? -1));
      });
      child.stdin?.on("error", (error) => {
        invocationError = errorText(error);
      });
      child.stdin?.end(JSON.stringify(input));
      exitCode = await completion;
    } finally {
      clearTimeout(timeout);
      clearTimeout(hardTimeout);
      if (timedOut) {
        terminate("SIGKILL");
      }
    }
  } catch (error) {
    invocationError = errorText(error);
  } finally {
    await stdout.close();
    await stderr.close();
  }
  let result: MemoryRunResult;
  try {
    result = JSON.parse(await readFile(stdoutPath, "utf8")) as MemoryRunResult;
    if (
      !(
        result.framework === harness &&
        result.runId === input.runId &&
        result.model === input.model &&
        result.condition === input.condition &&
        typeof result.finalText === "string" &&
        Array.isArray(result.sessions) &&
        Array.isArray(result.nativeEvents) &&
        Array.isArray(result.snapshots) &&
        ["completed", "failed", "budget_exceeded"].includes(result.status)
      )
    ) {
      throw new Error(
        "Adapter output does not match the requested run identity/result contract."
      );
    }
  } catch (error) {
    invocationError ??= errorText(error);
    result = emptyResult(input, harness, invocationError);
  }
  return {
    elapsedMs: Date.now() - startedAt,
    exitCode,
    invocationError,
    result,
    timedOut,
  };
}

interface BatchOptions {
  candidateLabel?: string;
  /** Offline fixture seam only. CLI never accepts a provider override. */
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  keyFile?: string;
  phase: Phase;
  studyRoot?: string;
}

export function memoryUsage(
  run: ComparisonRun | undefined,
  evidence: ProductUsageEvidence | undefined
) {
  return run
    ? {
        accountingUncertain: !evidence?.mandatoryUsageKnown,
        budgetExceeded: run.budgetExceeded,
        cachedTokens: evidence?.cachedTokens ?? null,
        costUsd: null,
        generatedTokens: evidence?.generatedTokens ?? null,
        missingUsage: run.missingUsage || !evidence?.mandatoryUsageKnown,
        observedGeneratedTokens:
          evidence?.observedGeneratedTokens ?? run.generatedTokens,
        observedPromptTokens:
          evidence?.observedPromptTokens ?? run.promptTokens,
        promptTokens: evidence?.promptTokens ?? null,
        providerRequests: run.providerRequests,
      }
    : null;
}

async function attempt(
  options: BatchOptions,
  context: {
    batch: string;
    candidateSourceHash: string;
    directory: string;
    harness: Harness;
    keyFile: string;
    nativeParent: string;
    pair: MemorySchedulePair;
    task: MemoryTask;
  }
) {
  const {
    batch,
    candidateSourceHash,
    directory,
    harness,
    keyFile,
    nativeParent,
    pair,
    task,
  } = context;
  const id = `${batch}-${pair.pairId}-${harness}`;
  if (!safeCharacters.test(id)) {
    throw new Error("Unsafe trial ID.");
  }
  const trialDirectory = join(directory, "trials", id);
  const { identity, identitySha256 } = await createProductRuntimeIdentity({
    attemptId: id,
    harness,
    nativeParent,
    pairId: pair.pairId,
    repetition: pair.repetition,
    taskId: task.id,
    trialDirectory,
  });
  const startedAt = Date.now();
  const start = {
    at: new Date(startedAt).toISOString(),
    candidateSourceHash,
    condition: pair.condition,
    event: "start",
    family: pair.family,
    harness,
    id,
    identitySha256,
    pairId: pair.pairId,
    phase: options.phase,
    recallIdentity: pair.recallIdentity,
    repetition: pair.repetition,
    seed: pair.seed,
    stratum: pair.stratum,
    taskId: task.id,
    transportId: identity.transportId,
  };
  await ledger(directory, start);
  let proxy: Awaited<ReturnType<typeof startProductProxy>> | undefined;
  let usageEvidence: ProductUsageEvidence | undefined;
  let endWritten = false;
  try {
    await mkdir(trialDirectory, { recursive: true });
    const nativeRoot = identity.nativeStateRoot;
    proxy = await startProductProxy({
      directory: join(trialDirectory, "wire"),
      fetchUpstream: options.fetchUpstream,
      harness,
      keyFile,
      runId: identity.transportId,
    });
    const input: MemoryRunRequest = {
      ...memoryTaskInput(task),
      budget: { ...MEMORY_BUDGET },
      coldControl: pair.stratum === "cold",
      model: comparisonModel,
      modelMetadata: modelMetadata(),
      proxyBaseUrl: proxy.url,
      recallIdentity: pair.recallIdentity,
      runId: identity.transportId,
      stateRoot: nativeRoot,
    };
    const execution = await runAdapter(
      input,
      harness,
      trialDirectory,
      nativeRoot,
      proxy.run.startedAt
    );
    if (execution.invocationError) {
      await ledger(directory, {
        ...start,
        at: new Date().toISOString(),
        event: "error",
        infrastructureError: execution.invocationError,
      });
    }
    usageEvidence = await proxy.finalize();
    const measured = proxy.run;
    const budgetExceeded =
      (measured.budgetExceeded && !measured.missingUsage) ||
      execution.timedOut ||
      execution.elapsedMs > MEMORY_BUDGET.timeoutMs ||
      measured.generatedTokens > MEMORY_BUDGET.maxGeneratedTokens ||
      measured.providerRequests > MEMORY_BUDGET.maxProviderRequests;
    measured.budgetExceeded = budgetExceeded;
    const status = budgetExceeded
      ? "budget_exceeded"
      : execution.exitCode === 0 &&
          !execution.invocationError &&
          usageEvidence.mandatoryUsageKnown
        ? execution.result.status
        : "failed";
    const observed = { ...execution.result, status };
    const expectation =
      pair.stratum === "warm" ? task.expected : unknownMemoryExpectation(task);
    const evaluation = evaluateMemoryTask(task, observed, expectation);
    const transferEvaluation =
      pair.stratum === "identity" ? evaluateMemoryTask(task, observed) : null;
    const record = {
      ...start,
      at: new Date().toISOString(),
      diagnosticOnly: pair.stratum === "identity",
      elapsedMs: execution.elapsedMs,
      evaluation,
      event: "end",
      exitCode: execution.exitCode,
      infrastructureError: execution.invocationError,
      nativeStateParent: nativeRoot,
      providerStatuses: measured.providerStatuses,
      status,
      totalAttemptElapsedMs: Date.now() - startedAt,
      transferEvaluation,
      transferredFacts: transferEvaluation
        ? Object.keys(task.expected).filter(
            (key) =>
              !(
                transferEvaluation.missingFacts.includes(key) ||
                transferEvaluation.wrongFacts.includes(key)
              )
          )
        : [],
      transportAdmitted: measured.providerRequests > 0,
      unavailable:
        measured.providerRequests === 0 && execution.invocationError !== null,
      usage: memoryUsage(measured, usageEvidence),
      usageEvidence,
    };
    await jsonFile(join(trialDirectory, "observation.json"), observed);
    await jsonFile(join(trialDirectory, "result.json"), record);
    await ledger(directory, record);
    endWritten = true;
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch (error) {
    if (endWritten) {
      throw error;
    }
    const infrastructureError = errorText(error);
    try {
      usageEvidence = await proxy?.finalize();
    } catch {
      // Preserve the original error. An absent final ledger remains unknown.
    }
    await ledger(directory, {
      ...start,
      at: new Date().toISOString(),
      event: "error",
      infrastructureError,
    });
    const record = {
      ...start,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      evaluation: null,
      event: "end",
      infrastructureError,
      providerStatuses: proxy?.run.providerStatuses ?? [],
      status: "failed",
      transportAdmitted: (proxy?.run.providerRequests ?? 0) > 0,
      unavailable: (proxy?.run.providerRequests ?? 0) === 0,
      usage: memoryUsage(proxy?.run, usageEvidence),
      usageEvidence,
    };
    await ledger(directory, record);
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } finally {
    try {
      await proxy?.close();
    } catch (error) {
      await ledger(directory, {
        ...start,
        at: new Date().toISOString(),
        event: "error",
        infrastructureError: errorText(error),
        stage: "proxy-close",
      });
    }
  }
}

/** No filtering, retrying, resuming, or live inference is implicit in this helper. */
export async function runMemoryBatch(options: BatchOptions): Promise<string> {
  assertLimits();
  if (options.fetchUpstream && options.phase !== "pilot") {
    throw new Error(
      "Scripted transport is permitted only for unscored pilots."
    );
  }
  const root = await privateDirectory(options.studyRoot ?? defaultStudyRoot);
  const plan = await loadPlan(
    root,
    options.phase,
    Boolean(options.fetchUpstream)
  );
  const snapshot = await sourceSnapshot();
  const keyFile = await realpath(
    options.keyFile ??
      process.env.HARNESS_KEY_FILE ??
      "/private/tmp/atlas-harness-private/opencode-key"
  );
  if (!keyFile.startsWith(`/private/tmp${sep}`)) {
    throw new Error(
      "Only a private temporary key file may be passed to the proxy."
    );
  }
  if (plan.frozen) {
    sameHashes(
      snapshot.controlHashes,
      plan.frozen.controlHashes,
      "Frozen memory protocol"
    );
    sameHashes(
      snapshot.hermesHashes,
      plan.frozen.hermesHashes,
      "Frozen Hermes"
    );
  }
  const batch = `${options.phase}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = join(root, "batches", batch);
  await mkdir(directory, { recursive: true });
  if (options.phase !== "pilot" || !options.fetchUpstream) {
    const admissions = await privateDirectory(join(root, "admissions"));
    const admissionId =
      options.phase === "confirmatory"
        ? "confirmatory"
        : `${options.phase}-${snapshot.candidateSourceHash}`;
    try {
      await jsonFile(join(admissions, `${admissionId}.json`), {
        at: new Date().toISOString(),
        batch,
        candidateSourceHash: snapshot.candidateSourceHash,
        manifestSha256: plan.manifestSha256,
        phase: options.phase,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          "This phase/candidate already has an admission. No implicit retry or reused confirmation is allowed; a new preregistered decision is required."
        );
      }
      throw error;
    }
  }
  const nativeParent = await privateDirectory(
    await mkdtemp("/private/tmp/agent-runtime-")
  );
  await jsonFile(join(directory, "candidate-source.json"), {
    ...snapshot,
    candidateLabel:
      options.candidateLabel ?? snapshot.candidateSourceHash.slice(0, 12),
  });
  await jsonFile(join(directory, "schedule.json"), {
    batch,
    bootstrap: memoryBootstrapSettings,
    budget: MEMORY_BUDGET,
    bunVersion: Bun.version,
    candidateSourceHash: snapshot.candidateSourceHash,
    manifestPath: plan.manifestPath,
    manifestSha256: plan.manifestSha256,
    model: comparisonModel,
    phase: options.phase,
    schedule: plan.schedule,
    scored: options.phase !== "pilot",
    shuffleSeed: memoryShuffleSeed,
    transportMode: options.fetchUpstream ? "offline-scripted" : "live",
  });
  await jsonFile(join(directory, "evaluator-tasks.json"), plan.tasks);
  process.stdout.write(
    `${JSON.stringify({ directory, event: "memory-batch-start", pairs: plan.schedule.length, phase: options.phase, scored: options.phase !== "pilot" })}\n`
  );
  try {
    await archiveSnapshot(directory, snapshot);
    for (const pair of plan.schedule) {
      sameHashes(
        await memoryControlHashes(),
        snapshot.controlHashes,
        "Memory protocol during batch"
      );
      const task = plan.tasks.find((entry) => entry.id === pair.taskId);
      if (!task) {
        throw new Error(`Missing scheduled task: ${pair.taskId}`);
      }
      for (const harness of pair.order) {
        await attempt(options, {
          batch,
          candidateSourceHash: snapshot.candidateSourceHash,
          directory,
          harness,
          keyFile,
          nativeParent,
          pair,
          task,
        });
      }
    }
    const after = await sourceSnapshot();
    sameHashes(after.atlasHashes, snapshot.atlasHashes, "Atlas during batch");
    sameHashes(
      after.controlHashes,
      snapshot.controlHashes,
      "Memory protocol during batch"
    );
    sameHashes(
      after.hermesHashes,
      snapshot.hermesHashes,
      "Hermes during batch"
    );
    if (
      plan.manifestPath &&
      sha256(await readFile(plan.manifestPath)) !== plan.manifestSha256
    ) {
      throw new Error("Frozen manifest changed during batch.");
    }
    const runtimeIdentitiesSha256 =
      await finalizeProductRuntimeIdentities(directory);
    await jsonFile(join(directory, "completed.json"), {
      at: new Date().toISOString(),
      candidateSourceHash: snapshot.candidateSourceHash,
      pairedTasks: plan.schedule.length,
      runtimeIdentitiesSha256,
      scheduledAttempts: plan.schedule.length * 2,
      sourceUnchanged: true,
    });
  } catch (error) {
    const reason = errorText(error);
    await ledger(directory, {
      at: new Date().toISOString(),
      event: "batch-error",
      reason,
    });
    await jsonFile(join(directory, "interrupted.json"), {
      at: new Date().toISOString(),
      reason,
    });
    throw error;
  }
  return directory;
}

if (import.meta.main) {
  const [command, ...arguments_] = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !(
        flag &&
        value &&
        ["--study-root", "--key-file", "--candidate-label"].includes(flag)
      ) ||
      values.has(flag)
    ) {
      throw new Error(
        "Use freeze|pilot|development|confirmatory with optional --study-root, --key-file, --candidate-label pairs."
      );
    }
    values.set(flag, value);
  }
  if (command === "freeze") {
    await freezeMemoryStudy(values.get("--study-root"));
  } else if (
    command === "pilot" ||
    command === "development" ||
    command === "confirmatory"
  ) {
    await runMemoryBatch({
      candidateLabel: values.get("--candidate-label"),
      keyFile: values.get("--key-file"),
      phase: command,
      studyRoot: values.get("--study-root"),
    });
  } else {
    throw new Error(
      "Usage: bun scripts/harness-native-mimo-v1/memory-run.ts freeze|pilot|development|confirmatory"
    );
  }
}
