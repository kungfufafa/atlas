import { AsyncLocalStorage } from "node:async_hooks";
import type { GenerateChatInput, ProviderClient } from "@atlas/core";
import { fetchWithoutIdleTimeout } from "@atlas/core";

export const OPENCODE_GO_SESSION_HEADER = "x-opencode-session";
export const DEFAULT_OPENCODE_GO_SESSION_ID = "atlas-opencode-go";

const SESSION_ID_PATTERN = /[^A-Za-z0-9._:-]+/g;
const MAX_SESSION_ID_LENGTH = 128;

const sessionStore = new AsyncLocalStorage<string>();

export function resolveOpenCodeGoSessionId(
  options: { conversationId?: string; providerInstanceId?: string } = {}
): string {
  const conversationId = options.conversationId?.trim();
  if (conversationId) {
    return sanitizeOpenCodeGoSessionId(conversationId);
  }
  const instanceId = options.providerInstanceId?.trim();
  if (instanceId) {
    return sanitizeOpenCodeGoSessionId(`atlas-opencode-go-${instanceId}`);
  }
  return DEFAULT_OPENCODE_GO_SESSION_ID;
}

export function sanitizeOpenCodeGoSessionId(value: string): string {
  const sanitized = value
    .trim()
    .replace(SESSION_ID_PATTERN, "-")
    .slice(0, MAX_SESSION_ID_LENGTH);
  return sanitized.length > 0 ? sanitized : DEFAULT_OPENCODE_GO_SESSION_ID;
}

export function runWithOpenCodeGoSession<T>(
  sessionId: string,
  run: () => T
): T {
  return sessionStore.run(sessionId, run);
}

export function wrapFetchWithOpenCodeGoSession(
  fallbackSessionId: string,
  fetchImpl: typeof fetch = fetchWithoutIdleTimeout
): typeof fetch {
  const wrapped: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(
      OPENCODE_GO_SESSION_HEADER,
      sessionStore.getStore() ?? fallbackSessionId
    );
    return fetchImpl(input, { ...init, headers });
  };
  return wrapped;
}

export function bindOpenCodeGoSession(
  client: ProviderClient,
  options: {
    fallbackSessionId: string;
    providerInstanceId?: string;
  }
): ProviderClient {
  const withChatSession = <T>(
    input: GenerateChatInput,
    run: () => Promise<T>
  ): Promise<T> =>
    runWithOpenCodeGoSession(
      resolveOpenCodeGoSessionId({
        conversationId: input.conversationId,
        providerInstanceId: options.providerInstanceId,
      }),
      run
    );

  return {
    generateChat(input) {
      return withChatSession(input, () => client.generateChat(input));
    },
    generateText(input) {
      return runWithOpenCodeGoSession(options.fallbackSessionId, () =>
        client.generateText(input)
      );
    },
    name: client.name,
    streamChat(input, handlers) {
      return withChatSession(input, () => client.streamChat(input, handlers));
    },
  };
}
