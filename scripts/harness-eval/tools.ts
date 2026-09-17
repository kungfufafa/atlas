import type {
  ChatMessage,
  ContinuityMemoryFact,
  ToolDefinition,
} from "@atlas/core";
import {
  ConversationKeywordSearch,
  type RankableMemoryFact,
  searchRankedMemories,
} from "@atlas/db";

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
export const ARCHIVE_BADGE = "QUARTZ-WALRUS-19";
export const STALE_OFFICE_CITY = "Berlin";
export const CURRENT_OFFICE_CITY = "Lisbon";
export const CHAT_DOSSIER = "NIGHTINGALE-4";
export const OVERFLOW_CODE = "MANGROVE-DELTA-5";
export const OVERFLOW_DISTRACTOR_COUNT = 250;
export const MEMORY_BOUNDED_BYTE_CAP = 2048;
export const VAULT_HINT = "CEDAR-FALCON-7";
export const SUMMARY_DISTRACTOR_COUNT = 80;

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
export const QUARANTINE_SOP_QUERY = "QUARANTINE-HOLD-SOP";
export const QUARANTINE_HOLD_TOKEN = "Q-HOLD-ALPHA";
export const QUARANTINE_HOLD_TITLE = "quarantine-hold";
export const UNKNOWN_CLEARANCE_TOOL = "clearance_stamp";
export const CLEARANCE_STAMP_NOTE_TITLE = "clearance-stamp";
export const CLEARANCE_STAMP_PHRASE = "STAMP-VIA-NOTE";

export type ExtraEvalToolId =
  | "archive"
  | "chats"
  | "memory"
  | "near_duplicate"
  | "wording_trap";

export interface CreateEvalToolsOptions {
  extraTools?: readonly ExtraEvalToolId[];
  includeDecoy?: boolean;
}

export interface ToolCallLog {
  arguments: Record<string, unknown>;
  name: string;
}

export interface EvalChatTranscript {
  createdAt: string;
  messageId: string;
  profileId: string;
  role: string;
  sessionId: string;
  sessionTitle: string;
  text: string;
}

export interface EvalToolState {
  calls: ToolCallLog[];
  chats: EvalChatTranscript[];
  memories: RankableMemoryFact[];
  notes: Array<{ body: string; title: string }>;
}

export function createEvalToolState(
  seed: { chats?: EvalChatTranscript[]; memories?: RankableMemoryFact[] } = {}
): EvalToolState {
  return {
    calls: [],
    chats: [...(seed.chats ?? [])],
    memories: [...(seed.memories ?? [])],
    notes: [],
  };
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

export function buildOverflowDistractorMemory(): string {
  const lines = [
    "Continuity facts for this user:",
    "",
    "## 2024-01-01",
    "",
    `- Warehouse overflow bin label ${OVERFLOW_CODE} counted last Tuesday.`,
    "",
    "## 2026-09-01",
    "",
  ];
  for (let index = 1; index <= OVERFLOW_DISTRACTOR_COUNT; index += 1) {
    const bin = String(index).padStart(3, "0");
    lines.push(
      `- Warehouse bin ${bin} holds spare SKU-A${bin} counted last Tuesday.`
    );
  }
  return lines.join("\n");
}

export function buildSummaryNeedleMemory(): string {
  const lines = [
    "Continuity facts for this user:",
    "",
    "## 2024-01-01",
    "",
    `- The user's vault passphrase hint is ${VAULT_HINT}.`,
    "",
    "## 2026-09-01",
    "",
  ];
  for (let index = 1; index <= SUMMARY_DISTRACTOR_COUNT; index += 1) {
    const bin = String(index).padStart(3, "0");
    lines.push(
      `- Warehouse bin ${bin} holds spare SKU-A${bin} counted last Tuesday.`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildArchiveNeedleMarkdown(badge = ARCHIVE_BADGE): string {
  return `# Archived Memory

---

<!-- archived: 2026-08-15T00:00:00.000Z -->

## 2026-08-15

- The badge code is ${badge}.
`;
}

export function toRankableMemoryFact(
  fact: ContinuityMemoryFact | RankableMemoryFact
): RankableMemoryFact {
  return {
    content: fact.content,
    id: fact.id,
    importance: fact.importance ?? 1,
    subject: "subject" in fact ? (fact.subject ?? null) : null,
    updatedAt: fact.updatedAt,
  };
}

export function searchEvalMemories(
  memories: readonly RankableMemoryFact[],
  query: string,
  limit = 10
): RankableMemoryFact[] {
  return searchRankedMemories(memories, query, {
    limit,
    resolveConflicts: true,
  });
}

export function searchEvalChats(
  chats: readonly EvalChatTranscript[],
  query: string,
  limit = 10
): Array<{
  createdAt: string;
  matchedSnippet: string;
  messageId: string;
  profileId: string;
  role: string;
  sessionId: string;
  sessionTitle: string | null;
}> {
  const search = new ConversationKeywordSearch(query, limit);
  for (const chat of chats) {
    search.add(
      {
        createdAt: chat.createdAt,
        messageId: chat.messageId,
        profileId: chat.profileId,
        role: chat.role,
        sessionId: chat.sessionId,
        sessionTitle: chat.sessionTitle,
      },
      chat.text
    );
  }
  return search.results();
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
        if (query.toUpperCase().includes(QUARANTINE_SOP_QUERY)) {
          return Promise.resolve({
            hits: [
              {
                snippet: `Quarantine hold SOP token is ${QUARANTINE_HOLD_TOKEN}.`,
                title: "quarantine-hold-sop",
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

  if (extras.has("memory")) {
    tools.push({
      description:
        "Search durable memories and the memory archive. Ranked by lexical/FTS relevance; when facts conflict, the more recently updated value wins. Use this for facts missing from or newer than MEMORY.md.",
      name: "memory_search",
      parallelSafe: true,
      parameters: {
        properties: {
          limit: { type: "number" },
          query: {
            description:
              "Search keywords or natural language query for memories",
            type: "string",
          },
        },
        required: ["query"],
        type: "object",
      },
      run(input) {
        const record = asRecord(input);
        state.calls.push({ arguments: record, name: "memory_search" });
        const query = String(record.query ?? "");
        const limitRaw = Number(record.limit);
        const limit = Number.isFinite(limitRaw) ? limitRaw : 10;
        const memories = searchEvalMemories(state.memories, query, limit);
        return Promise.resolve({
          count: memories.length,
          memories: memories.map((item) => ({
            content: item.content,
            id: item.id,
            importance: item.importance ?? 1,
            subject: item.subject ?? null,
            updatedAt: item.updatedAt,
          })),
          query,
        });
      },
    });
  }

  if (extras.has("chats")) {
    tools.push({
      description:
        "Search previous chat sessions for topics, decisions, or facts that are not in MEMORY.md.",
      name: "search_chats",
      parallelSafe: true,
      parameters: {
        properties: {
          limit: { type: "number" },
          query: {
            description:
              "Keywords or a natural-language query for past conversations",
            type: "string",
          },
        },
        required: ["query"],
        type: "object",
      },
      run(input) {
        const record = asRecord(input);
        state.calls.push({ arguments: record, name: "search_chats" });
        const query = String(record.query ?? "");
        const limitRaw = Number(record.limit);
        const limit = Number.isFinite(limitRaw) ? limitRaw : 10;
        const results = searchEvalChats(state.chats, query, limit);
        return Promise.resolve({
          count: results.length,
          query,
          results,
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
