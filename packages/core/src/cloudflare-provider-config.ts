import { isValidBaseUrl, normalizeBaseUrl } from "./compatible-provider-config";

export const CLOUDFLARE_API_ROOT =
  "https://api.cloudflare.com/client/v4/accounts";

const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function cloudflareBaseUrlFromAccountId(accountId: string): string {
  return `${CLOUDFLARE_API_ROOT}/${accountId}/ai/v1`;
}

/** Accept either the dashboard account id or an explicit Workers AI API root. */
export function resolveCloudflareAccountInput(input: string): string | null {
  const trimmed = input.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return isValidBaseUrl(trimmed) ? normalizeBaseUrl(trimmed) : null;
  }

  return ACCOUNT_ID_PATTERN.test(trimmed)
    ? cloudflareBaseUrlFromAccountId(trimmed)
    : null;
}
