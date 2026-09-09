import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { evaluateTask } from "../harness-compare/oracles";
import {
  bootstrapSettings,
  sha256,
  shuffleSeed,
} from "../harness-compare/provenance";
import type { HarnessTask, TaskObservation } from "../harness-compare/types";
import {
  type ComparisonRun,
  comparisonLimits,
  comparisonModel,
  startComparisonProxy,
  upstreamEndpoint,
} from "../harness-compare-v2-transport/proxy";
import { object, readUsage } from "./accounting";
import { createRuntimeIdentity, writeIdentityManifest } from "./identity";
import { evaluateV2Task } from "./oracles";
import {
  archiveSnapshot,
  controlHashes,
  defaultStudyRoot,
  errorText,
  freezeStudy,
  type Harness,
  jsonFile,
  loadPlan,
  type Pair,
  type Phase,
  privateDirectory,
  python,
  repository,
  sameHashes,
  sourceSnapshot,
} from "./provenance";

type Upstream = (url: string, init: RequestInit) => Promise<Response>;
interface BatchOptions {
  candidateLabel?: string;
  /** Offline test seam only; CLI offers no transport replacement. */
  fetchUpstream?: Upstream;
  keyFile?: string;
  phase: Phase;
  studyRoot?: string;
}

/** Same original broker, one trial per listener. Only parent lifecycle cancellation is added. */
export async function trialProxy(
  keyFile: string,
  fetchUpstream: Upstream = fetch
) {
  const pending = new Set<AbortController>();
  const proxy = await startComparisonProxy(keyFile, {
    async fetchUpstream(url, init) {
      const controller = new AbortController();
      pending.add(controller);
      try {
        const response = await fetchUpstream(url, {
          ...init,
          signal: init.signal
            ? AbortSignal.any([init.signal, controller.signal])
            : controller.signal,
        });
        // Finish reading before resolving so process cleanup can cancel a hanging response body.
        return new Response(await response.arrayBuffer(), {
          headers: response.headers,
          status: response.status,
        });
      } finally {
        pending.delete(controller);
      }
    },
  });
  return {
    ...proxy,
    async finalize(run: ComparisonRun) {
      for (const controller of pending) {
        controller.abort(
          new Error("Trial runner ended; cancel pending upstream work.")
        );
      }
      const deadline = Date.now() + 5000;
      while (run.activeRequest && Date.now() < deadline) {
        await new Promise((accept) => setTimeout(accept, 10));
      }
      return {
        activeAfterDrain: run.activeRequest,
        pendingAfterDrain: pending.size,
      };
    },
  };
}

