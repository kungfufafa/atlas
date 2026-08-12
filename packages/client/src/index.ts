export {
  AtlasApiError,
  formatClientError as formatError,
} from "@atlas/core/api-error";
export { AtlasClient } from "./client";
export type {
  AtlasClientOptions,
  RemoteChatSession,
  SendMessageArg,
  SendStreamOptions,
  StreamHandler,
  StreamHandlers,
} from "./types";

import type { ProfileSummary } from "@atlas/core/contract";
import { AtlasClient } from "./client";
import type { AtlasClientOptions } from "./types";

export function createClient(options?: AtlasClientOptions): AtlasClient {
  return new AtlasClient(options);
}

export function getProfileAvatarUrl(
  profile: Pick<ProfileSummary, "id" | "hasAvatar" | "updatedAt">
): string | null {
  if (!profile.hasAvatar) {
    return null;
  }

  const query = new URLSearchParams({ v: profile.updatedAt });
  return `/v1/profiles/${encodeURIComponent(profile.id)}/avatar?${query.toString()}`;
}
