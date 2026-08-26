import { homedir } from "node:os";

const MAX_TEXT_LENGTH = 4000;
const MAX_INSPECTED_TEXT_LENGTH = 8192;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN (?:[A-Z0-9_ -]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9_ -]+ )?PRIVATE KEY-----|$)/gi,
    "<redacted-private-key>",
  ],
  [
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n,;]+/gi,
    "Authorization: <redacted>",
  ],
  [/\b(?:cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "Cookie: <redacted>"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, "Bearer <redacted>"],
  [/\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, "Basic <redacted>"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "<redacted-key>"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted-key>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "<redacted-key>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-key>"],
  [
    /\b([A-Za-z0-9_]{0,64}(?:api[_-]?key|apikey|token|secret|passwd|password|authorization|credential|cookie|session(?:id)?))(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;)}]{3,})/gi,
    "$1$2<redacted>",
  ],
  [/\bhttps?:\/\/[^\s"'<>]+/gi, "<url>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted-token>"],
];

const HOME_PATH_PATTERNS: RegExp[] = [
  /\/(?:Users|home)\/[^/\s:"']+/g,
  /[A-Za-z]:\\Users\\[^\\\s:"']+/g,
];

/**
 * JSON and printed structures in error messages often contain tenant data even
 * when they contain no recognizable credential, so collapse those payloads too.
 */
function redactStructuredPayloads(value: string): string {
  const output: string[] = [];
  let depth = 0;

  for (const character of value) {
    if (character === "{" || character === "[") {
      if (depth === 0) {
        output.push("<redacted>");
      }
      depth += 1;
      continue;
    }

    if (depth > 0) {
      if (character === "}" || character === "]") {
        depth -= 1;
      }
      continue;
    }

    output.push(character);
  }

  return output.join("");
}

function redactQuotedPayloads(value: string): string {
  return redactStructuredPayloads(value.replace(/"[^"\n]*"/g, '"<redacted>"'));
}

export function scrubText(value: string): string {
  if (!value) {
    return "";
  }

  let output = value.slice(0, MAX_INSPECTED_TEXT_LENGTH);
  const home = homedir();

  if (home && home !== "/") {
    output = output.split(home).join("~");
  }

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }

  for (const pattern of HOME_PATH_PATTERNS) {
    output = output.replace(pattern, "~");
  }

  output = redactQuotedPayloads(output);

  return output.length > MAX_TEXT_LENGTH
    ? `${output.slice(0, MAX_TEXT_LENGTH)}…`
    : output;
}