/** Projection matches the original adapter contract; never passes the oracle or a credential. */
export function runnerInput(
  run: ComparisonRun,
  serverBaseUrl: string,
  nativeRoot: string
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
    hermes_home: join(nativeRoot, "hermes-home"),
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

export function observeOutput(
  harness: Harness,
  output: Record<string, unknown>
): Pick<TaskObservation, "finalText" | "terminalStatus"> {
  if (harness === "atlas") {
    return {
      finalText: typeof output.finalText === "string" ? output.finalText : "",
      terminalStatus: output.status === "completed" ? "completed" : "failed",
    };
  }
  const result = object(output.result);
  return {
    finalText:
      typeof result.final_response === "string" ? result.final_response : "",
    terminalStatus:
      result.completed === true &&
      typeof output.requested_turns === "number" &&
      output.requested_turns > 0 &&
      output.completed_turns === output.requested_turns
        ? "completed"
        : "failed",
  };
}

async function execute(
  run: ComparisonRun,
  url: string,
  nativeRoot: string,
  directory: string
) {
  const input = runnerInput(run, url, nativeRoot);
  await jsonFile(join(directory, "runner-input.json"), input);
  const stdoutPath = join(directory, "runner-stdout.json");
  const stdout = await open(stdoutPath, "wx", 0o600);
  const stderr = await open(join(directory, "runner-stderr.log"), "wx", 0o600);
  const command =
    run.harness === "atlas"
      ? [
          process.execPath,
          join(repository, "scripts/harness-compare/atlas-runner.ts"),
        ]
      : [python, join(repository, "scripts/harness-compare/hermes_runner.py")];
  let infrastructureError: string | null = null;
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
        TMPDIR: nativeRoot,
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
      run.startedAt + comparisonLimits.timeoutMs - Date.now()
    );
    const soft = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
    }, remaining);
    const hard = setTimeout(() => terminate("SIGKILL"), remaining + 2000);
    try {
      const completion = new Promise<number>((accept) => {
        child.once("error", (error) => {
          infrastructureError = errorText(error);
          accept(-1);
        });
        child.once("close", (code) => accept(code ?? -1));
      });
      child.stdin?.on("error", (error) => {
        infrastructureError = errorText(error);
      });
      child.stdin?.end(JSON.stringify(input));
      exitCode = await completion;
    } finally {
      clearTimeout(soft);
      clearTimeout(hard);
      // The detached group belongs solely to this trial, including any leftover descendants.
      terminate("SIGKILL");
    }
  } catch (error) {
    infrastructureError = errorText(error);
  } finally {
    await stdout.close();
    await stderr.close();
  }
  let output: Record<string, unknown> = {};
  try {
    output = object(JSON.parse(await readFile(stdoutPath, "utf8")));
    if (
      run.harness === "atlas" &&
      (output.framework !== "atlas" ||
        output.runId !== run.id ||
        output.model !== comparisonModel)
    ) {
      throw new Error("Atlas output identity mismatch.");
    }
    if (
      run.harness === "hermes" &&
      (output.harness !== "hermes" ||
        output.run_id !== run.id ||
        output.model !== comparisonModel)
    ) {
      throw new Error("Hermes output identity mismatch.");
    }
  } catch (error) {
    infrastructureError ??= errorText(error);
  }
  return {
    ...observeOutput(run.harness, output),
    elapsedMs: Date.now() - run.startedAt,
    exitCode,
    infrastructureError,
    output,
    timedOut,
  };
}

