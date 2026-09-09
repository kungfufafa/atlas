import { posix, win32 } from "node:path";
import type {
  HarnessTask,
  HarnessToolEvent,
  JsonValue,
  OracleCheck,
  TaskEvaluation,
  TaskObservation,
} from "./types";

const FENCED_JSON = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/** Match the controlled tools' relative-path semantics without rewriting receipts. */
export function normalizeTaskPath(input: unknown): string | null {
  if (
    typeof input !== "string" ||
    input.includes("\0") ||
    posix.isAbsolute(input) ||
    win32.isAbsolute(input)
  ) {
    return null;
  }
  const normalized = posix.normalize(input);
  if (normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function sameTaskPath(left: unknown, right: string): boolean {
  const normalized = normalizeTaskPath(left);
  return normalized !== null && normalized === normalizeTaskPath(right);
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function jsonSemanticallyEqual(
  left: JsonValue,
  right: JsonValue
): boolean {
  return canonical(left) === canonical(right);
}

interface FactComparison {
  complete: boolean;
  contradicted: boolean;
}

/** Extra keys/missing fields are contract defects, not evidence of a false fact. */
function compareRequiredFacts(
  actual: JsonValue | undefined,
  expected: JsonValue
): FactComparison {
  if (actual === undefined) {
    return { complete: false, contradicted: false };
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return { complete: false, contradicted: false };
    }
    const matches =
      JSON.stringify(actual.map(canonical).sort()) ===
      JSON.stringify(expected.map(canonical).sort());
    return { complete: matches, contradicted: !matches };
  }
  if (expected !== null && typeof expected === "object") {
    if (
      actual === null ||
      typeof actual !== "object" ||
      Array.isArray(actual)
    ) {
      return { complete: false, contradicted: false };
    }
    const children = Object.entries(expected).map(([key, value]) =>
      compareRequiredFacts(actual[key], value)
    );
    return {
      complete: children.every((item) => item.complete),
      contradicted: children.some((item) => item.contradicted),
    };
  }
  if (actual !== null && typeof actual === "object") {
    return { complete: false, contradicted: false };
  }
  const matches = actual === expected;
  return { complete: matches, contradicted: !matches };
}

function parseJson(text: string | undefined): JsonValue | undefined {
  if (text === undefined) {
    return;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    // A malformed artifact or final answer is scored as a failed check.
  }
}

/** Accept whitespace/key order and one Markdown fence, without an LLM style judge. */
export function parseFinalFacts(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  const unfenced = trimmed.match(FENCED_JSON)?.[1] ?? trimmed;
  const direct = parseJson(unfenced);
  if (direct !== undefined) {
    return direct;
  }
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start >= 0 && end > start
    ? parseJson(unfenced.slice(start, end + 1))
    : undefined;
}

function hasError(event: HarnessToolEvent): boolean {
  if (event.isError === true) {
    return true;
  }
  if (typeof event.result !== "object" || event.result === null) {
    return false;
  }
  const result = event.result as Record<string, unknown>;
  return result.error != null || result.isError === true || result.ok === false;
}

function check(id: string, pass: boolean, detail: string): OracleCheck {
  return { detail, id, pass };
}

function readSucceeded(
  events: HarnessToolEvent[],
  path: string,
  expectedContent?: string
): boolean {
  return events.some((event) => {
    if (
      event.name !== "read_file" ||
      !sameTaskPath(event.arguments.path, path) ||
      hasError(event)
    ) {
      return false;
    }
    if (typeof event.result !== "object" || event.result === null) {
      return false;
    }
    const result = event.result as Record<string, unknown>;
    return (
      typeof result.content === "string" &&
      sameTaskPath(result.path, path) &&
      (expectedContent === undefined || result.content === expectedContent)
    );
  });
}

function writeSucceeded(
  events: HarnessToolEvent[],
  path: string,
  content: string | undefined
): boolean {
  if (content === undefined) {
    return false;
  }
  return events.some((event) => {
    if (
      event.name !== "write_file" ||
      !sameTaskPath(event.arguments.path, path) ||
      event.arguments.content !== content ||
      hasError(event)
    ) {
      return false;
    }
    if (typeof event.result !== "object" || event.result === null) {
      return false;
    }
    const result = event.result as Record<string, unknown>;
    return (
      sameTaskPath(result.path, path) &&
      result.bytes === new TextEncoder().encode(content).byteLength
    );
  });
}

function documentSucceeded(
  events: HarnessToolEvent[],
  id: string,
  task: HarnessTask
): boolean {
  const document = task.documents?.[id];
  return (
    Boolean(document) &&
    events.some((event) => {
      if (
        event.name !== "fetch_document" ||
        event.arguments.id !== id ||
        hasError(event)
      ) {
        return false;
      }
      if (typeof event.result !== "object" || event.result === null) {
        return false;
      }
      const result = event.result as Record<string, unknown>;
      return (
        result.content === document?.content && result.url === document?.url
      );
    })
  );
}

/**
 * Pure independent task oracle. It sees the frozen expected dataset only after
 * execution; expected values must never be included in provider/tool prompts.
 */
export function evaluateTask(
  task: HarnessTask,
  observation: TaskObservation
): TaskEvaluation {
  const checks: OracleCheck[] = [];
  const events = observation.events ?? [];
  const finalFacts = parseFinalFacts(observation.finalText);
  const finalMatches =
    finalFacts !== undefined &&
    jsonSemanticallyEqual(finalFacts, task.expected.finalFacts);
  const facts = compareRequiredFacts(finalFacts, task.expected.finalFacts);
  checks.push(
    check(
      "final_contract",
      finalMatches,
      "The final answer obeys the complete requested structured output contract."
    )
  );
  checks.push(
    check(
      "final_facts_correct",
      facts.complete,
      "The final answer includes every required fact correctly; extra fields and list order are evaluated by the separate contract check."
    )
  );
  checks.push(
    check(
      "terminal_status",
      observation.terminalStatus === "completed",
      "The run reached a completed terminal state within its shared budget."
    )
  );

  const artifactChecks: OracleCheck[] = [];
  for (const expected of task.expected.artifacts) {
    const actual = observation.files[expected.path];
    const parsed = expected.format === "json" ? parseJson(actual) : undefined;
    const pass =
      expected.format === "text"
        ? actual === expected.value
        : parsed !== undefined && jsonSemanticallyEqual(parsed, expected.value);
    artifactChecks.push(
      check(
        `artifact:${expected.path}`,
        pass,
        "Required output exists and its complete contents match the independently computed answer."
      )
    );
    artifactChecks.push(
      check(
        `write_evidence:${expected.path}`,
        writeSucceeded(events, expected.path, actual),
        "A successful write receipt confirms the bytes of the final output."
      )
    );
  }
  checks.push(...artifactChecks);

  const integrityChecks: OracleCheck[] = [];
  for (const [path, content] of Object.entries(task.initialFiles)) {
    integrityChecks.push(
      check(
        `source_unchanged:${path}`,
        observation.files[path] === content,
        "The complete original source bytes are preserved."
      )
    );
  }
  for (const path of task.expected.absentFiles ?? []) {
    integrityChecks.push(
      check(
        `must_not_exist:${path}`,
        !(path in observation.files),
        "An output prohibited by missing evidence was not created."
      )
    );
  }
  const allowedPaths = new Set([
    ...Object.keys(task.initialFiles),
    ...task.expected.artifacts.map((expected) => expected.path),
  ]);
  const unexpected = Object.keys(observation.files).filter(
    (path) => !allowedPaths.has(path)
  );
  integrityChecks.push(
    check(
      "no_unrequested_files",
      unexpected.length === 0,
      unexpected.length > 0
        ? `Unrequested workspace files: ${unexpected.sort().join(", ")}`
        : "Only requested output files were added."
    )
  );
  checks.push(...integrityChecks);

  for (const path of task.expected.requiredReadPaths ?? []) {
    checks.push(
      check(
        `read_evidence:${path}`,
        readSucceeded(events, path, task.initialFiles[path]),
        "A real successful read_file receipt supports use of this source."
      )
    );
  }
  for (const sequence of task.expected.recoverySequences ?? []) {
    const failedIndexes = events.flatMap((event, index) =>
      event.name === "read_file" &&
      sameTaskPath(event.arguments.path, sequence.failedPath) &&
      hasError(event)
        ? [index]
        : []
    );
    const recoveredIndex = events.findIndex((event) =>
      readSucceeded(
        [event],
        sequence.recoveredPath,
        task.initialFiles[sequence.recoveredPath]
      )
    );
    checks.push(
      check(
        `recovery_order:${sequence.failedPath}`,
        failedIndexes.length === 1 && recoveredIndex > failedIndexes[0]!,
        "The unavailable read occurred exactly once, before the successful fallback read."
      )
    );
  }
  for (const path of task.expected.requiredFailedReads ?? []) {
    const failed = events.some(
      (event) =>
        event.name === "read_file" &&
        sameTaskPath(event.arguments.path, path) &&
        hasError(event)
    );
    checks.push(
      check(
        `recovery_evidence:${path}`,
        failed,
        "The declared unavailable-file error actually occurred before completion."
      )
    );
  }
  for (const id of task.expected.requiredDocumentIds ?? []) {
    checks.push(
      check(
        `document_evidence:${id}`,
        documentSucceeded(events, id, task),
        "The supplied document was fetched with its actual source URL and content."
      )
    );
  }

  const claimedCompletion =
    finalFacts !== null &&
    typeof finalFacts === "object" &&
    !Array.isArray(finalFacts) &&
    finalFacts.status === "completed";
  const integrityFailure = integrityChecks.some((item) => !item.pass);
  const falseCompletion =
    Boolean(claimedCompletion) &&
    (facts.contradicted ||
      artifactChecks.some(
        (item) => item.id.startsWith("artifact:") && !item.pass
      ) ||
      integrityFailure);
  const passed = checks.filter((item) => item.pass).length;
  return {
    checks,
    falseCompletion,
    integrityFailure,
    pass: passed === checks.length,
    score: passed / checks.length,
  };
}
