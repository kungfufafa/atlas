import type {
  ChatCompletionResult,
  ChatMessage,
  ProviderContentProtocol,
  ProviderContentProvenance,
  ProviderName,
  StreamChatHandlers,
  ThinkingEffort,
  ToolCall,
} from "@atlas/core";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Atlas/1.0";

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function buildTokenUsage(options: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
}): ChatCompletionResult["usage"] | undefined {
  let inputTokens = readNumber(options.inputTokens);
  let outputTokens = readNumber(options.outputTokens);
  let totalTokens = readNumber(options.totalTokens);

  if (inputTokens === undefined && outputTokens === undefined) {
    return;
  }

  if (
    inputTokens === undefined &&
    totalTokens !== undefined &&
    outputTokens !== undefined
  ) {
    inputTokens = Math.max(totalTokens - outputTokens, 0);
  }

  if (
    outputTokens === undefined &&
    totalTokens !== undefined &&
    inputTokens !== undefined
  ) {
    outputTokens = Math.max(totalTokens - inputTokens, 0);
  }

  if (inputTokens === undefined || outputTokens === undefined) {
    return;
  }

  if (totalTokens === undefined) {
    totalTokens = inputTokens + outputTokens;
  }

  return { inputTokens, outputTokens, totalTokens };
}

export function extractOpenAITokenUsage(
  value: unknown
): ChatCompletionResult["usage"] | undefined {
  const record = readRecord(value);
  return buildTokenUsage({
    inputTokens: record.prompt_tokens,
    outputTokens: record.completion_tokens,
    totalTokens: record.total_tokens,
  });
}

export function extractAnthropicTokenUsage(
  value: unknown
): ChatCompletionResult["usage"] | undefined {
  const record = readRecord(value);
  return buildTokenUsage({
    inputTokens: record.input_tokens,
    outputTokens: record.output_tokens,
  });
}

export function extractGeminiTokenUsage(
  value: unknown
): ChatCompletionResult["usage"] | undefined {
  const record = readRecord(value);
  return buildTokenUsage({
    inputTokens: record.promptTokenCount,
    outputTokens: record.candidatesTokenCount,
    totalTokens: record.totalTokenCount,
  });
}

export function notifyToolInputDelta(
  handlers: StreamChatHandlers | undefined,
  call: { id: string; name: string; arguments: string },
  delta: string
): void {
  if (!(handlers?.onToolInputDelta && call.id && call.name && delta)) {
    return;
  }

  handlers.onToolInputDelta({
    accumulatedArguments: call.arguments,
    delta,
    tool: call.name,
    toolCallId: call.id,
  });
}

export function buildChatCompletionResult(options: {
  content: string | null | undefined;
  toolCalls: ToolCall[];
  thinking?: string | null | undefined;
  providerContent?: unknown[];
  providerContentProvenance?: ProviderContentProvenance;
  usage?: ChatCompletionResult["usage"];
}): ChatCompletionResult {
  const content = options.content?.trim() ?? "";
  const thinking = options.thinking?.trim();
  const assistantMessage: Extract<ChatMessage, { role: "assistant" }> = {
    content,
    role: "assistant",
    ...(thinking ? { thinking } : {}),
    ...(options.toolCalls.length > 0 ? { toolCalls: options.toolCalls } : {}),
    ...(options.providerContent?.length
      ? {
          providerContent: options.providerContent,
          ...(options.providerContentProvenance
            ? {
                providerContentProvenance: options.providerContentProvenance,
              }
            : {}),
        }
      : {}),
  };

  return {
    assistantMessage,
    content,
    toolCalls: options.toolCalls,
    ...(options.usage ? { usage: options.usage } : {}),
  };
}

