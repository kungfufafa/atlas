export class WhatsAppDeliveryRetryableError extends Error {
  readonly code = "WHATSAPP_DELIVERY_RETRYABLE";
  readonly retryable = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/**
 * Marks an inbound handler failure that happened before the handler crossed an
 * irreversible boundary. Only this error is safe for the socket layer to replay
 * locally; every unmarked failure is treated as delivery-unknown.
 */
export class WhatsAppInboundReplaySafeError extends Error {
  readonly code = "WHATSAPP_INBOUND_REPLAY_SAFE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WhatsAppInboundReplaySafeError";
  }
}

export function isWhatsAppDeliveryRetryableError(
  error: unknown
): error is WhatsAppDeliveryRetryableError {
  if (error instanceof WhatsAppDeliveryRetryableError) {
    return true;
  }

  if (!(error && typeof error === "object" && "code" in error)) {
    return false;
  }

  return error.code === "WHATSAPP_DELIVERY_RETRYABLE";
}

export function isWhatsAppInboundReplaySafeError(
  error: unknown
): error is WhatsAppInboundReplaySafeError {
  if (error instanceof WhatsAppInboundReplaySafeError) {
    return true;
  }

  if (!(error && typeof error === "object" && "code" in error)) {
    return false;
  }

  return error.code === "WHATSAPP_INBOUND_REPLAY_SAFE";
}