async function ledger(directory: string, value: unknown) {
  await appendFile(
    join(directory, "attempts.jsonl"),
    `${JSON.stringify(value)}\n`,
    { mode: 0o600 }
  );
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
    pair: Pair;
    task: HarnessTask;
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
  const id = `${batch}-${task.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}-r${pair.repetition}-${harness}`;
  const trialDirectory = join(directory, "trials", id);
  await mkdir(trialDirectory, { mode: 0o700, recursive: true });
  const { identity, identitySha256 } = await createRuntimeIdentity(
    trialDirectory,
    nativeParent,
    {
      attemptId: id,
      harness,
      repetition: pair.repetition,
      taskId: task.id,
    }
  );
  const start = {
    at: new Date().toISOString(),
    candidateSourceHash,
    category: task.category,
    event: "start",
    family: task.family,
    harness,
    id,
    identitySha256,
    phase: options.phase,
    repetition: pair.repetition,
    taskId: task.id,
    transportId: identity.transportId,
  };
  await ledger(directory, start);
  let proxy: Awaited<ReturnType<typeof trialProxy>> | undefined;
  let run: ComparisonRun | undefined;
  let endWritten = false;
  try {
    await mkdir(trialDirectory, { mode: 0o700, recursive: true });
    const nativeRoot = identity.nativeStateRoot;
    proxy = await trialProxy(keyFile, options.fetchUpstream);
    run = await proxy.register(
      identity.transportId,
      harness,
      task,
      join(trialDirectory, "wire"),
      { workspaceRoot: identity.workspaceRoot }
    );
    const execution = await execute(run, proxy.url, nativeRoot, trialDirectory);
    const lifecycle = await proxy.finalize(run);
    const elapsedMs = Date.now() - run.startedAt;
    const usage = await readUsage(
      run.directory,
      run.providerRequests,
      elapsedMs,
      execution.timedOut
    );
    if (lifecycle.activeAfterDrain || lifecycle.pendingAfterDrain) {
      execution.infrastructureError ??=
        "Upstream work did not drain; final accounting is incomplete.";
    }
    if (execution.infrastructureError) {
      await ledger(directory, {
        ...start,
        event: "error",
        infrastructureError: execution.infrastructureError,
      });
    }
    const rawObservation: TaskObservation = {
      events: run.toolEvents,
      files: await proxy.snapshot(run),
      finalText: execution.finalText,
      terminalStatus: execution.terminalStatus,
    };
    const status = usage.budgetExceeded
      ? "budget_exceeded"
      : execution.exitCode === 0 &&
          !execution.infrastructureError &&
          usage.withinBudgetCertified
        ? execution.terminalStatus
        : "failed";
    const observation: TaskObservation = {
      ...rawObservation,
      terminalStatus: status,
    };
    const evaluation = evaluateV2Task(task, observation);
    const record = {
      ...start,
      at: new Date().toISOString(),
      elapsedMs,
      evaluation,
      event: "end",
      executionElapsedMs: execution.elapsedMs,
      exitCode: execution.exitCode,
      infrastructureError: execution.infrastructureError,
      lifecycle,
      nativeStateRoot: nativeRoot,
      originalEvaluation: evaluateTask(task, observation),
      providerStatuses: run.providerStatuses,
      rawEvaluation: evaluateTask(task, rawObservation),
      rawTerminalStatus: execution.terminalStatus,
      status,
      timedOut: execution.timedOut,
      transportAdmitted: run.providerRequests > 0,
      unavailable:
        run.providerRequests === 0 && execution.infrastructureError !== null,
      usage,
    };
    await jsonFile(join(trialDirectory, "observation.json"), observation);
    await jsonFile(
      join(trialDirectory, "raw-observation.json"),
      rawObservation
    );
    await jsonFile(join(trialDirectory, "result.json"), record);
    await ledger(directory, record);
    endWritten = true;
    process.stdout.write(
      `${JSON.stringify({ event: "trial-end", id, pass: evaluation.pass, status })}\n`
    );
  } catch (error) {
    if (endWritten) {
      throw error;
    }
    const infrastructureError = errorText(error);
    if (proxy && run) {
      await proxy.finalize(run);
    }
    const elapsedMs = run ? Date.now() - run.startedAt : null;
    const usage = run
      ? await readUsage(run.directory, run.providerRequests, elapsedMs)
      : null;
    await ledger(directory, { ...start, event: "error", infrastructureError });
    const record = {
      ...start,
      at: new Date().toISOString(),
      elapsedMs,
      evaluation: null,
      event: "end",
      infrastructureError,
      status: "failed",
      transportAdmitted: (run?.providerRequests ?? 0) > 0,
      unavailable: (run?.providerRequests ?? 0) === 0,
      usage,
    };
    await jsonFile(join(trialDirectory, "result.json"), record);
    await ledger(directory, record);
    process.stdout.write(
      `${JSON.stringify({ event: "trial-end", id, infrastructureError, status: "failed" })}\n`
    );
  } finally {
    await proxy?.close();
  }
}

