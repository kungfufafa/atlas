import { CesaEngineError } from "./errors";

const SESSION_ID = /^rekrutmen-[1-9][0-9]*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateCesaSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id)) {
    throw new CesaEngineError(
      "ID sesi WhatsApp tidak valid.",
      422,
      "invalid_session"
    );
  }
  return id;
}

export function validateCesaMessageKey(key: unknown): string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 200 ||
    key.trim() !== key ||
    key === "." ||
    key === ".." ||
    CONTROL_CHARS.test(key)
  ) {
    throw new CesaEngineError(
      "Kunci pengiriman WhatsApp tidak valid.",
      422,
      "invalid_idempotency_key"
    );
  }
  return key;
}
