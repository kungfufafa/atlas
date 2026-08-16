import { REDACTED_SECRET_VALUE } from "./email-config";

export const REDACTED_MARKER = "[REDACTED]";
export { REDACTED_SECRET_VALUE };

const SENSITIVE_KEY_PATTERNS = [
  /^apikey$/i,
  /^api_key$/i,
  /^token$/i,
  /^accesstoken$/i,
  /^access_token$/i,
  /^refreshtoken$/i,
  /^refresh_token$/i,
  /^secret$/i,
  /^clientsecret$/i,
  /^client_secret$/i,
  /^password$/i,
  /^passwordhash$/i,
  /^password_hash$/i,
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^databaseurl$/i,
  /^database_url$/i,
  /^privatekey$/i,
  /^private_key$/i,
  /^sessionsecret$/i,
  /^session_secret$/i,
  /^webhooksecret$/i,
  /^webhook_secret$/i,
];

const BEARER_PATTERN = /Bearer\s+([A-Za-z0-9_\-.~+/=]+)/gi;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9_ -]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9_ -]+ PRIVATE KEY-----/g;
const DB_URL_AUTH_PATTERN =
  /((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s@/]+):([^@\s/]+)@/gi;
const INLINE_PASSWORD_PATTERN =
  /(password|passwd|pwd)\s*[=:]\s*([^\s,;"'&]+)/gi;
const INLINE_API_KEY_PATTERN =
  /(api[_-]?key|client[_-]?secret|access[_-]?token)\s*[=:]\s*([^\s,;"'&]+)/gi;

const API_KEY_PREFIX_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{16,}/g,
  /tokenrouter-[a-zA-Z0-9_-]{8,}/g,
  /ghp_[a-zA-Z0-9]{30,}/g,
  /xoxb-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{20,}/g,
  /npm_[a-zA-Z0-9]{36}/g,
];

export function isSensitiveKeyName(key: string): boolean {
  const normalized = key.trim().toLowerCase().replace(/[-_]/g, "");
  return SENSITIVE_KEY_PATTERNS.some(
    (pattern) => pattern.test(key) || pattern.test(normalized)
  );
}

export function redactStringValue(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  let result = text;

  // Redact private key blocks
  result = result.replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]");

  // Redact DB URLs
  result = result.replace(DB_URL_AUTH_PATTERN, "$1:[REDACTED]@");

  // Redact Bearer tokens
  result = result.replace(BEARER_PATTERN, "Bearer [REDACTED]");

  // Redact inline password assignments
  result = result.replace(INLINE_PASSWORD_PATTERN, "$1=[REDACTED]");

  // Redact inline API key assignments
  result = result.replace(INLINE_API_KEY_PATTERN, "$1=[REDACTED]");

  // Redact known token prefixes
  for (const pattern of API_KEY_PREFIX_PATTERNS) {
    result = result.replace(pattern, REDACTED_MARKER);
  }

  return result;
}

export function redactSensitiveData<T = unknown>(
  value: T,
  seen = new WeakSet<object>()
): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactStringValue(value) as unknown as T;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    typeof value === "function"
  ) {
    return value;
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) {
      return "[Circular]" as unknown as T;
    }
    seen.add(value as object);

    if (value instanceof Error) {
      const sanitizedError = new Error(redactStringValue(value.message));
      sanitizedError.name = value.name;
      if (value.stack) {
        sanitizedError.stack = redactStringValue(value.stack);
      }
      if (value.cause) {
        sanitizedError.cause = redactSensitiveData(value.cause, seen);
      }
      for (const [k, v] of Object.entries(value)) {
        if (k === "message" || k === "name" || k === "stack" || k === "cause") {
          continue;
        }
        if (isSensitiveKeyName(k)) {
          (sanitizedError as unknown as Record<string, unknown>)[k] =
            REDACTED_MARKER;
        } else {
          (sanitizedError as unknown as Record<string, unknown>)[k] =
            redactSensitiveData(v, seen);
        }
      }
      return sanitizedError as unknown as T;
    }

    if (value instanceof Headers) {
      const sanitizedHeaders = new Headers();
      value.forEach((headerValue, headerKey) => {
        if (isSensitiveKeyName(headerKey)) {
          sanitizedHeaders.set(headerKey, REDACTED_MARKER);
        } else {
          sanitizedHeaders.set(headerKey, redactStringValue(headerValue));
        }
      });
      return sanitizedHeaders as unknown as T;
    }

    if (value instanceof Map) {
      const sanitizedMap = new Map();
      for (const [k, v] of value.entries()) {
        const keyStr = typeof k === "string" ? k : String(k);
        if (isSensitiveKeyName(keyStr)) {
          sanitizedMap.set(k, REDACTED_MARKER);
        } else {
          sanitizedMap.set(k, redactSensitiveData(v, seen));
        }
      }
      return sanitizedMap as unknown as T;
    }

    if (value instanceof Set) {
      const sanitizedSet = new Set();
      for (const item of value.values()) {
        sanitizedSet.add(redactSensitiveData(item, seen));
      }
      return sanitizedSet as unknown as T;
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        redactSensitiveData(item, seen)
      ) as unknown as T;
    }

    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKeyName(k)) {
        sanitizedObj[k] = REDACTED_MARKER;
      } else {
        sanitizedObj[k] = redactSensitiveData(v, seen);
      }
    }
    return sanitizedObj as unknown as T;
  }

  return value;
}
