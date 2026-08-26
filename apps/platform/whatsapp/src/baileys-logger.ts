type ErrorWriter = (...args: unknown[]) => void;

const INIT_QUERY_ERROR = "unexpected error in 'init queries'";
const SAFE_ERROR_TYPES = new Set([
  "AbortError",
  "AggregateError",
  "DOMException",
  "Error",
  "NetworkError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

export function createBaileysLogger(
  writeError: ErrorWriter = console.error.bind(console),
  writeWarning: ErrorWriter = console.warn.bind(console)
) {
  const noop = () => {};
  const writeSafeError = (...args: unknown[]) => {
    writeError("WhatsApp protocol error.", summarizeBaileysError(args));
  };
  const writeSafeWarning = (...args: unknown[]) => {
    writeWarning("WhatsApp protocol warning.", summarizeBaileysError(args));
  };
  const logger = {
    child: () => logger,
    debug: noop,
    error: (...args: unknown[]) => {
      const [context, message] = args;
      if (isInitQueryTimeout(context, message)) {
        return;
      }

      writeSafeError(...args);
    },
    fatal: writeSafeError,
    info: noop,
    level: "silent",
    trace: noop,
    warn: writeSafeWarning,
  };

  return logger;
}

function summarizeBaileysError(args: unknown[]): {
  errorType: string;
  statusCode?: number;
} {
  const context = args[0];
  const error = readNestedError(context);
  const errorType = getSafeWhatsAppErrorType(error);
  const statusCode = readStatusCode(error);

  return statusCode === undefined ? { errorType } : { errorType, statusCode };
}

function readNestedError(context: unknown): unknown {
  try {
    if (context && typeof context === "object" && "err" in context) {
      return context.err;
    }
  } catch {
    return;
  }

  return context;
}

export function getSafeWhatsAppErrorType(error: unknown): string {
  try {
    if (!(error && typeof error === "object" && "name" in error)) {
      return "UnknownError";
    }

    const name = error.name;
    return typeof name === "string" && SAFE_ERROR_TYPES.has(name)
      ? name
      : "UnknownError";
  } catch {
    return "UnknownError";
  }
}

function readStatusCode(error: unknown): number | undefined {
  try {
    if (!(error && typeof error === "object")) {
      return;
    }

    if ("statusCode" in error) {
      const statusCode = asSafeStatusCode(error.statusCode);
      if (statusCode !== undefined) {
        return statusCode;
      }
    }

    if (
      !("output" in error && error.output && typeof error.output === "object")
    ) {
      return;
    }

    return "statusCode" in error.output
      ? asSafeStatusCode(error.output.statusCode)
      : undefined;
  } catch {}
}

function asSafeStatusCode(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 999
    ? value
    : undefined;
}

function isInitQueryTimeout(context: unknown, message: unknown): boolean {
  if (message !== INIT_QUERY_ERROR) {
    return false;
  }

  try {
    if (
      typeof context !== "object" ||
      context === null ||
      !("err" in context)
    ) {
      return false;
    }

    const error = context.err;
    return (
      typeof error === "object" &&
      error !== null &&
      "isBoom" in error &&
      error.isBoom === true &&
      "message" in error &&
      error.message === "Timed Out"
    );
  } catch {
    return false;
  }
}
