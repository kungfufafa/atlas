/** Test-only synthetic disk evidence. These records are not real process observations. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assessFileNativeOutput,
  fileDigest,
  type ScheduledFileArm,
} from "./file-process-outcome";
import type { ProductPair } from "./product-analysis";

type Row = Record<string, unknown>;
export const fixtureJson = async (
  path: string,
  value: unknown
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};
const readJson = async (path: string): Promise<Row> =>
  JSON.parse(await readFile(path, "utf8"));
const reference = async (directory: string, path: string) => {
  const data = await readFile(join(directory, path));
  return { bytes: data.length, path, sha256: fileDigest(data) };
};
const at = (monotonicMs: number) => ({
  monotonicMs,
  wallMs: 1_800_000_000_000 + monotonicMs,
});
export async function writeSyntheticFileParents(
  directory: string,
  schedule: ProductPair[],
  ledger: Row[],
  options: {
    empty?: boolean;
    processFailure?: boolean;
    callerOverrun?: boolean;
    nativeIdentity?: "missing" | "foreign";
    sourceFree?: boolean;
    omitCopies?: boolean;
  } = {}
): Promise<void> {
  const metadata = await readJson(join(directory, "batch.json"));
  const budget = metadata.budget as Row;
  const arms = schedule.flatMap((pair) =>
    pair.order.map((harness) => ({
      attemptId: `${metadata.batch}-${pair.pairId}-${harness}`,
      family: pair.family,
      harness,
      pairId: pair.pairId,
      repetition: pair.repetition,
      variant: pair.variant,
    }))
  );
  await fixtureJson(join(directory, "scheduled-arms.json"), {
    arms,
    batch: metadata.batch,
    schemaVersion: 3,
  });
  const scheduledArmsSha256 = fileDigest(
    await readFile(join(directory, "scheduled-arms.json"))
  );
  await fixtureJson(join(directory, "batch.json"), {
    ...metadata,
    scheduledArmsSha256,
  });
  const entries: Row[] = [];
  for (const pair of schedule) {
    const prefix = `pairs/${pair.pairId}`,
      sourceDirectory = join(directory, prefix, "source-originals"),
      taskId = `synthetic-task-${pair.pairId}`,
      taskTurns = ["Synthetic disk-verifier source request"];
    await mkdir(sourceDirectory, { recursive: true });
    if (!options.sourceFree) {
      await writeFile(join(sourceDirectory, "source.csv"), "key,value\na,1\n");
    }
    const sourceHashes = options.sourceFree
      ? {}
      : {
          "source.csv": fileDigest(
            await readFile(join(sourceDirectory, "source.csv"))
          ),
        };
    await fixtureJson(join(directory, prefix, "private-oracle.json"), {
      id: taskId,
      prompt: taskTurns[0],
      sources: sourceHashes,
    });
    const manifestSha256 = fileDigest(
      await readFile(join(directory, prefix, "private-oracle.json"))
    );
    await fixtureJson(join(directory, prefix, "pair-input.json"), {
      manifestSha256,
      originals: sourceDirectory,
      sourceHashes,
      taskId,
      taskTurns,
    });
    await fixtureJson(join(directory, prefix, "source-assignment.json"), {
      manifestSha256,
      pairId: pair.pairId,
      schemaVersion: 3,
      sourceDirectory,
      sourceHashes,
      taskId,
      taskTurnsSha256: fileDigest(JSON.stringify(taskTurns)),
    });
    const sourceAssignment = await reference(
      directory,
      `${prefix}/source-assignment.json`
    );
    for (const harness of pair.order) {
      const id = `${metadata.batch}-${pair.pairId}-${harness}`,
        start = ledger.find(
          (event) => event.id === id && event.event === "start"
        )!,
        end = ledger.find((event) => event.id === id && event.event === "end")!,
        trial = join(directory, "trials", id);
      const mapping = {
        attemptId: id,
        createdAt: "2026-01-01T00:00:00.000Z",
        harness,
        nativeStateRoot: `/private/tmp/agent-runtime-synthetic/state-${entries.length}`,
        pairId: pair.pairId,
        repetition: pair.repetition,
        schemaVersion: 1,
        taskId,
        transportId: `transport-${randomUUID()}`,
      };
      await fixtureJson(join(trial, "runtime-identity.json"), mapping);
      const identityBytes = await readFile(
          join(trial, "runtime-identity.json")
        ),
        identitySha256 = fileDigest(identityBytes);
      const expected: ScheduledFileArm = {
        attemptId: id,
        harness,
        identitySha256,
        nativeStateRoot: mapping.nativeStateRoot,
        pairId: pair.pairId,
        transportId: mapping.transportId,
      };
      entries.push({ attemptId: id, identitySha256 });
      const deadline = {
        atMonotonicMs: 100 + Number(budget.timeoutMs),
        atWallMs: at(100).wallMs + Number(budget.timeoutMs),
        scope: "scheduled_attempt",
      };
      Object.assign(start, {
        attemptStarted: at(100),
        deadline,
        identitySha256,
        measurementVersion: 3,
        offlineNativeFixture: false,
        sourceAssignment,
        transportId: mapping.transportId,
      });
      let previousInput: Row = {};
      try {
        previousInput = await readJson(join(trial, "runner-input.json"));
      } catch {
        /* New synthetic fixture. */
      }
      const input = {
        ...previousInput,
        budget,
        model: metadata.model,
        proxyBaseUrl: "http://127.0.0.1:34567",
        runId: mapping.transportId,
        sourceDirectory,
        stateRoot: mapping.nativeStateRoot,
        taskTurns,
      };
      await fixtureJson(join(trial, "wire/native-transport-binding.json"), {
        chatPath: `/runs/${mapping.transportId}/v1/chat/completions`,
        modelPath: `/runs/${mapping.transportId}/v1/models`,
        publicOrigin: input.proxyBaseUrl,
        schemaVersion: 1,
        transportId: mapping.transportId,
      });
      const inputBytes = Buffer.from(JSON.stringify(input));
      await mkdir(join(trial, "process"), { recursive: true });
      await writeFile(join(trial, "process/runner-input.json"), inputBytes);
      await writeFile(join(trial, "runner-input.json"), inputBytes);
      await writeFile(
        join(trial, "process/parent-runtime-identity.json"),
        identityBytes
      );
      const observation = {
        evidence: { artifactInspectionAllowed: true },
        finalText: "Done",
        framework: harness,
        nativeEvents: [],
        runId:
          options.nativeIdentity === "missing"
            ? undefined
            : options.nativeIdentity === "foreign"
              ? "foreign-transport"
              : mapping.transportId,
        sessions: [
          {
            initialHistoryCount: 0,
            nativeStateRoot: mapping.nativeStateRoot,
            turns: taskTurns.map((input) => ({ input, status: "completed" })),
          },
        ],
        sourceCopies: options.omitCopies
          ? undefined
          : Object.entries(sourceHashes).map(([path, sha256]) => ({
              path,
              sha256,
            })),
        status: "completed",
        workspaceRoot: mapping.nativeStateRoot,
      };
      const stdout = options.empty
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(observation)),
        stderr = Buffer.alloc(0);
      const native = assessFileNativeOutput(stdout, true, expected);
      const scheduled = {
        deadline,
        expected,
        inputSha256: fileDigest(inputBytes),
        launch: {
          argsSha256: fileDigest("[]"),
          command: "synthetic-no-process",
          cwd: mapping.nativeStateRoot,
          environmentSha256: fileDigest("[]"),
        },
        limits: {
          closeGraceMs: 1000,
          drainGraceMs: 250,
          inputBytes: 2_000_000,
          stderrBytes: 2_000_000,
          stdoutBytes: 20_000_000,
          termGraceMs: 2000,
        },
        origin: "parent_scheduled_arm",
        schemaVersion: 3,
        started: at(102),
      };
      await fixtureJson(join(trial, "process/scheduled-arm.json"), scheduled);
      const scheduledSha256 = fileDigest(
        await readFile(join(trial, "process/scheduled-arm.json"))
      );
      const events = [
        { event: "scheduled_receipt_persisted", ...at(103), scheduledSha256 },
        { event: "spawn_call", ...at(104) },
        { event: "spawn_returned", ...at(105), pid: 1000 + entries.length },
        { event: "spawn_event", ...at(106), pid: 1000 + entries.length },
        { event: "stdout_end", ...at(110) },
        { event: "stderr_end", ...at(111) },
        {
          event: "exit",
          ...at(112),
          code: options.processFailure ? 9 : 0,
          signal: null,
        },
        {
          event: "close",
          ...at(113),
          code: options.processFailure ? 9 : 0,
          signal: null,
        },
        { event: "process_receipt_finalizing", ...at(114) },
      ];
      const facts = (data: Buffer) => ({
        bytesAfterCaptureEnd: "unknown",
        bytesObserved: data.length,
        bytesStored: data.length,
        complete: true,
        overflow: false,
        sha256: fileDigest(data),
        streamEndObserved: true,
      });
      const observationFile = native.observation
        ? {
            bytes: stdout.length,
            path: "runner-stdout.json",
            sha256: fileDigest(stdout),
          }
        : null;
      const failed = Boolean(
        options.empty || options.processFailure || options.nativeIdentity
      );
      const outcome = {
        cleanup: {
          allDescendantsGone: "unproved",
          directChildCloseObserved: true,
          directChildExitObserved: true,
          nativeReport: null,
          processGroupProbe: "absent_at_probe",
        },
        closed: true,
        deadline,
        drainExpired: false,
        elapsedMonotonicMs: 12,
        elapsedWallMs: 12,
        events,
        exit: {
          at: at(111.5),
          code: options.processFailure ? 9 : 0,
          signal: null,
        },
        expected,
        failures: failed
          ? [options.empty ? "native_empty_output" : "child_exit_not_zero"]
          : [],
        native: {
          identity: native.identity,
          observationFile,
          observedIdentity: native.observedIdentity,
          reason: native.reason,
          reportedStatus: native.observation?.status ?? null,
        },
        parentBinding: "bound",
        persistenceErrors: [],
        pid: 1000 + entries.length,
        processFailure: failed,
        processObservedAt: at(115),
        receiptComplete: true,
        scheduledSha256,
        schemaVersion: 3,
        signals: [],
        started: at(102),
        stderr: facts(stderr),
        stdout: facts(stdout),
        timedOut: false,
        usage: {
          inferZeroFromProcessFailure: false,
          reportedCounts: null,
          status: "not_collected_by_process_runner",
        },
      };
      await writeFile(
        join(trial, "process/parent-process-events.jsonl"),
        events.map((event) => JSON.stringify(event)).join("\n") + "\n"
      );
      await writeFile(join(trial, "process/runner-stdout.json"), stdout);
      await writeFile(join(trial, "process/runner-stderr.log"), stderr);
      await fixtureJson(join(trial, "process/process-outcome.json"), outcome);
      await writeFile(
        join(trial, "observation.json"),
        native.observation ? stdout : "null"
      );
      const paths = [
        "process/process-outcome.json",
        "process/scheduled-arm.json",
        "process/parent-process-events.jsonl",
        "process/runner-stdout.json",
        "process/runner-stderr.log",
        "process/runner-input.json",
        "runtime-identity.json",
      ];
      const references = Object.fromEntries(
        await Promise.all(
          paths.map(async (path) => [path, await reference(trial, path)])
        )
      );
      const invocation = {
        attemptStarted: at(100),
        deadline,
        expected,
        invocationStarted: at(101),
        processHelperElapsedMs: 19,
        processHelperElapsedWallMs: 19,
        processHelperReturned: at(120),
        references,
        schemaVersion: 3,
        sourceAssignment,
      };
      await fixtureJson(join(trial, "invocation.json"), invocation);
      const returned = options.callerOverrun ? deadline.atMonotonicMs + 1 : 125;
      const caller = {
        callerInvocationReturned: at(returned),
        callerInvocationStarted: at(100.5),
        deadline,
        invocation: await reference(trial, "invocation.json"),
        outerInvocationElapsedMs: returned - 100.5,
        outerInvocationElapsedWallMs: returned - 100.5,
        schemaVersion: 3,
      };
      await fixtureJson(join(trial, "caller-return.json"), caller);
      Object.assign(end, {
        ...start,
        boundaryValid: native.observation !== null,
        elapsedMs: caller.outerInvocationElapsedMs,
        event: "end",
        inputIdentical: native.observation !== null && !options.omitCopies,
        inspectionAllowed:
          !failed && (harness === "hermes" || !options.callerOverrun),
        nativeObservation: observationFile,
        processEvidence: {
          callerReturn: await reference(trial, "caller-return.json"),
          invocation: await reference(trial, "invocation.json"),
          nativeIdentity: native.identity,
          processFailure: failed,
          receiptComplete: true,
        },
        processObservationElapsedMs: 12,
        status: failed
          ? "failed"
          : options.callerOverrun
            ? "budget_exceeded"
            : "completed",
        success: !(failed || options.callerOverrun),
        taskId,
        totalAttemptElapsedMs: returned - 100,
        totalAttemptElapsedWallMs: returned - 100,
      });
      await fixtureJson(join(trial, "result.json"), end);
    }
  }
  await fixtureJson(join(directory, "runtime-identities.json"), {
    entries,
    schemaVersion: 1,
  });
  const completed = await readJson(join(directory, "completed.json"));
  await fixtureJson(join(directory, "completed.json"), {
    ...completed,
    runtimeIdentitiesSha256: fileDigest(
      await readFile(join(directory, "runtime-identities.json"))
    ),
    scheduledArmsSha256,
  });
  await writeFile(
    join(directory, "attempts.jsonl"),
    ledger.map((event) => JSON.stringify(event)).join("\n") + "\n"
  );
}
