import type { CustomModelEntry } from "@atlas/core";

export type MemoryCondition = "native-default" | "explicit-memory";
export type MemorySplit = "development" | "confirmatory";
export type MemoryIdentity =
  | "same-owner"
  | "different-user"
  | "different-organization";
export type MemoryStatus = "completed" | "failed" | "budget_exceeded";
export type MemoryFamily =
  | "durable_fact"
  | "implicit_preference"
  | "corrected_fact"
  | "distractor_recall"
  | "unsupported_fact"
  | "forgotten_preference"
  | "cross_language"
  | "episodic_decision";
export type MemoryFact = string | number | boolean | null;

/** Evaluator-only object. Never send expected facts to an adapter or model. */
export interface MemoryTask {
  condition: MemoryCondition;
  expected: Record<string, MemoryFact>;
  family: MemoryFamily;
  id: string;
  recallTurns: string[];
  seed: number;
  split: MemorySplit;
  trainingTurns: string[];
}

/** No fixtures, expected answers, seeded target memories or historical answers. */
export interface MemoryRunRequest {
  budget: {
    maxGeneratedTokens: number;
    maxOutputTokens: number;
    maxProviderRequests: number;
    timeoutMs: number;
  };
  coldControl?: boolean;
  condition: MemoryCondition;
  model: string;
  modelMetadata?: {
    entry: CustomModelEntry;
    evidence: {
      endpoint: string;
      model: string;
      observedAt: string;
      source: string;
    };
  };
  proxyBaseUrl: string;
  recallIdentity?: MemoryIdentity;
  recallTurns: string[];
  runId: string;
  /** Optional parent for a newly created disposable run directory. */
  stateRoot?: string;
  thinking?: { effort?: string; enabled: boolean };
  trainingTurns: string[];
}

export interface MemoryTurnResult {
  elapsedMs: number;
  error?: string;
  finalText: string;
  index: number;
  input: string;
  review?: unknown;
  status: MemoryStatus;
  title?: unknown;
}

export interface MemorySessionResult {
  finalHistory?: unknown;
  id: string;
  initialHistoryCount: number;
  nativeStateRoot: string;
  persistedMessages?: unknown;
  phase: "training" | "recall";
  turns: MemoryTurnResult[];
}

export interface MemoryNativeEvent {
  arguments: unknown;
  callId: string;
  name: string;
  observedAt: string;
  phase: "training" | "recall";
  result: unknown;
  sessionId: string;
  turnIndex: number;
}

export interface MemoryRunResult {
  condition: MemoryCondition;
  elapsedMs: number;
  error?: string;
  evidence: Record<string, unknown>;
  finalText: string;
  framework: "atlas" | "hermes";
  model: string;
  nativeEvents: MemoryNativeEvent[];
  runId: string;
  sessions: MemorySessionResult[];
  snapshots: Array<{
    label: string;
    nativeStateRoot: string;
    state: unknown;
  }>;
  status: MemoryStatus;
}

export const MEMORY_BUDGET: MemoryRunRequest["budget"] = Object.freeze({
  maxGeneratedTokens: 12_000,
  maxOutputTokens: 4096,
  maxProviderRequests: 24,
  timeoutMs: 300_000,
});
