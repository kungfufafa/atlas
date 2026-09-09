import { evaluateTask } from "../harness-compare/oracles";
import type {
  HarnessTask,
  TaskEvaluation,
  TaskObservation,
} from "../harness-compare/types";

const SOLE_JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/** V2 explicitly forbids surrounding prose and additional dumps; V1's fact extractor is more permissive. */
export function finalEnvelope(text: string): boolean {
  const trimmed = text.trim();
  const body = trimmed.match(SOLE_JSON_FENCE)?.[1] ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}

export function evaluateV2Task(
  task: HarnessTask,
  observation: TaskObservation
): TaskEvaluation {
  const original = evaluateTask(task, observation);
  const envelope = {
    detail:
      "The entire final answer is one JSON object, raw or in one sole JSON Markdown fence, with no surrounding prose or additional dump.",
    id: "final_contract_envelope",
    pass: finalEnvelope(observation.finalText),
  };
  const checks = [...original.checks, envelope];
  return {
    ...original,
    checks,
    pass: original.pass && envelope.pass,
    score: checks.filter((check) => check.pass).length / checks.length,
  };
}
