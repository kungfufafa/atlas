import { createHash } from "node:crypto";

export interface ScheduledFileArm {
  readonly attemptId: string;
  readonly harness: "atlas" | "hermes";
  readonly identitySha256: string;
  readonly nativeStateRoot: string;
  readonly pairId: string;
  readonly transportId: string;
}
export interface NativeFileObservation extends Record<string, unknown> {
  finalText: string;
  framework: "atlas" | "hermes";
  nativeEvents: unknown[];
  runId: string;
  sessions: unknown[];
  status: string;
}
export interface NativeFileOutput {
  identity: "unavailable" | "conflict" | "bound";
  observation: NativeFileObservation | null;
  observedIdentity: { framework: unknown; runId: unknown } | null;
  reason: string;
}
export const fileDigest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const fileRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const MAX_NATIVE_JSON_DEPTH = 128;
function boundedNativeStructure(value: unknown, depth = 0): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (depth >= MAX_NATIVE_JSON_DEPTH) {
    return false;
  }
  for (const child of Object.values(value)) {
    if (!boundedNativeStructure(child, depth + 1)) {
      return false;
    }
  }
  return true;
}

/** No expected field is inserted into native output, even for a failed arm. */
export function assessFileNativeOutput(
  bytes: Uint8Array,
  complete: boolean,
  expected: ScheduledFileArm
): NativeFileOutput {
  const unavailable = (reason: string): NativeFileOutput => ({
    identity: "unavailable",
    observation: null,
    observedIdentity: null,
    reason,
  });
  if (!complete) {
    return unavailable("capture_incomplete");
  }
  if (!bytes.byteLength) {
    return unavailable("empty_output");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return unavailable("invalid_json");
  }
  if (!fileRecord(raw)) {
    return unavailable("invalid_shape");
  }
  const observedIdentity = {
    framework: typeof raw.framework === "string" ? raw.framework : null,
    runId: typeof raw.runId === "string" ? raw.runId : null,
  };
  if (
    (typeof raw.framework === "string" &&
      raw.framework.length > 0 &&
      raw.framework !== expected.harness) ||
    (typeof raw.runId === "string" &&
      raw.runId.length > 0 &&
      raw.runId !== expected.transportId)
  ) {
    return {
      identity: "conflict",
      observation: null,
      observedIdentity,
      reason: "conflicting_identity",
    };
  }
  if (
    raw.framework !== expected.harness ||
    raw.runId !== expected.transportId
  ) {
    return { ...unavailable("missing_identity"), observedIdentity };
  }
  if (
    typeof raw.status !== "string" ||
    typeof raw.finalText !== "string" ||
    !Array.isArray(raw.sessions) ||
    !Array.isArray(raw.nativeEvents)
  ) {
    return { ...unavailable("invalid_shape"), observedIdentity };
  }
  if (!boundedNativeStructure(raw)) {
    return { ...unavailable("invalid_json_structure"), observedIdentity };
  }
  return {
    identity: "bound",
    observation: raw as NativeFileObservation,
    observedIdentity,
    reason: "matching_identity",
  };
}

export interface FileProcessSummary {
  expected: ScheduledFileArm;
  native: {
    identity: NativeFileOutput["identity"];
    reportedStatus: string | null;
  };
  parentBinding: "bound" | "conflict" | "unavailable";
  processFailure: boolean;
  receiptComplete: boolean;
}
/** Inventory only, not a score or amendment to any prior validity definition. */
export function censusScheduledFileArms(
  schedule: readonly ScheduledFileArm[],
  records: readonly FileProcessSummary[]
) {
  const known = new Set(schedule.map((arm) => arm.attemptId));
  const rows = schedule.map((expected) => {
    const matches = records.filter(
      (record) => record.expected.attemptId === expected.attemptId
    );
    const duplicates =
      schedule.filter(
        (arm) =>
          arm.attemptId === expected.attemptId ||
          arm.transportId === expected.transportId ||
          arm.nativeStateRoot === expected.nativeStateRoot
      ).length !== 1;
    const record = matches.length === 1 ? matches[0]! : undefined;
    let state:
      | "missing"
      | "duplicate"
      | "conflict"
      | "incomplete_parent"
      | "observed_failure"
      | "native_candidate";
    if (duplicates || matches.length > 1) {
      state = "duplicate";
    } else if (!record) {
      state = "missing";
    } else if (
      (
        [
          "attemptId",
          "harness",
          "identitySha256",
          "nativeStateRoot",
          "pairId",
          "transportId",
        ] as const
      ).some((key) => record.expected[key] !== expected[key]) ||
      record.native.identity === "conflict" ||
      record.parentBinding === "conflict"
    ) {
      state = "conflict";
    } else if (
      !record.receiptComplete ||
      record.parentBinding === "unavailable"
    ) {
      state = "incomplete_parent";
    } else if (
      record.processFailure ||
      record.native.identity !== "bound" ||
      record.native.reportedStatus !== "completed"
    ) {
      state = "observed_failure";
    } else {
      state = "native_candidate";
    }
    return { expected, records: matches.length, state };
  });
  return {
    calculatesScores: false as const,
    rows,
    unscheduled: records.filter(
      (record) => !known.has(record.expected.attemptId)
    ),
  };
}
