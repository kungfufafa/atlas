import { AtlasApiError, type ProviderCapabilityId } from "@atlas/core";

export type CapabilityUnavailableReason =
  | "adapter-missing"
  | "binding-disabled"
  | "binding-missing"
  | "credentials-missing"
  | "handler-missing"
  | "model-unknown"
  | "model-unsupported"
  | "provider-instance-missing";

export interface CapabilityRouteAttempt {
  modelId: string;
  providerId: string;
  reasons: CapabilityUnavailableReason[];
}

export type CapabilityErrorCode =
  | "CAPABILITY_ADAPTER_MISSING"
  | "CAPABILITY_CREDENTIALS_MISSING"
  | "CAPABILITY_NOT_CONFIGURED"
  | "CAPABILITY_UNKNOWN"
  | "CAPABILITY_UNSUPPORTED";

export class ProviderCapabilityError extends AtlasApiError {
  readonly attempts: CapabilityRouteAttempt[];
  readonly capabilityId: ProviderCapabilityId;
  readonly code: CapabilityErrorCode;

  constructor(options: {
    attempts?: CapabilityRouteAttempt[];
    capabilityId: ProviderCapabilityId;
    code: CapabilityErrorCode;
    message: string;
    status?: number;
  }) {
    super(options.message, options.status ?? 422);
    this.attempts = options.attempts ?? [];
    this.capabilityId = options.capabilityId;
    this.code = options.code;
  }
}