export function hasMatchingProviderContent(
  message: Extract<ChatMessage, { role: "assistant" }>,
  provider: ProviderName,
  protocol: ProviderContentProtocol,
  providerInstanceId?: string,
  modelId?: string,
  providerReplayRevision?: string
): boolean {
  const provenance = message.providerContentProvenance;

  if (!message.providerContent?.length) {
    return false;
  }

  if (!provenance) {
    // Once the active endpoint is identifiable, legacy opaque payloads have no
    // trustworthy source binding. Rebuild them from normalized text/tool calls
    // instead of replaying model- or instance-bound signatures across configs.
    if (providerInstanceId || modelId || providerReplayRevision) {
      return false;
    }
    return isConservativeLegacyProviderContent(
      message.providerContent,
      protocol,
      provider
    );
  }

  if (provenance.provider !== provider || provenance.protocol !== protocol) {
    return false;
  }

  if (
    (provenance.providerInstanceId || providerInstanceId) &&
    provenance.providerInstanceId !== providerInstanceId
  ) {
    return false;
  }

  if ((provenance.modelId || modelId) && provenance.modelId !== modelId) {
    return false;
  }

  if (provenance.providerReplayRevision || providerReplayRevision) {
    return provenance.providerReplayRevision === providerReplayRevision;
  }

  return true;
}

const LEGACY_ANTHROPIC_BLOCK_TYPES = new Set([
  "code_execution_tool_result",
  "redacted_thinking",
  "server_tool_use",
  "text",
  "thinking",
  "tool_search_tool_result",
  "tool_search_tool_use",
  "tool_use",
  "web_fetch_tool_result",
  "web_search_tool_result",
]);

function isConservativeLegacyProviderContent(
  content: unknown[],
  protocol: ProviderContentProtocol,
  provider: ProviderName
): boolean {
  if (protocol === "openai-responses") {
    // Legacy Responses items can carry endpoint-bound IDs. Without an instance
    // source they must be reconstructed from normalized content/tool calls.
    return false;
  }

  if (protocol === "anthropic-messages") {
    if (provider !== "anthropic") {
      return false;
    }

    return content.every((item) => {
      const type = readRecord(item).type;
      return typeof type === "string" && LEGACY_ANTHROPIC_BLOCK_TYPES.has(type);
    });
  }

  if (provider !== "gemini") {
    return false;
  }

  return content.every((item) => {
    const part = readRecord(item);
    return (
      !("type" in part) &&
      ("functionCall" in part ||
        "inlineData" in part ||
        "text" in part ||
        "thought" in part ||
        "thoughtSignature" in part)
    );
  });
}

/**
 * Drop orphaned assistant tool_calls / tool results so partial histories cannot
 * produce provider 400s ("insufficient tool messages following tool_calls").
 * Intact tool_call ↔ tool pairs are left untouched.
 */
export function sanitizeToolCallHistory(
  messages: ChatMessage[]
): ChatMessage[] {
  const toolResultIds = new Set(
    messages
      .filter(
        (message): message is Extract<ChatMessage, { role: "tool" }> =>
          message.role === "tool"
      )
      .map((message) => message.toolCallId)
  );

  const validToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      continue;
    }

    const ids = message.toolCalls.map((call) => call.id);
    if (ids.every((id) => toolResultIds.has(id))) {
      for (const id of ids) {
        validToolCallIds.add(id);
      }
    }
  }

  return messages.filter((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return message.toolCalls.every((call) => validToolCallIds.has(call.id));
    }

    if (message.role === "assistant") {
      return Boolean(message.content.trim() || message.thinking?.trim());
    }

    if (message.role === "tool") {
      return validToolCallIds.has(message.toolCallId);
    }

    return true;
  });
}

export interface SseEvent {
  data: string;
  event: string;
}

export interface ReadSseEventsOptions {
  includeDoneSentinel?: boolean;
}

export async function readSseEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void | Promise<void>,
  options?: ReadSseEventsOptions
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }

    if (done) {
      buffer += decoder.decode();
    }

    while (true) {
      const boundary = findSseBoundary(buffer);

      if (!boundary) {
        break;
      }

      const eventBlock = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      await emitSseEvent(eventBlock, onEvent, options);
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    await emitSseEvent(buffer, onEvent, options);
  }
}

