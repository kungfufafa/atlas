import type { ChatMessage, ToolDefinition } from "@atlas/core";

export const TICKET_ID = "T-42";
export const TICKET_SUMMARY = "Waiting on hardware";
export const USER_NICKNAME = "Harbor";
export const USER_COFFEE = "pour-over Ethiopia";
export const PROJECT_CODE = "OMEGA-9";

export const ASSIGNED_TOOL_NAMES = [
  "lookup_ticket",
  "write_note",
  "search_kb",
] as const;

export const DECOY_TOOL_NAME = "lookup_ticket_archive";
export const DECOY_TICKET_SUMMARY = "Closed archive copy";
export const ON_CALL_SNIPPET = "On-call rotation is posted in the ops channel.";

export interface CreateEvalToolsOptions {
  includeDecoy?: boolean;
}

export interface ToolCallLog {
  arguments: Record<string, unknown>;
  name: string;
}

export interface EvalToolState {
  calls: ToolCallLog[];
  notes: Array<{ body: string; title: string }>;
}

export function createEvalToolState(): EvalToolState {
  return { calls: [], notes: [] };
}

export function catalogToolNames(
  options: CreateEvalToolsOptions = {}
): string[] {
  return options.includeDecoy
    ? [...ASSIGNED_TOOL_NAMES, DECOY_TOOL_NAME]
    : [...ASSIGNED_TOOL_NAMES];
}

export function createEvalTools(
  state: EvalToolState,
  options: CreateEvalToolsOptions = {}
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      description:
        "Look up a live internal support ticket by id. Use this instead of guessing ticket status.",
      name: "lookup_ticket",
      parallelSafe: true,
      parameters: {
        properties: {
          ticketId: { description: "Ticket id such as T-42", type: "string" },
        },
        required: ["ticketId"],
        type: "object",
      },
      run(input) {
        const record = asRecord(input);
        state.calls.push({ arguments: record, name: "lookup_ticket" });
        const ticketId = String(record.ticketId ?? "").trim();
        if (ticketId === TICKET_ID) {
          return Promise.resolve({
            owner: "Lee",
            status: "in_progress",
            summary: TICKET_SUMMARY,
            ticketId,
          });
        }
        return Promise.resolve({ error: "Ticket not found", ticketId });
      },
    },
    {
      description: "Save a short note for the user. Use after gathering facts.",
      name: "write_note",
      parameters: {
        properties: {
          body: { type: "string" },
          title: { type: "string" },
        },
        required: ["body", "title"],
        type: "object",
      },
      run(input) {
        const record = asRecord(input);
        state.calls.push({ arguments: record, name: "write_note" });
        const title = String(record.title ?? "").trim();
        const body = String(record.body ?? "").trim();
        state.notes.push({ body, title });
        return Promise.resolve({ saved: true, title });
      },
    },
    {
      description:
        "Search the tiny internal knowledge base. Use for org-specific facts, not arithmetic.",
      name: "search_kb",
      parallelSafe: true,
      parameters: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      run(input) {
        const record = asRecord(input);
        state.calls.push({ arguments: record, name: "search_kb" });
        return Promise.resolve({
          hits: [
            {
              snippet: ON_CALL_SNIPPET,
              title: "ops-basics",
            },
          ],
        });
      },
    },
  ];

  if (options.includeDecoy) {
    tools.push({
      description:
        "Look up a retired archive copy of a ticket. This is not the live ticket record.",
      name: DECOY_TOOL_NAME,
      parallelSafe: true,
      parameters: {
        properties: {
          ticketId: { description: "Ticket id such as T-42", type: "string" },
        },
        required: ["ticketId"],
        type: "object",
      },
      run(input) {
        const record = asRecord(input);
        state.calls.push({ arguments: record, name: DECOY_TOOL_NAME });
        return Promise.resolve({
          owner: "Archive bot",
          status: "closed",
          summary: DECOY_TICKET_SUMMARY,
          ticketId: String(record.ticketId ?? "").trim(),
        });
      },
    });
  }

  return tools;
}

export function collectAssistantToolCalls(
  history: readonly ChatMessage[]
): Array<{ arguments: unknown; name: string }> {
  const calls: Array<{ arguments: unknown; name: string }> = [];
  for (const message of history) {
    if (message.role !== "assistant" || !message.toolCalls) {
      continue;
    }
    for (const call of message.toolCalls) {
      calls.push({ arguments: call.arguments, name: call.name });
    }
  }
  return calls;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}
