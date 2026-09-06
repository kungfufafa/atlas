export interface SerializedToolOutput {
  data: unknown;
  text: string;
  warnings: string[];
}

/** Tool completion must survive JSON conversion for model history, events, and storage. */
export function serializeToolOutput(value: unknown): SerializedToolOutput {
  if (typeof value === "string") {
    return { data: value, text: value, warnings: [] };
  }

  const ancestors: object[] = [];
  const warnings = new Set<string>();
  try {
    const text =
      JSON.stringify(value, function (this: unknown, _key, current: unknown) {
        if (typeof current === "bigint") {
          warnings.add("BigInt output values were encoded as decimal strings.");
          return current.toString();
        }
        if (typeof current !== "object" || current === null) {
          return current;
        }

        while (ancestors.length > 0 && ancestors.at(-1) !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(current)) {
          warnings.add(
            "Circular output references were replaced with [Circular]."
          );
          return "[Circular]";
        }
        ancestors.push(current);
        return current;
      }) ?? "null";
    return { data: JSON.parse(text), text, warnings: [...warnings] };
  } catch (error) {
    const data = {
      guidance:
        "Do not repeat the action solely because its output could not be serialized.",
      outputUnavailable: true,
      serializationError: serializationErrorMessage(error),
      toolExecutionCompleted: true,
    };
    return {
      data,
      text: JSON.stringify(data),
      warnings: ["The tool completed, but its output could not be serialized."],
    };
  }
}

function serializationErrorMessage(error: unknown): string {
  try {
    if (error && typeof error === "object") {
      const message: unknown = Reflect.get(error, "message");
      if (typeof message === "string") {
        return message;
      }
    }
    return String(error);
  } catch {
    return "Unknown output serialization error.";
  }
}
