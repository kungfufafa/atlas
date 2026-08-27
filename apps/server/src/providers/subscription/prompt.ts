import { createHash } from "node:crypto";
import type {
  ChatCompletionResult,
  ChatMessage,
  GenerateChatInput,
  LlmToolDefinition,
  SubscriptionProviderKind,
  ToolCall,
} from "@atlas/core";
import { getUserMessageText, resolveUserContentForProvider } from "@atlas/core";
import { buildChatCompletionResult } from "../shared";

const TOOL_CALL_FENCE = "atlas-tool-call";
const TOOL_CALL_FENCE_RE = /```atlas-tool-call\s*([\s\S]*?)```/gi;

export async function formatSubscriptionPrompt(
  input: GenerateChatInput,
  provider: SubscriptionProviderKind,
  previousMessageCount?: number
): Promise<{
  continuation: string;
  continuationInput: SubscriptionPromptInput[];
  developerInstructions: string;
  historyFingerprint: string;
  latestTurn: string;
  previousHistoryFingerprint?: string;
  transcript: string;
  transcriptInput: SubscriptionPromptInput[];
}> {
  const developerInstructions = [
    input.system.trim(),
    formatToolInstructions(input.tools),
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages = await resolveDocuments(input.messages, provider);
  const transcript = formatTranscript(messages);
  const transcriptInput = formatPromptInput(messages);
  const latestTurn = formatLatestTurn(messages) || transcript;
  const continuation = formatContinuation(messages, previousMessageCount);
  const continuationMessages = continuationMessageSlice(
    messages,
    previousMessageCount
  );
  const continuationInput = formatPromptInput(continuationMessages);
  const historyFingerprint = fingerprintMessages(messages);
  const previousHistoryFingerprint =
    previousMessageCount === undefined
      ? undefined
      : fingerprintMessages(messages.slice(0, previousMessageCount));

  return {
    continuation,
    continuationInput,
    developerInstructions,
    historyFingerprint,
    latestTurn,
    ...(previousHistoryFingerprint ? { previousHistoryFingerprint } : {}),
    transcript,
    transcriptInput,
  };
}

export type SubscriptionPromptInput =
  | { text: string; type: "text" }
  | { data: string; mediaType: string; type: "image" };

export function parseSubscriptionResponse(
  raw: string,
  thinking?: string,
  usage?: ChatCompletionResult["usage"]
): ChatCompletionResult {
  const toolCalls: ToolCall[] = [];
  let content = raw;
  TOOL_CALL_FENCE_RE.lastIndex = 0;
  content = content.replace(TOOL_CALL_FENCE_RE, (_match, body: string) => {
    const parsed = parseToolCallJson(String(body ?? "").trim());
    if (parsed) {
      toolCalls.push(parsed);
    }
    return "";
  });

  return buildChatCompletionResult({
    content: content.trim(),
    thinking,
    toolCalls,
    usage,
  });
}

export function appendDelta(
  previous: string,
  next: string
): {
  delta: string;
  text: string;
} {
  if (!next) {
    return { delta: "", text: previous };
  }
  if (!previous) {
    return { delta: next, text: next };
  }
  if (next.startsWith(previous)) {
    return { delta: next.slice(previous.length), text: next };
  }
  if (previous.endsWith(next)) {
    return { delta: "", text: previous };
  }
  return { delta: next, text: previous + next };
}

function formatToolInstructions(
  tools: LlmToolDefinition[] | undefined
): string {
  if (!tools?.length) {
    return "";
  }

  const catalog = tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  schema: ${JSON.stringify(tool.parameters ?? {})}`
    )
    .join("\n");

  return [
    "Atlas executes tools. Do not run shell commands or edit files yourself.",
    "If you need a tool, emit one or more fenced blocks and nothing else in those blocks:",
    "```" + TOOL_CALL_FENCE,
    '{"name":"tool_name","arguments":{}}',
    "```",
    "Available tools:",
    catalog,
  ].join("\n");
}

function formatTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => formatMessage(message))
    .filter(Boolean)
    .join("\n\n");
}

function formatLatestTurn(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return "";
  }

  const last = messages.at(-1);
  if (!last) {
    return "";
  }

  if (last.role === "user") {
    return formatMessage(last);
  }

  const trailing: ChatMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (
      message.role === "tool" ||
      (trailing.length > 0 && message.role === "assistant")
    ) {
      trailing.unshift(message);
      continue;
    }
    if (
      message.role === "user" &&
      trailing.some((entry) => entry.role === "tool")
    ) {
      trailing.unshift(message);
    }
    break;
  }

  return trailing.map((message) => formatMessage(message)).join("\n\n");
}