export async function runBatch(options: BatchOptions): Promise<string> {
  if (options.fetchUpstream && options.phase !== "pilot") {
    throw new Error("Scripted transport is allowed only for unscored pilots.");
  }
  const root = await privateDirectory(options.studyRoot ?? defaultStudyRoot);
  const plan = await loadPlan(
    root,
    options.phase,
    Boolean(options.fetchUpstream)
  );
  const snapshot = await sourceSnapshot();
  if (plan.frozen) {
    sameHashes(
      snapshot.controlHashes,
      plan.frozen.controlHashes,
      "Frozen V2 controls"
    );
    sameHashes(
      snapshot.hermesHashes,
      plan.frozen.hermesHashes,
      "Frozen Hermes"
    );
  }
  const keyFile = await realpath(
    options.keyFile ??
      process.env.HARNESS_KEY_FILE ??
      "/private/tmp/atlas-harness-private/opencode-key"
  );
  if (!keyFile.startsWith(`/private/tmp${sep}`)) {
    throw new Error(
      "The credential file must be in private temporary storage."
    );
  }
  const batch = `${options.phase}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = await privateDirectory(join(root, "batches", batch));
  const nativeParent = await privateDirectory(
    await mkdtemp("/private/tmp/atlas-harness-runtime-")
  );
  await jsonFile(join(directory, "candidate-source.json"), {
    ...snapshot,
    candidateLabel:
      options.candidateLabel ?? snapshot.candidateSourceHash.slice(0, 12),
  });
  await jsonFile(join(directory, "schedule.json"), {
    bootstrapSettings,
    candidateSourceHash: snapshot.candidateSourceHash,
    limits: comparisonLimits,
    manifestPath: plan.manifestPath,
    manifestSha256: plan.manifestSha256,
    model: comparisonModel,
    phase: options.phase,
    schedule: plan.schedule,
    scored: options.phase !== "pilot",
    session: batch,
    shuffleSeed,
    transportMode: options.fetchUpstream ? "offline-scripted" : "live",
  });
  await jsonFile(join(directory, "evaluator-tasks.json"), plan.tasks);
  if (!options.fetchUpstream) {
    const admissions = await privateDirectory(join(root, "admissions"));
    const admissionId =
      options.phase === "confirmatory"
        ? "confirmatory"
        : `${options.phase}-${snapshot.candidateSourceHash}`;
    await jsonFile(join(admissions, `${admissionId}.json`), {
      at: new Date().toISOString(),
      batch,
      candidateSourceHash: snapshot.candidateSourceHash,
      manifestSha256: plan.manifestSha256,
      phase: options.phase,
    });
  }
  process.stdout.write(
    `${JSON.stringify({ directory, event: "v2-batch-start", pairs: plan.schedule.length, phase: options.phase, scored: options.phase !== "pilot" })}\n`
  );
  try {
    await archiveSnapshot(directory, snapshot);
    for (const pair of plan.schedule) {
      sameHashes(
        await controlHashes(),
        snapshot.controlHashes,
        "V2 controls during batch"
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
      "V2 controls during batch"
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
    const identityManifestSha256 = await writeIdentityManifest(directory);
    await jsonFile(join(directory, "completed.json"), {
      at: new Date().toISOString(),
      candidateSourceHash: snapshot.candidateSourceHash,
      identityManifestSha256,
      pairedTasks: plan.schedule.length,
      sourceUnchanged: true,
    });
  } catch (error) {
    await ledger(directory, {
      at: new Date().toISOString(),
      event: "batch-error",
      reason: errorText(error),
    });
    await jsonFile(join(directory, "interrupted.json"), {
      at: new Date().toISOString(),
      reason: errorText(error),
    });
    throw error;
  }
  return directory;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !(
        flag &&
        value &&
        ["--study-root", "--key-file", "--candidate-label"].includes(flag)
      ) ||
      values.has(flag)
    ) {
      throw new Error(
        "Only --study-root, --key-file, --candidate-label value pairs are allowed; no filters/retries/resumes."
      );
    }
    values.set(flag, value);
  }
  if (command === "freeze") {
    process.stdout.write(`${await freezeStudy(values.get("--study-root"))}\n`);
  } else if (
    command === "pilot" ||
    command === "development" ||
    command === "confirmatory"
  ) {
    await runBatch({
      candidateLabel: values.get("--candidate-label"),
      keyFile: values.get("--key-file"),
      phase: command,
      studyRoot: values.get("--study-root"),
    });
  } else {
    throw new Error(
      "Usage: bun scripts/harness-controlled-v2-amended/run.ts freeze|pilot|development|confirmatory"
    );
  }
}
