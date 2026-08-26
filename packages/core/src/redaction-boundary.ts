import { redactSensitiveData } from "./secret-redaction";

export class RedactionBoundaryError extends Error {
  readonly code = "REDACTION_FAILED";

  constructor(message = "Redaction boundary failed.") {
    super(message);
    this.name = "RedactionBoundaryError";
  }
}

export type RedactionSink =
  | "transcript"
  | "evaluator"
  | "memory"
  | "index"
  | "audit"
  | "outbound"
  | "learning";

/**
 * Fail-closed redaction gate. Every persist/index/audit/outbound/learning
 * payload must pass through this before leaving the execution plane.
 */
export function applyRedactionBoundary<T>(value: T, sink: RedactionSink): T {
  try {
    const redacted = redactSensitiveData(value);
    assertNoRawSecretLeak(redacted, sink);
    return redacted;
  } catch (error) {
    if (error instanceof RedactionBoundaryError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new RedactionBoundaryError(
      `Redaction failed for ${sink}: ${message}`
    );
  }
}

const SECRET_LEAK_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{16,}/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /xoxb-[0-9]{8,}-[0-9]{8,}-[a-zA-Z0-9]{16,}/,
  /-----BEGIN (?:[A-Z0-9_ -]+ )?PRIVATE KEY-----/,
];

function assertNoRawSecretLeak(value: unknown, sink: RedactionSink): void {
  const serialized = safeSerialize(value);
  for (const pattern of SECRET_LEAK_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new RedactionBoundaryError(
        `Redaction failed for ${sink}: residual secret pattern.`
      );
    }
  }
}

function safeSerialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