function formatContinuation(
  messages: ChatMessage[],
  previousMessageCount?: number
): string {
  return continuationMessageSlice(messages, previousMessageCount)
    .map((message) => formatMessage(message))
    .filter(Boolean)
    .join("\n\n");
}

function continuationMessageSlice(
  messages: ChatMessage[],
  previousMessageCount?: number
): ChatMessage[] {
  if (previousMessageCount === undefined) {
    return [];
  }
  return messages
    .slice(previousMessageCount)
    .filter((message) => message.role !== "assistant");
}

function formatPromptInput(messages: ChatMessage[]): SubscriptionPromptInput[] {
  const input: SubscriptionPromptInput[] = [];
  for (const message of messages) {
    if (message.role === "user" && typeof message.content !== "string") {
      appendStructuredUserInput(input, message.content);
      continue;
    }

    const text = formatMessage(message);
    if (text) {
      input.push({ text, type: "text" });
    }
  }
  return input;
}

function appendStructuredUserInput(
  input: SubscriptionPromptInput[],
  content: Exclude<ChatMessage["content"], string>
): void {
  let rolePending = true;

  const appendText = (text: string): void => {
    if (!(text || rolePending)) {
      return;
    }
    input.push({
      text: rolePending ? `User:\n${text}` : text,
      type: "text",
    });
    rolePending = false;
  };

  for (const part of content) {
    if (part.type === "text") {
      appendText(part.text);
      continue;
    }
    if (part.type === "image") {
      if (rolePending) {
        appendText("");
      }
      input.push({
        data: part.data,
        mediaType: part.mediaType,
        type: "image",
      });
      continue;
    }
    if (part.type === "image_ref" && part.description) {
      appendText(`[Image: ${part.description}]`);
    }
  }

  if (rolePending) {
    appendText("");
  }
}

async function resolveDocuments(
  messages: ChatMessage[],
  provider: SubscriptionProviderKind
): Promise<ChatMessage[]> {
  return await Promise.all(
    messages.map(async (message) => {
      if (message.role !== "user") {
        return message;
      }
      return {
        ...message,
        content: await resolveUserContentForProvider(message.content, provider),
      };
    })
  );
}

function fingerprintMessages(messages: ChatMessage[]): string {
  const hash = createHash("sha256");
  hashSegment(hash, "transcript", formatTranscript(messages));

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "user" || typeof message.content === "string") {
      continue;
    }
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type === "image") {
        hashSegment(hash, "message", String(messageIndex));
        hashSegment(hash, "part", String(partIndex));
        hashSegment(hash, "mediaType", part.mediaType.trim().toLowerCase());
        hashSegment(
          hash,
          "imageBytes",
          Buffer.from(part.data.trim(), "base64")
        );
      } else if (part.type === "image_ref") {
        hashSegment(hash, "message", String(messageIndex));
        hashSegment(hash, "part", String(partIndex));
        hashSegment(hash, "attachmentId", part.attachmentId);
        hashSegment(hash, "mediaType", part.mediaType.trim().toLowerCase());
        hashSegment(hash, "size", String(part.size));
      }
    }
  }

  return hash.digest("base64url");
}

function hashSegment(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Uint8Array
): void {
  hash.update(`${label.length}:${label}:`);
  hash.update(
    typeof value === "string"
      ? `${Buffer.byteLength(value)}:`
      : `${value.byteLength}:`
  );
  hash.update(value);
}

function formatMessage(message: ChatMessage): string {
  if (message.role === "user") {
    return `User:\n${getUserMessageText(message.content)}`;
  }
  if (message.role === "assistant") {
    const toolCalls = message.toolCalls
      ?.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`)
      .join(", ");
    const body = [message.content, toolCalls ? `tool calls: ${toolCalls}` : ""]
      .filter(Boolean)
      .join("\n");
    return body ? `Assistant:\n${body}` : "";
  }
  if (message.role === "tool") {
    return `Tool result (${message.name}):\n${message.content}`;
  }
  return "";
}

function parseToolCallJson(raw: string): ToolCall | null {
  try {
    const parsed = JSON.parse(raw) as {
      arguments?: unknown;
      id?: unknown;
      name?: unknown;
    };
    if (typeof parsed.name !== "string" || !parsed.name.trim()) {
      return null;
    }
    const args =
      parsed.arguments &&
      typeof parsed.arguments === "object" &&
      !Array.isArray(parsed.arguments)
        ? (parsed.arguments as Record<string, unknown>)
        : {};
    return {
      arguments: args,
      id:
        typeof parsed.id === "string" && parsed.id.trim()
          ? parsed.id
          : crypto.randomUUID(),
      name: parsed.name.trim(),
    };
  } catch {
    return null;
  }
}
