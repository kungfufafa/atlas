import type { Artifact } from "@atlas/core/artifact-types";
import type {
  ApprovalRequest,
  ChatMessage,
  DocumentAttachment,
  ImageAttachment,
  MessageContentPart,
} from "@atlas/core/contract";
import { extractThinkingFromAssistantMessage } from "@atlas/core/thinking-content";

export interface ChatArtifact {
  filename: string;
  id: string;
  mimeType: string;
  path: string;
  size: number;
  type?: string;
}

export interface ChatRetryAttachments {
  documents?: DocumentAttachment[];
  images?: ImageAttachment[];
}

export interface ChatListItem {
  approval?: ApprovalRequest;
  artifacts?: ChatArtifact[];
  attachmentCount?: number;
  content: string;
  /** Client-only failed-turn marker; rolled-back turns are absent from history. */
  failed?: boolean;
  historyIndex?: number;
  id: string;
  relatedQuestions?: string[];
  /** Client-only attachment bytes retained while an optimistic turn is mounted. */
  retryAttachments?: ChatRetryAttachments;
  role: "assistant" | "tool" | "user";
  streaming?: boolean;
  thinking?: string;
  thinkingStreaming?: boolean;
  tool?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  toolStatus?: "done" | "running";
}

export function createChatItemId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function userContentToText(
  content: MessageContentPart[] | string
): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function parseToolResult(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function artifactsFromToolResult(
  result: unknown
): ChatArtifact[] | undefined {
  if (typeof result !== "object" || result === null) {
    return;
  }

  const record = result as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) {
    return;
  }

  const path =
    typeof record.path === "string"
      ? record.path
      : typeof record.filename === "string"
        ? record.filename
        : null;
  if (!path) {
    return;
  }

  const size =
    typeof record.size === "number"
      ? record.size
      : typeof record.bytesWritten === "number"
        ? record.bytesWritten
        : 0;

  return [
    {
      filename: basename(path),
      id: path,
      mimeType:
        typeof record.mimeType === "string"
          ? record.mimeType
          : "application/octet-stream",
      path,
      size,
      type: "file",
    },
  ];
}

export function artifactFromStream(artifact: Artifact): ChatArtifact {
  return {
    filename: artifact.filename,
    id: artifact.id,
    mimeType: artifact.mimeType,
    path: artifact.path,
    size: artifact.size,
    type: artifact.type,
  };
}

export function chatMessagesToListItems(
  messages: ChatMessage[]
): ChatListItem[] {
  const toolInputs = new Map<string, Record<string, unknown>>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      toolInputs.set(call.id, call.arguments);
    }
  }

  const items: ChatListItem[] = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      items.push({
        content: userContentToText(message.content),
        historyIndex: index,
        id: `history-${index}`,
        role: "user",
      });
      continue;
    }

    if (message.role === "assistant") {
      if (
        !message.content.trim() &&
        message.toolCalls?.length &&
        !message.approval
      ) {
        continue;
      }

      items.push({
        ...(message.approval ? { approval: message.approval } : {}),
        content: message.content,
        historyIndex: index,
        id: `history-${index}`,
        relatedQuestions: message.relatedQuestions,
        role: "assistant",
        thinking: extractThinkingFromAssistantMessage(message),
      });
      continue;
    }

    const toolResult = parseToolResult(message.content);
    items.push({
      artifacts: artifactsFromToolResult(toolResult),
      content: `${message.name} completed`,
      historyIndex: index,
      id: message.toolCallId || `history-${index}`,
      role: "tool",
      tool: message.name,
      toolCallId: message.toolCallId,
      toolInput: toolInputs.get(message.toolCallId),
      toolResult,
      toolStatus: "done",
    });
  }

  return items;
}

export function formatToolResult(result: unknown): string | null {
  if (result == null) {
    return null;
  }
  if (typeof result === "string") {
    return result.trim() || null;
  }
  if (typeof result === "object") {
    const record = result as {
      error?: unknown;
      stderr?: unknown;
      stdout?: unknown;
    };
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error.trim();
    }
    if (typeof record.stdout === "string" && record.stdout.trim()) {
      return record.stdout.trim();
    }
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

export function formatToolLabel(
  tool: string | undefined,
  input?: Record<string, unknown>
): string {
  const name = tool?.trim() || "Tool";
  if (typeof input?.path === "string" && input.path.trim()) {
    return `${name} · ${basename(input.path)}`;
  }
  if (typeof input?.query === "string" && input.query.trim()) {
    return `${name} · ${input.query.trim()}`;
  }
  if (typeof input?.command === "string" && input.command.trim()) {
    return `${name} · ${input.command.trim().split("\n")[0]}`;
  }
  return name;
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted/i.test(error.message))
  );
}

export function pendingApprovalFromMessages(
  messages: ChatListItem[]
): ApprovalRequest | undefined {
  return [...messages]
    .reverse()
    .find((message) => message.approval?.status === "pending")?.approval;
}
