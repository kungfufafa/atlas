import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTask } from "./oracles";
import {
  assertFrozenFiles,
  atlasSourceHashes,
  bootstrapSettings,
  sha256 as digest,
  harnessSourceHashes,
  hermesSourceHashes,
  shuffle,
  shuffleSeed,
} from "./provenance";
import {
  type ComparisonRun,
  comparisonLimits,
  comparisonModel,
  startComparisonProxy,
  upstreamEndpoint,
} from "./proxy";
import { buildTaskSuite } from "./tasks";
import type { HarnessTask, TaskObservation } from "./types";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = "/private/tmp/atlas-hermes-evaluation";
const python = join(root, "venv/bin/python");
const manifestDir = join(root, "frozen-v1");

async function freeze(): Promise<void> {
  await mkdir(manifestDir, { recursive: true });
  const sourceHashes = await atlasSourceHashes(repository);
  const harnessHashes = await harnessSourceHashes(repository);
  const hermesHashes = await hermesSourceHashes(join(root, "source"));
  const suites = {
    development: buildTaskSuite("development"),
    holdout: buildTaskSuite("holdout"),
  };
  const protocol = await readFile(
    join(repository, "docs/architecture/hermes-comparison-preregistration.md"),
    "utf8"
  );
  const sourceHash = digest(JSON.stringify(sourceHashes));
  const manifest = {
    bootstrapSettings,
    bunVersion: Bun.version,
    endpoint: upstreamEndpoint,
    frozenAt: new Date().toISOString(),
    harnessHashes,
    hermes: JSON.parse(
      await readFile(join(root, "setup-manifest.json"), "utf8")
    ),
    hermesHashes,
    limits: comparisonLimits,
    model: comparisonModel,
    normalization: {
      maxTokensPerRequest: 4096,
      reasoning: "upstream default; no thinking/effort parameters",
      streaming: false,
      temperature: 0.2,
    },
    protocolSha256: digest(protocol),
    repetitions: { development: 1, holdout: 2 },
    shuffleSeed,
    sourceHash,
    sourceHashes,
    taskHashes: Object.fromEntries(
      Object.entries(suites).map(([split, tasks]) => [
        split,
        digest(JSON.stringify(tasks)),
      ])
    ),
  };
  for (const [split, tasks] of Object.entries(suites)) {
    await writeFile(
      join(manifestDir, `${split}.json`),
      JSON.stringify(tasks, null, 2),
      { flag: "wx" }
    );
  }
  await writeFile(join(manifestDir, "protocol.md"), protocol, { flag: "wx" });
  await writeFile(
    join(manifestDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx" }
  );
  const archive = Bun.spawn(
    [
      "tar",
      "-czf",
      join(manifestDir, "atlas-baseline-source.tar.gz"),
      "--null",
      "-T",
      "-",
    ],
    { cwd: repository, stderr: "pipe", stdin: "pipe", stdout: "pipe" }
  );
  archive.stdin.write(`${Object.keys(sourceHashes).join("\0")}\0`);
  archive.stdin.end();
  const archiveError = await new Response(archive.stderr).text();
  if (await archive.exited) {
    throw new Error(`Baseline archive failed: ${archiveError}`);
  }
  process.stdout.write(
    `${JSON.stringify({ event: "frozen", path: manifestDir, sourceHash, tasks: { development: suites.development.length, holdout: suites.holdout.length } })}\n`
  );
}

function pilotTask(): HarnessTask {
  const prompt =
    'Transport pilot: read input.txt, create artifacts/pilot.json containing {"status":"READY"}, then finish with {"status":"READY"}. Preserve input.txt.';
  return {
    category: "file_transformation",
    expected: {
      artifacts: [
        {
          format: "json",
          path: "artifacts/pilot.json",
          value: { status: "READY" },
        },
      ],
      finalFacts: { status: "READY" },
      requiredReadPaths: ["input.txt"],
    },
    family: "transport-pilot",
    id: "transport:pilot",
    initialFiles: { "input.txt": "READY\n" },
    prompt,
    seed: 0,
    split: "development",
    turns: [prompt],
  };
}

function runnerInput(
  run: ComparisonRun,
  serverBaseUrl: string
): Record<string, unknown> {
  if (run.harness === "atlas") {
    return {
      model: comparisonModel,
      modelMetadata: {
        entry: {
          capabilities: {
            "chat.tool-use": {
              source: "runtime-probe",
              status: "supported",
              verified: true,
              verifiedAt: "2026-09-06T11:46:58.189Z",
            },
          },
          id: comparisonModel,
        },
        evidence: {
          endpoint: upstreamEndpoint,
          model: comparisonModel,
          observedAt: "2026-09-06T11:46:58.189Z",
          source:
            "Actual HTTP200 structured echo tool call; transport pilot preserved separately.",
        },
      },
      runId: run.id,
      serverBaseUrl,
      stream: false,
      timeoutMs: comparisonLimits.timeoutMs,
      turns: run.task.turns,
    };
  }
  return {
    base_url: `${serverBaseUrl}/runs/${run.id}/v1`,
    max_iterations: comparisonLimits.providerRequests,
    max_tokens: comparisonLimits.perResponseTokens,
    model: comparisonModel,
    run_id: run.id,
    streaming: false,
    temperature: 0.2,
    timeout_seconds: comparisonLimits.timeoutMs / 1000,
    tool_base_url: `${serverBaseUrl}/runs/${run.id}`,
    tool_schema_url: `${serverBaseUrl}/tool-schemas`,
    turns: run.task.turns,
    workspace: run.workspace,
  };
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function observeOutput(
  harness: ComparisonRun["harness"],
  output: Record<string, unknown>
): Pick<TaskObservation, "finalText" | "terminalStatus"> {
  if (harness === "atlas") {
    return {
      finalText: typeof output.finalText === "string" ? output.finalText : "",
      terminalStatus: output.status === "completed" ? "completed" : "failed",
    };
  }
  const result = getRecord(output.result);
  return {
    finalText:
      typeof result.final_response === "string" ? result.final_response : "",
    terminalStatus:
      result.completed === true &&
      output.completed_turns === output.requested_turns
        ? "completed"
        : "failed",
  };
}

async function execute(run: ComparisonRun, serverBaseUrl: string) {
  const input = runnerInput(run, serverBaseUrl);
  await writeFile(
    join(run.directory, "runner-input.json"),
    JSON.stringify(input, null, 2),
    { flag: "wx" }
  );
  const command =
    run.harness === "atlas"
      ? [
          process.execPath,
          join(repository, "scripts/harness-compare/atlas-runner.ts"),
        ]
      : [python, join(repository, "scripts/harness-compare/hermes_runner.py")];
  const child = Bun.spawn(command, {
    cwd: run.directory,
    env: {
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PYTHONDONTWRITEBYTECODE: "1",
      TMPDIR: "/private/tmp",
    },
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  const timeout = setTimeout(() => {
    run.budgetExceeded = true;
    child.kill("SIGTERM");
  }, comparisonLimits.timeoutMs + 5000);
  const hardTimeout = setTimeout(
    () => child.kill("SIGKILL"),
    comparisonLimits.timeoutMs + 15_000
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  clearTimeout(hardTimeout);
  await writeFile(join(run.directory, "runner-stdout.json"), stdout, {
    flag: "wx",
  });
  await writeFile(join(run.directory, "runner-stderr.log"), stderr, {
    flag: "wx",
  });
  let output: Record<string, unknown>;
  try {
    output = getRecord(JSON.parse(stdout));
  } catch {
    output = { parseError: "Runner did not emit a single JSON result." };
  }
  return {
    ...observeOutput(run.harness, output),
    elapsedMs: Date.now() - run.startedAt,
    exitCode,
    output,
  };
}

async function compare(
  phase: "pilot" | "development" | "holdout"
): Promise<void> {
  const session = `${phase}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const directory = join(root, "runs", session);
  await mkdir(directory, { recursive: true });
  const tasks: HarnessTask[] = shuffle(
    phase === "pilot"
      ? [pilotTask()]
      : JSON.parse(await readFile(join(manifestDir, `${phase}.json`), "utf8"))
  );
  const frozen =
    phase === "pilot"
      ? null
      : JSON.parse(await readFile(join(manifestDir, "manifest.json"), "utf8"));
  if (frozen) {
    await assertFrozenFiles(repository, frozen.harnessHashes);
    await assertFrozenFiles(join(root, "source"), frozen.hermesHashes);
    const unshuffledTasks = JSON.parse(
      await readFile(join(manifestDir, `${phase}.json`), "utf8")
    );
    if (digest(JSON.stringify(unshuffledTasks)) !== frozen.taskHashes[phase]) {
      throw new Error("Frozen task manifest changed.");
    }
    if (
      digest(
        await readFile(
          join(
            repository,
            "docs/architecture/hermes-comparison-preregistration.md"
          )
        )
      ) !== frozen.protocolSha256
    ) {
      throw new Error("Frozen preregistration changed.");
    }
  }
  const candidateHashes = await atlasSourceHashes(repository);
  const candidateSourceHash = digest(JSON.stringify(candidateHashes));
  await writeFile(
    join(directory, "candidate-source.json"),
    JSON.stringify({ candidateSourceHash, files: candidateHashes }, null, 2),
    { flag: "wx" }
  );
  const proxy = await startComparisonProxy(
    process.env.HARNESS_KEY_FILE ??
      "/private/tmp/atlas-harness-private/opencode-key"
  );
  const repetitions = phase === "holdout" ? 2 : 1;
  const schedule = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const [index, task] of tasks.entries()) {
      const order: ComparisonRun["harness"][] =
        (index + repetition) % 2 === 0
          ? ["atlas", "hermes"]
          : ["hermes", "atlas"];
      schedule.push({ order, repetition, taskId: task.id });
    }
  }
  await writeFile(
    join(directory, "schedule.json"),
    JSON.stringify(
      {
        bootstrapSettings,
        candidateSourceHash,
        limits: comparisonLimits,
        manifestPath: frozen ? join(manifestDir, "manifest.json") : null,
        manifestSha256: frozen
          ? digest(await readFile(join(manifestDir, "manifest.json")))
          : null,
        phase,
        schedule,
        session,
        shuffleSeed,
      },
      null,
      2
    ),
    { flag: "wx" }
  );
  process.stdout.write(
    `${JSON.stringify({ directory, event: "start", pairs: schedule.length, phase })}\n`
  );
  try {
    for (const item of schedule) {
      if (frozen) {
        await assertFrozenFiles(repository, frozen.harnessHashes);
      }
      const task = tasks.find((entry) => entry.id === item.taskId);
      if (!task) {
        throw new Error("Scheduled task missing.");
      }
      for (const harness of item.order) {
        const safeTaskId = task.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
        const id = `${session}-${safeTaskId}-r${item.repetition}-${harness}`;
        const start = {
          at: new Date().toISOString(),
          candidateSourceHash,
          event: "start",
          harness,
          id,
          phase,
          repetition: item.repetition,
          taskId: task.id,
        };
        await appendFile(
          join(directory, "attempts.jsonl"),
          `${JSON.stringify(start)}\n`
        );
        let endWritten = false;
        try {
          const run = await proxy.register(
            id,
            harness,
            task,
            join(directory, `${safeTaskId}-r${item.repetition}-${harness}`)
          );
          let infrastructureError: string | null = null;
          let result: Awaited<ReturnType<typeof execute>>;
          let files: Record<string, string> = {};
          try {
            result = await execute(run, proxy.url);
            files = await proxy.snapshot(run);
          } catch (error) {
            infrastructureError =
              error instanceof Error ? error.message : String(error);
            result = {
              elapsedMs: Date.now() - run.startedAt,
              exitCode: -1,
              finalText: "",
              output: { infrastructureError },
              terminalStatus: "failed",
            };
            await writeFile(
              join(run.directory, "infrastructure-error.json"),
              JSON.stringify({
                at: new Date().toISOString(),
                infrastructureError,
              }),
              { flag: "wx" }
            );
          }
          if (
            result.elapsedMs > comparisonLimits.timeoutMs ||
            run.generatedTokens > comparisonLimits.generatedTokens ||
            run.providerRequests > comparisonLimits.providerRequests ||
            run.missingUsage
          ) {
            run.budgetExceeded = true;
          }
          const observation: TaskObservation = {
            events: run.toolEvents,
            files,
            finalText: result.finalText,
            terminalStatus: run.budgetExceeded
              ? "budget_exceeded"
              : result.terminalStatus,
          };
          const evaluation = evaluateTask(task, observation);
          const record = {
            candidateSourceHash,
            category: task.category,
            elapsedMs: result.elapsedMs,
            evaluation,
            event: "end",
            exitCode: result.exitCode,
            family: task.family,
            harness,
            id,
            infrastructureError,
            phase,
            providerStatuses: run.providerStatuses,
            repetition: item.repetition,
            status: observation.terminalStatus,
            taskId: task.id,
            usage: {
              budgetExceeded: run.budgetExceeded,
              cachedTokens: run.cachedTokens,
              generatedTokens: run.generatedTokens,
              missingUsage: run.missingUsage,
              promptTokens: run.promptTokens,
              providerRequests: run.providerRequests,
            },
          };
          await writeFile(
            join(run.directory, "observation.json"),
            JSON.stringify(observation, null, 2),
            { flag: "wx" }
          );
          await writeFile(
            join(run.directory, "result.json"),
            JSON.stringify(record, null, 2),
            { flag: "wx" }
          );
          await appendFile(
            join(directory, "attempts.jsonl"),
            `${JSON.stringify(record)}\n`
          );
          endWritten = true;
          process.stdout.write(`${JSON.stringify(record)}\n`);
        } catch (error) {
          if (endWritten) {
            throw error;
          }
          const record = {
            ...start,
            elapsedMs: null,
            evaluation: null,
            event: "end",
            infrastructureError:
              error instanceof Error ? error.message : String(error),
            status: "failed",
            unavailable: true,
            usage: null,
          };
          await appendFile(
            join(directory, "attempts.jsonl"),
            `${JSON.stringify(record)}\n`
          );
          process.stdout.write(`${JSON.stringify(record)}\n`);
        }
      }
    }
    const endingSourceHash = digest(
      JSON.stringify(await atlasSourceHashes(repository))
    );
    if (endingSourceHash !== candidateSourceHash) {
      throw new Error(
        "Atlas source changed during the batch; results are not a fixed-candidate comparison."
      );
    }
    if (frozen) {
      await assertFrozenFiles(repository, frozen.harnessHashes);
      await assertFrozenFiles(join(root, "source"), frozen.hermesHashes);
    }
    await writeFile(
      join(directory, "completed.json"),
      JSON.stringify({
        at: new Date().toISOString(),
        candidateSourceHash,
        pairedTasks: schedule.length,
        sourceUnchanged: true,
      }),
      { flag: "wx" }
    );
  } catch (error) {
    await writeFile(
      join(directory, "interrupted.json"),
      JSON.stringify({
        at: new Date().toISOString(),
        reason: error instanceof Error ? error.message : String(error),
      }),
      { flag: "wx" }
    );
    throw error;
  } finally {
    await proxy.close();
  }
}

const command = process.argv[2];
if (command === "freeze") {
  await freeze();
} else if (
  command === "pilot" ||
  command === "development" ||
  command === "holdout"
) {
  await compare(command);
} else {
  throw new Error(
    "Usage: bun scripts/harness-compare/run.ts freeze|pilot|development|holdout"
  );
}
