export type TaskSplit = "development" | "holdout";

export type TaskCategory =
  | "numeric_fidelity"
  | "file_transformation"
  | "evidence_and_recovery"
  | "long_context_and_continuation"
  | "corrections_and_supplied_memory"
  | "source_grounding";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TaskDocument {
  content: string;
  title: string;
  url: string;
}

export type ExpectedArtifact =
  | { format: "json"; path: string; value: JsonValue }
  | { format: "text"; path: string; value: string };

export interface TaskExpectation {
  absentFiles?: string[];
  artifacts: ExpectedArtifact[];
  finalFacts: { [key: string]: JsonValue };
  recoverySequences?: Array<{ failedPath: string; recoveredPath: string }>;
  requiredDocumentIds?: string[];
  requiredFailedReads?: string[];
  requiredReadPaths?: string[];
}

export interface HarnessTask {
  category: TaskCategory;
  documents?: Record<string, TaskDocument>;
  expected: TaskExpectation;
  family: string;
  id: string;
  initialFiles: Record<string, string>;
  /** Alias for the first turn; runners must use turns, without duplicating prompt. */
  prompt: string;
  seed: number;
  split: TaskSplit;
  turns: string[];
}

export interface HarnessToolEvent {
  arguments: Record<string, unknown>;
  isError?: boolean;
  name: string;
  result?: unknown;
}

export interface TaskObservation {
  events?: HarnessToolEvent[];
  /** Snapshot of every workspace file after the final turn. */
  files: Record<string, string>;
  finalText: string;
  terminalStatus?: "completed" | "failed" | "cancelled" | "budget_exceeded";
}

export interface OracleCheck {
  detail: string;
  id: string;
  pass: boolean;
}

export interface TaskEvaluation {
  checks: OracleCheck[];
  /** Claimed completion contradicted by known required facts, artifact contents or integrity. */
  falseCompletion: boolean;
  integrityFailure: boolean;
  pass: boolean;
  score: number;
}
