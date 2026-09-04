import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@atlas/core";
import { resolveUserContentForProvider } from "@atlas/core";
import {
  type Content,
  createPartFromFunctionResponse,
  createPartFromText,
  type Part,
} from "@google/genai";
import { hasMatchingProviderContent, readRecord } from "../shared";

export async function toGeminiContents(
  messages: ChatMessage[],
  providerInstanceId?: string,
  modelId?: string,
  providerReplayRevision?: string
): Promise<Content[]> {
  const contents: Content[] = [];
  const idlessProviderToolCalls = new Set<string>();

  for (const message of normalizeGeminiToolHistory(messages)) {
    if (message.role === "user") {
      const parts = await toGeminiUserParts(message.content);

      if (parts.length > 0) {
        contents.push({ parts, role: "user" });
      }

      continue;
    }

    if (message.role === "assistant") {
      const parts = toGeminiAssistantParts(
        message,
        providerInstanceId,
        modelId,
        providerReplayRevision,
        idlessProviderToolCalls
      );

      if (parts.length > 0) {
        contents.push({ parts, role: "model" });
      }

      continue;
    }

    const response = parseToolResultContent(message.content);
    const part = idlessProviderToolCalls.has(message.toolCallId)
      ? {
          functionResponse: {
            name: message.name,
            response,
          },
        }
      : createPartFromFunctionResponse(
          message.toolCallId,
          message.name,
          response
        );

    contents.push({ parts: [part], role: "user" });
  }

  return contents;
}

function normalizeGeminiToolHistory(messages: ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];

  for (const [index, rawMessage] of messages.entries()) {
    if (rawMessage.role !== "assistant" || !rawMessage.toolCalls?.length) {
      normalized.push(rawMessage);
      continue;
    }

    const visibleToolResults = new Set<string>();
    for (const follower of messages.slice(index + 1)) {
      if (follower.role !== "tool") {
        break;
      }
      if (follower.toolCallId) {
        visibleToolResults.add(follower.toolCallId);
      }
    }

    const remainingToolCalls = rawMessage.toolCalls.filter((call) =>
      visibleToolResults.has(call.id)
    );
    if (remainingToolCalls.length === 0) {
      const text = rawMessage.content.trim();
      const thinking = rawMessage.thinking?.trim();
      if (!(text || thinking)) {
        continue;
      }

      normalized.push({
        ...rawMessage,
        providerContent: filterGeminiProviderContent(
          rawMessage.providerContent,
          new Set(),
          rawMessage.toolCalls
        ),
        toolCalls: undefined,
      });
      continue;
    }

    if (remainingToolCalls.length !== rawMessage.toolCalls.length) {
      const allowedToolCallIds = new Set(
        remainingToolCalls.map((call) => call.id)
      );
      normalized.push({
        ...rawMessage,
        providerContent: filterGeminiProviderContent(
          rawMessage.providerContent,
          allowedToolCallIds,
          rawMessage.toolCalls
        ),
        toolCalls: remainingToolCalls,
      });
      continue;
    }

    normalized.push(rawMessage);
  }

  const keptToolCallIds = new Set<string>();
  for (const message of normalized) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      keptToolCallIds.add(call.id);
    }
  }

  return normalized.filter(
    (message) =>
      message.role !== "tool" || keptToolCallIds.has(message.toolCallId)
  );
}

function filterGeminiProviderContent(
  providerContent: unknown[] | undefined,
  allowedToolCallIds: Set<string>,
  toolCalls: Extract<ChatMessage, { role: "assistant" }>["toolCalls"]
): unknown[] | undefined {
  if (!providerContent?.length) {
    return providerContent;
  }

  let functionCallIndex = 0;
  const filtered = providerContent.filter((part) => {
    const functionCall = readRecord(readRecord(part).functionCall);
    const name =
      typeof functionCall.name === "string" ? functionCall.name.trim() : "";
    if (!name) {
      return true;
    }

    const normalizedCall = toolCalls?.[functionCallIndex];
    functionCallIndex += 1;
    const providedId =
      typeof functionCall.id === "string" ? functionCall.id.trim() : "";
    const id = providedId || normalizedCall?.id;
    return Boolean(id && allowedToolCallIds.has(id));
  });

  return filtered.length > 0 ? filtered : undefined;
}

