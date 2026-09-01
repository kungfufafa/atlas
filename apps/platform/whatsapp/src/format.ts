import { formatClientError } from "@atlas/core/api-error";
import type { AgentTodo } from "@atlas/core/contract";

const WHATSAPP_MAX_MESSAGE_LENGTH = 65_536;
const WHATSAPP_CHAT_BUBBLE_MAX_CHARS = 400;

export function formatError(error: unknown): string {
  return formatClientError(error);
}

const ARTIFACT_SHARE_PATH = /\/s\/[A-Za-z0-9_-]+/;
const ARTIFACT_SHARE_URL = /https?:\/\/[^\s)]+\/s\/[A-Za-z0-9_-]+/gi;
const ARTIFACT_FILENAME_SHARE_LINE =
  /^(?:\s*)\S+\.(?:csv|docx|gif|html|jpe?g|md|pdf|png|pptx|txt|webp|xls|xlsx|zip):\s*(?:https?:\/\/\S+|\/s\/\S+)\s*$/gim;

function isDisposableWhatsAppLink(url: string): boolean {
  const trimmed = url.trim();
  return (
    /^sandbox:/i.test(trimmed) ||
    /\/artifacts\//i.test(trimmed) ||
    ARTIFACT_SHARE_PATH.test(trimmed)
  );
}

export function stripWhatsAppArtifactChrome(text: string): string {
  let result = text.replace(/\[[^\]]*\]\(([^)]+)\)/g, (full, url: string) =>
    isDisposableWhatsAppLink(url) ? "" : full
  );
  result = result.replace(/\bsandbox:\/\S+/gi, "");
  result = result.replace(ARTIFACT_FILENAME_SHARE_LINE, "");
  result = result.replace(ARTIFACT_SHARE_URL, "");
  result = result.replace(/(^|\s)\/s\/[A-Za-z0-9_-]+/g, "$1");
  return result
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripMarkdownForWhatsApp(text: string): string {
  let result = text.trim();

  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code: string) =>
    code.trim()
  );
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  result = result.replace(/_([^_]+)_/g, "_$1_");

  return result.trim();
}

export function prepareWhatsAppReply(text: string): string {
  return stripMarkdownForWhatsApp(stripWhatsAppArtifactChrome(text));
}

export function splitWhatsAppMessage(text: string): string[] {
  if (text.length <= WHATSAPP_CHAT_BUBBLE_MAX_CHARS) {
    return splitWhatsAppLongMessage(text);
  }

  const paragraphs = text
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > WHATSAPP_CHAT_BUBBLE_MAX_CHARS) {
      if (current) {
        merged.push(current);
        current = "";
      }

      for (const chunk of splitLongParagraph(
        paragraph,
        WHATSAPP_CHAT_BUBBLE_MAX_CHARS
      )) {
        merged.push(chunk);
      }

      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= WHATSAPP_CHAT_BUBBLE_MAX_CHARS) {
      current = candidate;
      continue;
    }

    if (current) {
      merged.push(current);
    }

    current = paragraph;
  }

  if (current) {
    merged.push(current);
  }

  return merged.flatMap((bubble) => splitWhatsAppLongMessage(bubble));
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = paragraph;

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(" ", maxChars);

    if (splitAt <= 0) {
      splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function splitWhatsAppLongMessage(text: string): string[] {
  if (text.length <= WHATSAPP_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > WHATSAPP_MAX_MESSAGE_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", WHATSAPP_MAX_MESSAGE_LENGTH);

    if (splitAt <= 0) {
      splitAt = WHATSAPP_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

type WhatsAppTodoRunState = "working" | "completed" | "stopped" | "failed";

export function renderWhatsAppTodoStatus(
  todos: AgentTodo[],
  state: WhatsAppTodoRunState
): string {
  const header =
    state === "completed"
      ? "\u2705 Completed"
      : state === "stopped"
        ? "\u23f9\ufe0f Stopped"
        : state === "failed"
          ? "\u274c Failed"
          : "\ud83d\udee0\ufe0f Working";

  return [header, ...todos.map(formatWhatsAppTodoLine)].join("\n");
}

function formatWhatsAppTodoLine(todo: AgentTodo): string {
  switch (todo.status) {
    case "completed":
      return `\u2705 [x] ${todo.content}`;
    case "in_progress":
      return `\ud83d\udd04 [~] ${todo.content}`;
    case "cancelled":
      return `\ud83d\udeab [-] ${todo.content}`;
    default:
      return `\u23f3 [ ] ${todo.content}`;
  }
}

export function formatHelpText(options?: {
  workspaceLocked?: boolean;
}): string {
  const orgLine = options?.workspaceLocked
    ? ""
    : "/org \u2014 choose or switch organization\n";

  return `Atlas WhatsApp commands:

/start \u2014 welcome and show this message
/help \u2014 show this message
/stop \u2014 stop the agent's current reply (works during tool runs)
/clear \u2014 clear chat history
/compact \u2014 compact conversation history
/new \u2014 start a new conversation
/attach \u2014 send the latest saved file
${orgLine}/profile \u2014 choose or switch bot profile
/status \u2014 server and model status

Send text, a photo, a voice note, or a document. Saved files come back in the chat.`;
}

export const HELP_TEXT = formatHelpText();
