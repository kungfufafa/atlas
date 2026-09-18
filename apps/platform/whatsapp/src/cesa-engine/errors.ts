export class CesaEngineError extends Error {
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode = 500,
    errorCode = "engine_error",
    retryable = false
  ) {
    super(message);
    this.name = "CesaEngineError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}
