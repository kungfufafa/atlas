import type { MemoryFact, MemoryRunResult, MemoryTask } from "./memory-types";

const FENCED_JSON = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Find all balanced outer objects; never select whichever matches the oracle. */
function objectCandidates(text: string): {
  candidates: string[];
  duplicateKey: boolean;
} {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let stringStart = -1;
  let quoted = false;
  let escaped = false;
  let duplicateKey = false;
  const keys = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
        if (
          depth === 1 &&
          text
            .slice(index + 1)
            .trimStart()
            .startsWith(":")
        ) {
          try {
            const key: string = JSON.parse(text.slice(stringStart, index + 1));
            duplicateKey ||= keys.has(key);
            keys.add(key);
          } catch {
            return { candidates: [], duplicateKey: false };
          }
        }
      }
    } else if (char === '"' && depth > 0) {
      quoted = true;
      stringStart = index;
    } else if (char === "{") {
      if (depth === 0) {
        start = index;
        keys.clear();
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) {
        return { candidates: [], duplicateKey: false };
      }
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
      }
    }
  }
  return { candidates: depth === 0 ? candidates : [], duplicateKey };
}

function parseFinal(text: string): {
  ambiguous: boolean;
  facts: Record<string, unknown> | null;
  strict: boolean;
} {
  const { candidates, duplicateKey } = objectCandidates(text);
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate || duplicateKey) {
    return {
      ambiguous: candidates.length > 1 || duplicateKey,
      facts: null,
      strict: false,
    };
  }
  const trimmed = text.trim();
  const strictText = FENCED_JSON.exec(trimmed)?.[1] ?? trimmed;
  return {
    ambiguous: false,
    facts: parseObject(candidate),
    strict: strictText.trim() === candidate.trim(),
  };
}

function factMatches(actual: unknown, expected: MemoryFact): boolean {
  return typeof expected === "string" && typeof actual === "string"
    ? actual.trim().toLocaleLowerCase("en-US") ===
        expected.toLocaleLowerCase("en-US")
    : actual === expected;
}

export interface MemoryVerdict {
  ambiguousFinal: boolean;
  boundaryValid: boolean;
  /** Demonstrably wrong required values, not extra keys or invalid JSON alone. */
  falseCompletion: boolean;
  finalContract: boolean;
  finalFactsCorrect: boolean;
  missingFacts: string[];
  strictSuccess: boolean;
  success: boolean;
  wrongFacts: string[];
}

/** Product recall accuracy, not a proof that a particular memory mechanism ran. */
export function evaluateMemoryTask(
  task: MemoryTask,
  result: Pick<MemoryRunResult, "finalText" | "sessions" | "status">,
  expected: Record<string, MemoryFact> = task.expected
): MemoryVerdict {
  const parsed = parseFinal(result.finalText);
  const final = parsed.facts;
  const missingFacts = Object.keys(expected).filter(
    (key) => !(final && Object.hasOwn(final, key))
  );
  const wrongFacts = Object.entries(expected)
    .filter(
      ([key, value]) =>
        final && Object.hasOwn(final, key) && !factMatches(final[key], value)
    )
    .map(([key]) => key);
  const finalFactsCorrect =
    final !== null && missingFacts.length === 0 && wrongFacts.length === 0;
  const finalContract =
    final !== null &&
    parsed.strict &&
    finalFactsCorrect &&
    Object.keys(final).length === Object.keys(expected).length;
  const [training, recall] = result.sessions;
  const boundaryValid = Boolean(
    result.sessions.length === 2 &&
      training?.phase === "training" &&
      recall?.phase === "recall" &&
      training.id !== recall.id &&
      training.initialHistoryCount === 0 &&
      recall.initialHistoryCount === 0 &&
      training.turns.length === task.trainingTurns.length &&
      recall.turns.length === task.recallTurns.length &&
      training.turns.every(
        (turn, index) =>
          turn.status === "completed" &&
          turn.input === task.trainingTurns[index]
      ) &&
      recall.turns.every(
        (turn, index) =>
          turn.status === "completed" && turn.input === task.recallTurns[index]
      )
  );
  return {
    ambiguousFinal: parsed.ambiguous,
    boundaryValid,
    falseCompletion: wrongFacts.length > 0,
    finalContract,
    finalFactsCorrect,
    missingFacts,
    strictSuccess:
      result.status === "completed" && boundaryValid && finalContract,
    success:
      result.status === "completed" && boundaryValid && finalFactsCorrect,
    wrongFacts,
  };
}

/** Cold/foreign identity controls are reported separately, never pooled. */
export function unknownMemoryExpectation(
  task: MemoryTask
): Record<string, null> {
  return Object.fromEntries(
    Object.keys(task.expected).map((key) => [key, null])
  );
}
