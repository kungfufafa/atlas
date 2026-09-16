import type { ChatMessage, ToolDefinition } from "@atlas/core";

export const TICKET_ID = "T-42";
export const TICKET_SUMMARY = "Waiting on hardware";
export const USER_NICKNAME = "Harbor";
export const USER_COFFEE = "pour-over Ethiopia";
export const PROJECT_CODE = "OMEGA-9";
export const ESCALATION_KEY = "HW-LEAD";
export const HARDWARE_LEAD = "Priya";
export const HARDWARE_LEAD_SNIPPET = "Hardware lead contact is Priya in bay 4.";
export const CLEARANCE_PHRASE = "SILVER-ORCHID-77";
export const LONG_CONTEXT_NEEDLE_INDEX = 37;
export const LONG_CONTEXT_DISTRACTOR_COUNT = 90;

export const ASSIGNED_TOOL_NAMES = [
  "lookup_ticket",
  "write_note",
  "search_kb",
] as const;

export const DECOY_TOOL_NAME = "lookup_ticket_archive";
export const DECOY_TICKET_SUMMARY = "Closed archive copy";
export const NEAR_DUPLICATE_TOOL_NAME = "lookup_ticket_by_title";
export const NEAR_DUPLICATE_SUMMARY =
  "Title search miss — not the live T-42 record";
export const WORDING_TRAP_TOOL_NAME = "lookup_ticket_live";
export const WORDING_TRAP_SUMMARY = "Live-index preview stub";
export const ON_CALL_SNIPPET = "On-call rotation is posted in the ops channel.";

export type ExtraEvalToolId = "archive" | "near_duplicate" | "wording_trap";

export interface CreateEvalToolsOptions {
  extraTools?: readonly ExtraEvalToolId[];
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

export function resolveExtraEvalTools(
  options: CreateEvalToolsOptions = {}
): ExtraEvalToolId[] {
  const extras = new Set<ExtraEvalToolId>(options.extraTools ?? []);
  if (options.includeDecoy) {
    extras.add("archive");
  }
  return [...extras];
}

export function catalogToolNames(
  options: CreateEvalToolsOptions = {}
): string[] {
  return createEvalTools(createEvalToolState(), options).map(
    (tool) => tool.name
  );
}

export function buildLongDistractorMemory(): string {
  const lines = ["Continuity facts for this user:"];
  for (let index = 1; index <= LONG_CONTEXT_DISTRACTOR_COUNT; index += 1) {
    if (index === LONG_CONTEXT_NEEDLE_INDEX) {
      lines.push(`- The user's clearance phrase is ${CLEARANCE_PHRASE}.`);
    }
    const bin = String(index).padStart(3, "0");
    lines.push(
      `- Warehouse bin ${bin} holds spare SKU-A${bin} counted last Tuesday.`
    );
  }
  return lines.join("\n");
}

export function createEvalTools(
  state: EvalToolState,
  options: CreateEvalToolsOptions = {}
): ToolDefinition[] {
  const extras = new Set(resolveExtraEvalTools(options));
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
            escalationKey: ESCALATION_KEY,
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
        const query = String(record.query ?? "");
        if (query.toUpperCase().includes(ESCALATION_KEY)) {
          return Promise.resolve({
            hits: [
              {
                snippet: HARDWARE_LEAD_SNIPPET,
                title: "hardware-escalation",
              },
            ],
          });
        }
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

  if (extras.has("archive")) {
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

  if (extras.has("near_duplicate")) {
    tools.push({
      description:
        "Find a ticket by free-text title words. Do not use this when the ticket id is already known.",
      name: NEAR_DUPLICATE_TOOL_NAME,
      parallelSafe: true,
      parameters: {
        properties: {
          title: { description: "Ticket title words", type: "string" },
        },
        required: ["title"],
        type: "object",
      },
      run(input) {
        const record = asRecord(input);
        state.calls.push({
          arguments: record,
          name: NEAR_DUPLICATE_TOOL_NAME,
        });
        return Promise.resolve({
          owner: "Title search",
          status: "open",
          summary: NEAR_DUPLICATE_SUMMARY,
          ticketId: "T-99",
        });
      },
    });
  }

  if (extras.has("wording_trap")) {
    tools.push({
      description:
        "Experimental live-index preview. This is not the assigned live ticket lookup.",
      name: WORDING_TRAP_TOOL_NAME,
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
        state.calls.push({
          arguments: record,
          name: WORDING_TRAP_TOOL_NAME,
        });
        return Promise.resolve({
          owner: "Preview bot",
          status: "unknown",
          summary: WORDING_TRAP_SUMMARY,
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