async function emitSseEvent(
  eventBlock: string,
  onEvent: (event: SseEvent) => void | Promise<void>,
  options?: ReadSseEventsOptions
): Promise<void> {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of eventBlock.split(/\r?\n/)) {
    const eventValue = readSseField(line, "event:");

    if (eventValue !== null) {
      event = eventValue.trim() || "message";
      continue;
    }

    const dataValue = readSseField(line, "data:");

    if (dataValue !== null) {
      dataLines.push(dataValue);
    }
  }

  const data = dataLines.join("\n");
  const normalized = data.trim();

  if (
    !normalized ||
    (normalized === "[DONE]" && !options?.includeDoneSentinel)
  ) {
    return;
  }

  await onEvent({ data, event });
}

function findSseBoundary(
  buffer: string
): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);

  if (!match || match.index === undefined) {
    return null;
  }

  return {
    index: match.index,
    length: match[0].length,
  };
}

function readSseField(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) {
    return null;
  }

  let value = line.slice(prefix.length);

  if (value.startsWith(" ")) {
    value = value.slice(1);
  }

  return value;
}

export function parseJsonRecord(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return readRecord(parsed);
  } catch {
    return {};
  }
}

export function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Default effort values for providers that don't declare their own.
 * Matches OpenAI, OpenRouter, Fireworks, Cerebras API contracts.
 */
export const DEFAULT_REASONING_EFFORT_VALUES = [
  "low",
  "medium",
  "high",
] as const;
export const DEFAULT_REASONING_EFFORT = "medium";

/**
 * Resolve the effort value to send to a provider API.
 *
 * @param effort  - The user-selected effort string (from profile settings).
 * @param validValues - The ordered list of values this provider/model accepts
 *   (from `ProviderModelOption.reasoningEffortValues` or a hardcoded per-provider
 *   constant). When omitted, falls back to DEFAULT_REASONING_EFFORT_VALUES.
 *
 * Fallback strategy:
 *   1. If the effort is in validValues → return as-is.
 *   2. Otherwise pick the median value (represents "medium" intent).
 */
export function resolveThinkingEffort(
  effort: ThinkingEffort | undefined,
  validValues?: readonly string[] | string[]
): string {
  const valid = validValues ?? DEFAULT_REASONING_EFFORT_VALUES;
  const trimmed = effort?.trim();

  if (trimmed) {
    if (valid.includes(trimmed)) {
      return trimmed;
    }

    // Semantic aliases for cross-provider compatibility:
    if ((trimmed === "high" || trimmed === "max") && valid.includes("xhigh")) {
      return "xhigh";
    }
    if (trimmed === "xhigh" && valid.includes("max")) {
      return "max";
    }
    if ((trimmed === "xhigh" || trimmed === "max") && valid.includes("high")) {
      return "high";
    }
    if ((trimmed === "high" || trimmed === "xhigh") && valid.includes("max")) {
      return "max";
    }
  }

  // Pick the middle index as the "medium" fallback.
  return (
    valid[Math.floor(valid.length / 2)] ?? valid[0] ?? DEFAULT_REASONING_EFFORT
  );
}

/**
 * @deprecated Use resolveThinkingEffort() instead.
 * Kept for backward compatibility — delegates to resolveThinkingEffort with the
 * standard three-value scale.
 */
export function normalizeThinkingEffort(
  effort: ThinkingEffort | undefined
): string {
  return resolveThinkingEffort(effort);
}

export function formatHttpErrorBody(
  label: string,
  status: number,
  body: string
): string {
  const trimmed = body.trim();

  if (!trimmed) {
    return `${label} request failed (${status}).`;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const nested = parsed.error;

    if (
      typeof nested === "object" &&
      nested !== null &&
      !Array.isArray(nested)
    ) {
      const record = nested as Record<string, unknown>;
      const message =
        typeof record.message === "string" ? record.message.trim() : "";
      const type = typeof record.type === "string" ? record.type.trim() : "";

      if (message) {
        return `${label} request failed (${status}${type ? ` ${type}` : ""}): ${message}`;
      }
    }

    const message =
      typeof parsed.message === "string" ? parsed.message.trim() : "";

    if (message) {
      return `${label} request failed (${status}): ${message}`;
    }
  } catch {
    // fall through to raw body
  }

  return `${label} request failed (${status}): ${trimmed.slice(0, 500)}`;
}