async function toGeminiUserParts(
  content: string | import("@atlas/core").MessageContentPart[]
): Promise<Part[]> {
  const resolved = await resolveUserContentForProvider(content, "gemini");

  if (typeof resolved === "string") {
    const trimmed = resolved.trim();
    return trimmed ? [createPartFromText(trimmed)] : [];
  }

  const parts: Part[] = [];

  for (const part of resolved) {
    if (part.type === "text") {
      const trimmed = part.text.trim();

      if (trimmed) {
        parts.push(createPartFromText(trimmed));
      }

      continue;
    }

    if ("data" in part) {
      parts.push({
        inlineData: {
          data: part.data,
          mimeType: part.mediaType,
        },
      });
    }
  }

  return parts;
}

function toGeminiAssistantParts(
  message: Extract<ChatMessage, { role: "assistant" }>,
  providerInstanceId?: string,
  modelId?: string,
  providerReplayRevision?: string,
  idlessProviderToolCalls?: Set<string>
): Part[] {
  if (
    hasMatchingProviderContent(
      message,
      "gemini",
      "gemini-content",
      providerInstanceId,
      modelId,
      providerReplayRevision
    )
  ) {
    const parts = message.providerContent as Part[];
    rememberIdlessGeminiFunctionCalls(
      parts,
      message.toolCalls,
      idlessProviderToolCalls
    );
    return parts;
  }

  const parts: Part[] = [];

  const thinking = message.thinking?.trim();
  if (thinking) {
    parts.push({
      text: thinking,
      thought: true,
    });
  }

  const text = message.content.trim();

  if (text) {
    parts.push(createPartFromText(text));
  }

  for (const call of message.toolCalls ?? []) {
    parts.push({
      functionCall: {
        args: call.arguments,
        id: call.id,
        name: call.name,
      },
    });
  }

  return parts;
}

function rememberIdlessGeminiFunctionCalls(
  parts: Part[],
  toolCalls: Extract<ChatMessage, { role: "assistant" }>["toolCalls"],
  destination: Set<string> | undefined
): void {
  if (!(destination && toolCalls?.length)) {
    return;
  }

  let functionCallIndex = 0;

  for (const part of parts) {
    const functionCall = part.functionCall;
    if (!functionCall?.name?.trim()) {
      continue;
    }

    const normalizedCall = toolCalls[functionCallIndex];
    functionCallIndex += 1;

    if (!functionCall.id?.trim() && normalizedCall?.id) {
      destination.add(normalizedCall.id);
    }
  }
}

function parseToolResultContent(content: string): Record<string, unknown> {
  const trimmed = content.trim();

  if (!trimmed) {
    return { output: "" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  return { output: trimmed };
}

export function parseGeminiFunctionCalls(
  functionCalls:
    | Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
    | undefined
): import("@atlas/core").ToolCall[] {
  if (!functionCalls?.length) {
    return [];
  }

  return functionCalls.flatMap((call) => {
    const name = call.name?.trim();

    if (!name) {
      return [];
    }

    return [
      {
        arguments: readRecord(call.args ?? {}),
        id: call.id?.trim() || createGeminiFunctionCallId(),
        name,
      },
    ];
  });
}

export function createGeminiFunctionCallId(): string {
  return `gemini_call_${randomUUID()}`;
}

export function extractTextAndThinkingFromParts(parts: Part[] | undefined): {
  content: string;
  thinking?: string;
} {
  if (!parts?.length) {
    return { content: "" };
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];

  for (const part of parts) {
    const text = part.text?.trim();

    if (!text) {
      continue;
    }

    if (part.thought) {
      thinkingParts.push(text);
    } else {
      textParts.push(text);
    }
  }

  const thinking = thinkingParts.join("").trim();

  return {
    content: textParts.join(""),
    ...(thinking ? { thinking } : {}),
  };
}
