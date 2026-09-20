const STABLE_CONNECTION_MS = 5 * 60_000;
const MAX_FAST_RECONNECTS = 8;
const RECOVERY_PROBE_DELAY_MS = 5 * 60_000;
// Baileys maps unknown stream errors to 500. That is transient, not a wiped session.
const TERMINAL_STATUS_CODES = new Set([401, 403, 411, 440]);

export function whatsAppReconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}

/** Short-lived opens do not reset the budget and turn flapping into a storm. */
export class WhatsAppReconnectPolicy {
  private attempts = 0;
  private openedAt: number | undefined;
  private halted = false;

  opened(now = Date.now()): void {
    this.openedAt = now;
  }

  closed(statusCode: number | undefined, now = Date.now()): number | null {
    if (statusCode !== undefined && TERMINAL_STATUS_CODES.has(statusCode)) {
      this.halted = true;
    }
    if (this.halted) {
      return null;
    }
    if (
      this.openedAt !== undefined &&
      now - this.openedAt >= STABLE_CONNECTION_MS
    ) {
      this.attempts = 0;
    }
    this.openedAt = undefined;
    const attempt = this.attempts++;
    return attempt < MAX_FAST_RECONNECTS
      ? whatsAppReconnectDelayMs(attempt)
      : RECOVERY_PROBE_DELAY_MS;
  }

  get isHalted(): boolean {
    return this.halted;
  }
}

const STATUS_FIELDS = ["statusCode", "status", "code"] as const;
const ERROR_FIELDS = ["error", "output", "cause", "data", "payload"] as const;
const STATUS_CODE = /^\d{3}$/;

/** Baileys/Boom transports expose codes in several nested error shapes. */
export function extractDisconnectStatusCode(
  value: unknown
): number | undefined {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let statusCode: number | undefined;
  for (let index = 0; index < pending.length && index < 32; index += 1) {
    const item = pending[index];
    if (!item || typeof item !== "object" || seen.has(item)) {
      continue;
    }
    seen.add(item);
    try {
      for (const field of STATUS_FIELDS) {
        const raw = Reflect.get(item, field);
        const code =
          typeof raw === "string" && STATUS_CODE.test(raw) ? Number(raw) : raw;
        if (
          typeof code === "number" &&
          Number.isInteger(code) &&
          code >= 100 &&
          code <= 599
        ) {
          // A transport wrapper must not hide a terminal auth failure below it.
          if (TERMINAL_STATUS_CODES.has(code)) {
            return code;
          }
          statusCode ??= code;
        }
      }
      for (const field of ERROR_FIELDS) {
        pending.push(Reflect.get(item, field));
      }
    } catch {
      // Error reporting must not execute hostile getters or stringify payloads.
    }
  }
  return statusCode;
}
