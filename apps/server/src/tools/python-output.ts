import { Buffer } from "node:buffer";

export const MAX_PYTHON_OUTPUT_BYTES = 64 * 1024;

export function boundedPythonText(text: string): {
  text: string;
  truncated: boolean;
} {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, MAX_PYTHON_OUTPUT_BYTES);
  // The encoded input is valid UTF-8. Do not end inside a multibyte code point.
  while (
    end > 0 &&
    bytes[end] !== undefined &&
    bytes[end]! >= 128 &&
    bytes[end]! < 192
  ) {
    end--;
  }
  return {
    text: bytes.subarray(0, end).toString("utf8"),
    truncated: bytes.length > end,
  };
}

export function createPythonOutputCapture() {
  const chunks: Buffer[] = [];
  let captured = 0;
  let total = 0;
  return {
    append(chunk: Buffer) {
      total += chunk.length;
      // Up to four extra bytes let decoding complete a character at the bound.
      const retained = chunk.subarray(
        0,
        Math.max(0, MAX_PYTHON_OUTPUT_BYTES + 4 - captured)
      );
      if (retained.length) {
        chunks.push(Buffer.from(retained));
        captured += retained.length;
      }
    },
    read() {
      const result = boundedPythonText(
        Buffer.concat(chunks, captured).toString("utf8")
      );
      return {
        text: result.text,
        truncated: result.truncated || total > MAX_PYTHON_OUTPUT_BYTES,
      };
    },
  };
}
