import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assessFileNativeOutput,
  fileDigest,
  fileRecord,
  type NativeFileObservation,
  type ScheduledFileArm,
} from "./file-process-outcome";

type Row = Record<string, unknown>;
interface Pair {
  family: string;
  order: ("atlas" | "hermes")[];
  pairId: string;
  repetition: number;
  variant?: number;
}
export interface VerifiedFileParentEvidence {
  failures: string[];
  nativeIdentity: "bound" | "unavailable" | "conflict";
  nativeObservation: NativeFileObservation | null;
  nativeRequirementsMet: boolean;
  parentVerified: boolean;
  processEligible: boolean;
}
const HASH = /^[a-f0-9]{64}$/;
const row = (value: unknown): Row => (fileRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);
function check(condition: unknown, reason: string): asserts condition {
  if (!condition) {
    throw new Error(reason);
  }
}
function safe(path: string): boolean {
  return (
    Boolean(path) &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
function sorted(value: unknown): Row {
  return Object.fromEntries(
    Object.entries(row(value)).sort(([a], [b]) => a.localeCompare(b))
  );
}
async function bytes(
  root: string,
  path: string,
  max = 2_000_000
): Promise<Buffer> {
  check(safe(path), "unsafe_evidence_path");
  const full = join(root, path);
  const info = await lstat(full);
  check(
    info.isFile() && !info.isSymbolicLink() && info.size <= max,
    "nonregular_or_oversize_evidence"
  );
  check((await realpath(full)) === full, "symlink_evidence_path");
  // biome-ignore lint/suspicious/noBitwiseOperators: File-open flags must be combined without permitting a symlink follow.
  const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    check(
      before.isFile() &&
        before.size <= max &&
        before.dev === info.dev &&
        before.ino === info.ino,
      "changed_evidence_identity"
    );
    const captured = await file.readFile();
    const after = await file.stat();
    check(
      captured.length <= max &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        captured.length === after.size,
      "changed_evidence_bytes"
    );
    return captured;
  } finally {
    await file.close();
  }
}
async function json(root: string, path: string): Promise<Row> {
  const value: unknown = JSON.parse((await bytes(root, path)).toString("utf8"));
  check(fileRecord(value), "invalid_evidence_object");
  return value;
}
async function referenced(
  root: string,
  value: unknown,
  expectedPath: string,
  max = 2_000_000
): Promise<Buffer> {
  const ref = row(value);
  check(
    ref.path === expectedPath &&
      count(ref.bytes) &&
      HASH.test(text(ref.sha256)),
    "invalid_evidence_reference"
  );
  const data = await bytes(root, expectedPath, max);
  check(
    ref.bytes === data.length && ref.sha256 === fileDigest(data),
    "evidence_reference_mismatch"
  );
  return data;
}
function stamp(value: unknown): { monotonicMs: number; wallMs: number } {
  const valueRow = row(value);
  check(
    finite(valueRow.monotonicMs) && finite(valueRow.wallMs),
    "invalid_parent_stamp"
  );
  return { monotonicMs: valueRow.monotonicMs, wallMs: valueRow.wallMs };
}
function near(a: unknown, b: number): boolean {
  return finite(a) && Math.abs(a - b) < 0.001;
}
async function sourceHashes(directory: string): Promise<Row> {
  check(
    (await realpath(directory)) === directory,
    "noncanonical_source_directory"
  );
  const hashes: Row = {};
  let total = 0;
  let members = 0;
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(directory, relative), {
      withFileTypes: true,
    })) {
      members += 1;
      check(
        members <= 4096 && relative.split("/").length <= 32,
        "source_roster_oversize"
      );
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      check(safe(path) && !entry.isSymbolicLink(), "unsafe_source_member");
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        check(
          entry.isFile() && Object.keys(hashes).length < 2048,
          "invalid_source_roster"
        );
        const data = await bytes(directory, path, 20_000_000);
        total += data.length;
        check(total <= 100_000_000, "source_roster_oversize");
        hashes[path] = fileDigest(data);
      }
    }
  }
  await walk("");
  return sorted(hashes);
}
interface Assignment {
  path: string;
  raw: Buffer;
  sourceDirectory: string;
  sourceHashes: Row;
  taskId: string;
  taskTurns: unknown[];
}
async function assignment(directory: string, pair: Pair): Promise<Assignment> {
  check(safe(pair.pairId) && !pair.pairId.includes("/"), "unsafe_pair_id");
  const prefix = `pairs/${pair.pairId}`;
  const path = `${prefix}/source-assignment.json`;
  const raw = await bytes(directory, path);
  const value = row(JSON.parse(raw.toString("utf8")));
  const input = await json(directory, `${prefix}/pair-input.json`);
  const manifest = await bytes(
    directory,
    `${prefix}/private-oracle.json`,
    20_000_000
  );
  const task = row(JSON.parse(manifest.toString("utf8")));
  const sourceDirectory = join(directory, prefix, "source-originals");
  check(
    value.schemaVersion === 3 &&
      value.pairId === pair.pairId &&
      value.taskId === task.id &&
      input.taskId === task.id &&
      Boolean(task.id),
    "shared_source_identity_mismatch"
  );
  check(
    value.sourceDirectory === sourceDirectory &&
      input.originals === sourceDirectory,
    "shared_source_directory_mismatch"
  );
  check(
    value.manifestSha256 === fileDigest(manifest) &&
      input.manifestSha256 === value.manifestSha256,
    "shared_manifest_hash_mismatch"
  );
  check(
    Array.isArray(input.taskTurns) &&
      input.taskTurns.length > 0 &&
      input.taskTurns.every((turn) => typeof turn === "string") &&
      value.taskTurnsSha256 === fileDigest(JSON.stringify(input.taskTurns)),
    "shared_task_turns_mismatch"
  );
  const hashes = await sourceHashes(sourceDirectory);
  check(
    same(hashes, sorted(value.sourceHashes)) &&
      same(hashes, sorted(input.sourceHashes)) &&
      same(hashes, sorted(task.sources)),
    "shared_source_roster_mismatch"
  );
  return {
    path,
    raw,
    sourceDirectory,
    sourceHashes: hashes,
    taskId: text(task.id),
    taskTurns: input.taskTurns,
  };
}
const REFERENCE_PATHS = [
  "process/process-outcome.json",
  "process/scheduled-arm.json",
  "process/parent-process-events.jsonl",
  "process/runner-stdout.json",
  "process/runner-stderr.log",
  "process/runner-input.json",
  "runtime-identity.json",
] as const;
function expectedIdentity(mapping: Row, start: Row): ScheduledFileArm {
  const expected = {
    attemptId: text(mapping.attemptId),
    harness: mapping.harness as "atlas" | "hermes",
    identitySha256: text(start.identitySha256),
    nativeStateRoot: text(mapping.nativeStateRoot),
    pairId: text(mapping.pairId),
    transportId: text(mapping.transportId),
  };
  check(
    ["atlas", "hermes"].includes(expected.harness) &&
      expected.attemptId === start.id &&
      expected.pairId === start.pairId &&
      expected.harness === start.harness &&
      expected.transportId === start.transportId &&
      HASH.test(expected.identitySha256),
    "parent_identity_mismatch"
  );
  return expected;
}
function validateTiming(
  invocation: Row,
  caller: Row,
  scheduled: Row,
  outcome: Row,
  start: Row,
  budget: Row,
  metadata: Row
): boolean {
  const began = stamp(invocation.attemptStarted),
    invoked = stamp(invocation.invocationStarted),
    helperReturned = stamp(invocation.processHelperReturned),
    returned = stamp(caller.callerInvocationReturned),
    callerStarted = stamp(caller.callerInvocationStarted),
    processStarted = stamp(outcome.started),
    observed = stamp(outcome.processObservedAt);
  const deadline = row(invocation.deadline);
  check(
    same(invocation.attemptStarted, start.attemptStarted) &&
      same(deadline, start.deadline) &&
      same(deadline, scheduled.deadline) &&
      same(deadline, outcome.deadline) &&
      same(scheduled.started, outcome.started) &&
      same(caller.deadline, deadline) &&
      deadline.scope === "scheduled_attempt",
    "parent_deadline_binding_mismatch"
  );
  check(
    finite(deadline.atMonotonicMs) && finite(deadline.atWallMs),
    "invalid_parent_deadline"
  );
  const duration = deadline.atMonotonicMs - began.monotonicMs;
  const synthetic =
    metadata.transportMode === "offline-scripted" &&
    metadata.phase === "pilot" &&
    start.offlineNativeFixture === true;
  check(
    finite(budget.timeoutMs) &&
      duration > 0 &&
      duration <= budget.timeoutMs &&
      (synthetic || near(duration, budget.timeoutMs)) &&
      near(deadline.atWallMs - began.wallMs, duration),
    "deadline_budget_mismatch"
  );
  check(
    began.monotonicMs <= callerStarted.monotonicMs &&
      callerStarted.monotonicMs <= invoked.monotonicMs &&
      invoked.monotonicMs <= processStarted.monotonicMs &&
      processStarted.monotonicMs <= observed.monotonicMs &&
      observed.monotonicMs <= helperReturned.monotonicMs &&
      helperReturned.monotonicMs <= returned.monotonicMs,
    "parent_chronology_mismatch"
  );
  check(
    near(
      invocation.processHelperElapsedMs,
      helperReturned.monotonicMs - invoked.monotonicMs
    ) &&
      near(
        invocation.processHelperElapsedWallMs,
        helperReturned.wallMs - invoked.wallMs
      ),
    "helper_duration_mismatch"
  );
  check(
    near(
      caller.outerInvocationElapsedMs,
      returned.monotonicMs - callerStarted.monotonicMs
    ) &&
      near(
        caller.outerInvocationElapsedWallMs,
        returned.wallMs - callerStarted.wallMs
      ),
    "outer_invocation_duration_mismatch"
  );
  check(
    finite(outcome.elapsedMonotonicMs) &&
      outcome.elapsedMonotonicMs >= 0 &&
      outcome.elapsedMonotonicMs <=
        observed.monotonicMs - processStarted.monotonicMs,
    "process_duration_mismatch"
  );
  return returned.monotonicMs <= deadline.atMonotonicMs;
}
function validateJournal(
  outcome: Row,
  scheduledBytes: Buffer,
  journalBytes: Buffer
): Row[] {
  const events = journalBytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => row(JSON.parse(line)));
  check(
    events.length > 1 && events.length <= 100 && same(events, outcome.events),
    "parent_journal_mismatch"
  );
  check(
    events[0]?.event === "scheduled_receipt_persisted" &&
      events[0]?.scheduledSha256 === fileDigest(scheduledBytes) &&
      events.at(-1)?.event === "process_receipt_finalizing",
    "parent_journal_boundary_mismatch"
  );
  let previous = stamp(outcome.started).monotonicMs;
  for (const event of events) {
    const now = stamp(event).monotonicMs;
    check(
      now >= previous && now <= stamp(outcome.processObservedAt).monotonicMs,
      "parent_event_chronology_mismatch"
    );
    previous = now;
  }
  const named = (name: string) =>
    events.filter((event) => event.event === name);
  check(
    named("spawn_call").length <= 1 &&
      named("spawn_returned").length <= 1 &&
      named("exit").length <= 1 &&
      named("close").length <= 1,
    "duplicate_parent_process_event"
  );
  check(
    (named("close").length === 1) === outcome.closed &&
      (named("exit").length === 1) === Boolean(outcome.exit),
    "process_lifecycle_projection_mismatch"
  );
  if (outcome.pid !== null) {
    check(
      count(outcome.pid) &&
        outcome.pid > 0 &&
        named("spawn_call").length === 1 &&
        named("spawn_returned")[0]?.pid === outcome.pid,
      "parent_pid_mismatch"
    );
    check(
      events.indexOf(named("spawn_call")[0]!) <
        events.indexOf(named("spawn_returned")[0]!),
      "spawn_event_order_mismatch"
    );
  }
  if (outcome.exit) {
    const event = named("exit")[0]!,
      exited = row(outcome.exit);
    check(
      exited.code === event.code &&
        exited.signal === event.signal &&
        stamp(exited.at).monotonicMs >= stamp(outcome.started).monotonicMs &&
        stamp(exited.at).monotonicMs <= stamp(event).monotonicMs,
      "exit_projection_mismatch"
    );
  }
  return events;
}
function validateCapture(
  outcome: Row,
  scheduled: Row,
  events: Row[],
  stream: "stdout" | "stderr",
  raw: Buffer
): boolean {
  const capture = row(outcome[stream]),
    maximum = row(scheduled.limits)[`${stream}Bytes`];
  check(
    count(maximum) &&
      maximum > 0 &&
      maximum <= (stream === "stdout" ? 20_000_000 : 2_000_000),
    "invalid_capture_limit"
  );
  check(
    count(capture.bytesStored) &&
      count(capture.bytesObserved) &&
      capture.bytesStored === raw.length &&
      capture.bytesStored <= maximum &&
      capture.bytesObserved >= raw.length &&
      capture.sha256 === fileDigest(raw),
    "capture_byte_mismatch"
  );
  check(
    capture.overflow === capture.bytesObserved > maximum,
    "capture_overflow_mismatch"
  );
  check(
    capture.streamEndObserved ===
      (events.filter((event) => event.event === `${stream}_end`).length === 1),
    "capture_end_mismatch"
  );
  const complete =
    outcome.closed === true &&
    capture.streamEndObserved === true &&
    capture.overflow === false;
  check(capture.complete === complete, "capture_completion_mismatch");
  return complete;
}
function nativeRequirements(
  observation: NativeFileObservation | null,
  assigned: Assignment,
  expected: ScheduledFileArm,
  processSuccessful: boolean,
  end: Row
): boolean {
  if (!observation) {
    check(
      end.inputIdentical === false &&
        end.boundaryValid === false &&
        end.inspectionAllowed === false &&
        end.status !== "completed",
      "unavailable_native_completion_projection"
    );
    return false;
  }
  const rawCopies = list(observation.sourceCopies);
  const validCopies = rawCopies.filter(
    (value) =>
      fileRecord(value) &&
      typeof value.path === "string" &&
      typeof value.sha256 === "string"
  );
  const copies = validCopies.map(
    (value) => [text(row(value).path), row(value).sha256] as const
  );
  const inputIdentical =
    Array.isArray(observation.sourceCopies) &&
    validCopies.length === rawCopies.length &&
    new Set(copies.map(([path]) => path)).size === copies.length &&
    same(sorted(Object.fromEntries(copies)), assigned.sourceHashes);
  const sessions = observation.sessions.map(row),
    session = sessions[0];
  const boundaryValid =
    sessions.length === 1 &&
    session?.initialHistoryCount === 0 &&
    Array.isArray(session.turns) &&
    session.turns.length === assigned.taskTurns.length &&
    session.turns.every(
      (turn, index) =>
        row(turn).input === assigned.taskTurns[index] &&
        row(turn).status === "completed"
    );
  check(
    end.inputIdentical === inputIdentical &&
      end.boundaryValid === boundaryValid,
    "native_input_projection_mismatch"
  );
  const workspace = text(observation.workspaceRoot);
  const workspaceEligible =
    workspace === resolve(workspace) &&
    (workspace === expected.nativeStateRoot ||
      workspace.startsWith(`${expected.nativeStateRoot}${sep}`));
  const inspectionPossible =
    processSuccessful &&
    workspaceEligible &&
    (expected.harness === "hermes"
      ? row(observation.evidence).artifactInspectionAllowed === true
      : observation.status === "completed");
  check(
    end.inspectionAllowed !== true || inspectionPossible,
    "native_inspection_projection_mismatch"
  );
  return (
    inputIdentical &&
    boundaryValid &&
    inspectionPossible &&
    end.inspectionAllowed === true
  );
}
async function verifyArm(
  directory: string,
  start: Row,
  end: Row,
  assigned: Assignment,
  metadata: Row
): Promise<VerifiedFileParentEvidence> {
  const id = text(start.id);
  check(
    safe(id) && !id.includes("/") && start.measurementVersion === 3,
    "unsafe_or_unversioned_attempt"
  );
  const trial = join(directory, "trials", id);
  const invocationBytes = await referenced(
    trial,
    row(end.processEvidence).invocation,
    "invocation.json"
  );
  const invocation = row(JSON.parse(invocationBytes.toString("utf8")));
  const caller = row(
    JSON.parse(
      (
        await referenced(
          trial,
          row(end.processEvidence).callerReturn,
          "caller-return.json"
        )
      ).toString("utf8")
    )
  );
  check(
    caller.schemaVersion === 3 &&
      (await referenced(trial, caller.invocation, "invocation.json")).equals(
        invocationBytes
      ) &&
      near(end.elapsedMs, Number(caller.outerInvocationElapsedMs)),
    "caller_return_binding_mismatch"
  );
  check(invocation.schemaVersion === 3, "invalid_invocation_version");
  const references = row(invocation.references);
  check(
    same(Object.keys(references).sort(), [...REFERENCE_PATHS].sort()),
    "invocation_reference_set_mismatch"
  );
  const captured = new Map<string, Buffer>();
  for (const path of REFERENCE_PATHS) {
    captured.set(
      path,
      await referenced(
        trial,
        references[path],
        path,
        path.endsWith("runner-stdout.json") ? 20_000_000 : 2_000_000
      )
    );
  }
  const mappingBytes = captured.get("runtime-identity.json")!,
    mapping = row(JSON.parse(mappingBytes.toString("utf8")));
  const expected = expectedIdentity(mapping, start);
  check(
    mapping.schemaVersion === 1 &&
      mapping.repetition === start.repetition &&
      mapping.taskId === assigned.taskId &&
      end.taskId === assigned.taskId,
    "runtime_assignment_identity_mismatch"
  );
  check(
    fileDigest(mappingBytes) === expected.identitySha256 &&
      (
        await bytes(trial, "process/parent-runtime-identity.json", 65_536)
      ).equals(mappingBytes),
    "parent_runtime_bytes_mismatch"
  );
  const scheduledBytes = captured.get("process/scheduled-arm.json")!,
    scheduled = row(JSON.parse(scheduledBytes.toString("utf8")));
  const outcome = row(
    JSON.parse(captured.get("process/process-outcome.json")!.toString("utf8"))
  );
  check(
    scheduled.schemaVersion === 3 &&
      outcome.schemaVersion === 3 &&
      same(scheduled.expected, expected) &&
      same(outcome.expected, expected) &&
      same(invocation.expected, expected),
    "expected_process_identity_mismatch"
  );
  check(
    scheduled.origin === "parent_scheduled_arm" &&
      row(scheduled.launch).cwd === expected.nativeStateRoot &&
      outcome.scheduledSha256 === fileDigest(scheduledBytes),
    "scheduled_process_binding_mismatch"
  );
  const inputBytes = captured.get("process/runner-input.json")!,
    input = row(JSON.parse(inputBytes.toString("utf8")));
  check(
    scheduled.inputSha256 === fileDigest(inputBytes) &&
      (await bytes(trial, "runner-input.json")).equals(inputBytes),
    "parent_input_bytes_mismatch"
  );
  check(
    input.runId === expected.transportId &&
      input.stateRoot === expected.nativeStateRoot &&
      input.sourceDirectory === assigned.sourceDirectory &&
      same(input.taskTurns, assigned.taskTurns) &&
      input.model === metadata.model &&
      same(sorted(input.budget), sorted(metadata.budget)),
    "assigned_native_input_mismatch"
  );
  check(
    (
      await referenced(directory, invocation.sourceAssignment, assigned.path)
    ).equals(assigned.raw) &&
      same(start.sourceAssignment, invocation.sourceAssignment),
    "source_assignment_reference_mismatch"
  );
  check(
    outcome.parentBinding === "bound" &&
      outcome.receiptComplete === true &&
      Array.isArray(outcome.persistenceErrors) &&
      outcome.persistenceErrors.length === 0,
    "incomplete_parent_receipt"
  );
  const withinDeadline = validateTiming(
    invocation,
    caller,
    scheduled,
    outcome,
    start,
    row(metadata.budget),
    metadata
  );
  const events = validateJournal(
    outcome,
    scheduledBytes,
    captured.get("process/parent-process-events.jsonl")!
  );
  const stdout = captured.get("process/runner-stdout.json")!;
  const stdoutComplete = validateCapture(
    outcome,
    scheduled,
    events,
    "stdout",
    stdout
  );
  const stderrComplete = validateCapture(
    outcome,
    scheduled,
    events,
    "stderr",
    captured.get("process/runner-stderr.log")!
  );
  const native = assessFileNativeOutput(stdout, stdoutComplete, expected),
    reported = row(outcome.native);
  check(
    reported.identity === native.identity &&
      reported.reason === native.reason &&
      same(reported.observedIdentity, native.observedIdentity) &&
      reported.reportedStatus === (native.observation?.status ?? null),
    "native_evidence_projection_mismatch"
  );
  const observationBytes = await bytes(trial, "observation.json", 20_000_000);
  check(
    native.observation
      ? observationBytes.equals(stdout)
      : observationBytes.equals(Buffer.from("null")),
    "nullable_observation_bytes_mismatch"
  );
  check(native.identity !== "conflict", "foreign_native_identity");
  const observationFile = native.observation
    ? {
        bytes: stdout.length,
        path: "runner-stdout.json",
        sha256: fileDigest(stdout),
      }
    : null;
  check(
    same(reported.observationFile, observationFile) &&
      same(end.nativeObservation, observationFile),
    "native_raw_reference_mismatch"
  );
  const failures = list(outcome.failures);
  check(
    failures.every((failure) => typeof failure === "string") &&
      outcome.processFailure === failures.length > 0,
    "process_failure_projection_mismatch"
  );
  const processFactsSuccessful =
    outcome.pid !== null &&
    row(outcome.exit).code === 0 &&
    row(outcome.exit).signal === null &&
    outcome.closed === true &&
    !outcome.timedOut &&
    !outcome.drainExpired &&
    stdoutComplete &&
    stderrComplete &&
    native.observation?.status === "completed";
  check(
    outcome.processFailure !== false || processFactsSuccessful,
    "successful_process_facts_missing"
  );
  check(
    row(end.processEvidence).processFailure === outcome.processFailure &&
      row(end.processEvidence).receiptComplete === outcome.receiptComplete &&
      row(end.processEvidence).nativeIdentity === native.identity,
    "end_process_projection_mismatch"
  );
  const processEligible =
    outcome.processFailure === false &&
    processFactsSuccessful &&
    withinDeadline;
  return {
    failures: failures as string[],
    nativeIdentity: native.identity,
    nativeObservation: native.observation,
    nativeRequirementsMet: nativeRequirements(
      native.observation,
      assigned,
      expected,
      outcome.processFailure === false && processFactsSuccessful,
      end
    ),
    parentVerified: true,
    processEligible,
  };
}
/** Disk-backed attribution only. Does not repair old protocols or certify artifact oracles. */
export async function verifyFileParentEvidence(
  directory: string,
  schedule: readonly Pair[],
  ledger: readonly unknown[],
  issues: string[]
): Promise<Map<string, VerifiedFileParentEvidence>> {
  const verified = new Map<string, VerifiedFileParentEvidence>();
  try {
    check(
      (await realpath(directory)) === directory,
      "noncanonical_batch_directory"
    );
    const metadata = await json(directory, "batch.json"),
      completed = await json(directory, "completed.json");
    const scheduleBytes = await bytes(directory, "scheduled-arms.json"),
      materialized = row(JSON.parse(scheduleBytes.toString("utf8")));
    const expectedArms = schedule.flatMap((pair) =>
      pair.order.map((harness) => ({
        attemptId: `${text(metadata.batch)}-${pair.pairId}-${harness}`,
        family: pair.family,
        harness,
        pairId: pair.pairId,
        repetition: pair.repetition,
        variant: pair.variant,
      }))
    );
    check(
      materialized.schemaVersion === 3 &&
        materialized.batch === metadata.batch &&
        same(materialized.arms, expectedArms) &&
        fileDigest(scheduleBytes) === metadata.scheduledArmsSha256 &&
        metadata.scheduledArmsSha256 === completed.scheduledArmsSha256,
      "materialized_schedule_mismatch"
    );
    const ids = new Set(expectedArms.map((arm) => arm.attemptId));
    check(ids.size === expectedArms.length, "duplicate_materialized_arm");
    const events = ledger.map(row),
      starts = events.filter((event) => event.event === "start"),
      ends = events.filter((event) => event.event === "end");
    for (const event of [...starts, ...ends]) {
      check(ids.has(text(event.id)), "unscheduled_parent_lifecycle");
    }
    for (const entry of await readdir(join(directory, "trials"), {
      withFileTypes: true,
    })) {
      check(
        entry.isDirectory() && ids.has(entry.name),
        "unscheduled_trial_directory"
      );
    }
    const assignments = new Map<string, Assignment>();
    for (const pair of schedule) {
      try {
        assignments.set(pair.pairId, await assignment(directory, pair));
      } catch (error) {
        issues.push(
          `file_shared_source:${pair.pairId}:${error instanceof Error ? error.message : "unreadable"}`
        );
      }
    }
    for (const arm of expectedArms) {
      try {
        const beginning = starts.filter((event) => event.id === arm.attemptId),
          ending = ends.filter((event) => event.id === arm.attemptId);
        check(
          beginning.length === 1 &&
            ending.length === 1 &&
            events.indexOf(beginning[0]!) < events.indexOf(ending[0]!),
          "missing_or_duplicate_parent_lifecycle"
        );
        check(
          [beginning[0]!, ending[0]!].every(
            (event) =>
              event.pairId === arm.pairId &&
              event.harness === arm.harness &&
              event.repetition === arm.repetition &&
              event.family === arm.family &&
              event.variant === arm.variant
          ),
          "scheduled_arm_fields_mismatch"
        );
        const assigned = assignments.get(arm.pairId);
        check(assigned, "shared_source_unverified");
        verified.set(
          arm.attemptId,
          await verifyArm(
            directory,
            beginning[0]!,
            ending[0]!,
            assigned,
            metadata
          )
        );
      } catch (error) {
        issues.push(
          `file_parent_evidence:${arm.attemptId}:${error instanceof Error ? error.message : "unreadable"}`
        );
      }
    }
  } catch (error) {
    issues.push(
      `file_parent_inventory:${error instanceof Error ? error.message : "unreadable"}`
    );
  }
  return verified;
}
