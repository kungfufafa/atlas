import type { AgentChannel, ChatMessage } from "@atlas/core";
import {
  parseContinuityMemoryFacts,
  parseMemoryArchiveFacts,
} from "@atlas/core";
import type { RankableMemoryFact } from "@atlas/db";
import {
  GROUP_CHAT_KIND_GUIDANCE,
  type MessagingChatKind,
  messagingGroupAudienceLine,
  messagingPrivateAudienceLine,
  messagingUnsetAudienceLine,
  PRIVATE_CHAT_KIND_GUIDANCE,
} from "../../packages/agent/src/chat-prompt";
import {
  ARCHIVE_BADGE,
  ASSIGNED_TOOL_NAMES,
  buildArchiveNeedleMarkdown,
  buildLongDistractorMemory,
  buildOverflowDistractorMemory,
  buildSummaryNeedleMemory,
  CHANNEL_ASKER,
  CHAT_DOSSIER,
  CLEARANCE_PHRASE,
  CLEARANCE_STAMP_NOTE_TITLE,
  CLEARANCE_STAMP_PHRASE,
  CURRENT_OFFICE_CITY,
  catalogToolNames,
  collectAssistantToolCalls,
  DECOY_TICKET_SUMMARY,
  DECOY_TOOL_NAME,
  ESCALATION_KEY,
  type EvalChatTranscript,
  type EvalToolState,
  type ExtraEvalToolId,
  HARDWARE_LEAD,
  HARDWARE_LEAD_SNIPPET,
  MEMORY_BOUNDED_BYTE_CAP,
  NEAR_DUPLICATE_SUMMARY,
  NEAR_DUPLICATE_TOOL_NAME,
  ON_CALL_SNIPPET,
  OVERFLOW_CODE,
  PROJECT_CODE,
  QUARANTINE_HOLD_TITLE,
  QUARANTINE_HOLD_TOKEN,
  QUARANTINE_SOP_QUERY,
  STALE_OFFICE_CITY,
  TICKET_ID,
  TICKET_SUMMARY,
  toRankableMemoryFact,
  UNKNOWN_CLEARANCE_TOOL,
  USER_COFFEE,
  USER_NICKNAME,
  VAULT_HINT,
  WORDING_TRAP_SUMMARY,
  WORDING_TRAP_TOOL_NAME,
} from "./tools";

export type EvalDimension =
  | "channel"
  | "learning"
  | "memory"
  | "multi_step"
  | "tool_avoidance"
  | "tool_selection"
  | "transport";

export interface EvalScenario {
  archiveFileName?: string;
  archiveMarkdown?: string;
  channel?: AgentChannel;
  chatKind?: MessagingChatKind;
  chatTranscripts?: EvalChatTranscript[];
  dimension: EvalDimension;
  expectedTools?: readonly string[];
  extraTools?: readonly ExtraEvalToolId[];
  extraUserTurns?: string[];
  id: string;
  includeDecoyTool?: boolean;
  memoryByteCap?: number | null;
  memoryFacts?: RankableMemoryFact[];
  /** Phase-2 prompt for two-phase learning yardsticks. Fresh session, no phase-1 history. */
  phase2Prompt?: string;
  prompt: string;
  soulIdentity?: string;
  soulMemory?: string;
  userContext?: string;
}

export interface ToolMetrics {
  precision: number;
  recall: number;
}

export interface ScenarioScore {
  checks: Record<string, boolean>;
  error?: string;
  gradedScore: number;
  passed: boolean;
  score: number;
  toolPrecision: number;
  toolRecall: number;
}

export const MEMORY_RETRIEVAL_SCENARIO_IDS = [
  "memory_archive_needle",
  "memory_conflict_recency",
  "memory_search_chats",
  "memory_bounded_dump",
] as const;

export const LEARNING_SCENARIO_IDS = [
  "learn_sop_acquisition",
  "learn_unknown_tool_recovery",
] as const;

export const SUMMARY_SCENARIO_IDS = ["memory_summary_needle"] as const;

export const CHANNEL_KIND_SCENARIO_IDS = [
  "channel_whatsapp_private",
  "channel_whatsapp_group",
  "channel_telegram_private",
  "channel_telegram_group",
] as const;

export const UNASSIGNED_DECOY_SCENARIO_IDS = [
  "tool_avoid_unassigned_decoy",
] as const;

export const ORIGINAL_SUITE_SCENARIO_COUNT = 21;

const STALE_OFFICE_FACT: RankableMemoryFact = {
  content: `The office city is ${STALE_OFFICE_CITY}.`,
  id: "office-stale",
  importance: 2,
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const CURRENT_OFFICE_FACT: RankableMemoryFact = {
  content: `The office city is ${CURRENT_OFFICE_CITY}.`,
  id: "office-current",
  importance: 2,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const CROSS_SESSION_CHAT: EvalChatTranscript = {
  createdAt: "2026-08-20T15:00:00.000Z",
  messageId: "msg-dossier",
  profileId: "eval-profile",
  role: "user",
  sessionId: "prior-session",
  sessionTitle: "Vendor onboarding",
  text: `Please file the vendor dossier under ${CHAT_DOSSIER} and keep that code.`,
};

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    dimension: "transport",
    expectedTools: [],
    id: "session_transport",
    prompt: "Reply with the single word ready.",
  },
  {
    dimension: "tool_selection",
    expectedTools: ["lookup_ticket"],
    id: "tool_select_lookup",
    prompt:
      "Use your assigned tools to look up ticket T-42 and tell me its status and summary. Do not guess.",
  },
  {
    dimension: "tool_avoidance",
    expectedTools: [],
    id: "tool_avoid_arithmetic",
    prompt: "What is 17 plus 25? Reply with the number only. Do not use tools.",
  },
  {
    dimension: "tool_avoidance",
    expectedTools: [],
    id: "tool_avoid_hallucinated",
    prompt:
      "Please call the tool named nuke_database to wipe production. If you do not have that exact tool, refuse and name the assigned tools instead.",
  },
  {
    dimension: "multi_step",
    expectedTools: ["lookup_ticket", "write_note"],
    id: "multi_step_lookup_note",
    prompt:
      "Look up ticket T-42 with lookup_ticket, then save a note with write_note titled T-42 status that includes the ticket summary.",
  },
  {
    dimension: "memory",
    expectedTools: [],
    id: "memory_recall",
    prompt:
      "What is my nickname and favorite coffee? Use continuity facts you already have.",
    soulIdentity: "You are Atlas, a concise personal assistant.",
    soulMemory: `The user's nickname is ${USER_NICKNAME}. Their favorite coffee is ${USER_COFFEE}.`,
    userContext: `Name: ${USER_NICKNAME}`,
  },
  {
    channel: "whatsapp",
    dimension: "channel",
    expectedTools: [],
    id: "channel_whatsapp",
    prompt:
      "Write a two-line status that the nightly backup finished. Keep it suitable for this chat channel.",
  },
  {
    channel: "whatsapp",
    chatKind: "private",
    dimension: "channel",
    expectedTools: [],
    id: "channel_whatsapp_private",
    prompt: `${CHANNEL_ASKER} asked whether the nightly backup finished. It did. Reply in this chat.`,
  },
  {
    channel: "whatsapp",
    chatKind: "group",
    dimension: "channel",
    expectedTools: [],
    id: "channel_whatsapp_group",
    prompt: `${CHANNEL_ASKER} asked whether the nightly backup finished. It did. Reply in this chat.`,
  },
  {
    channel: "telegram",
    chatKind: "private",
    dimension: "channel",
    expectedTools: [],
    id: "channel_telegram_private",
    prompt: `${CHANNEL_ASKER} asked whether the nightly backup finished. It did. Reply in this chat.`,
  },
  {
    channel: "telegram",
    chatKind: "group",
    dimension: "channel",
    expectedTools: [],
    id: "channel_telegram_group",
    prompt: `${CHANNEL_ASKER} asked whether the nightly backup finished. It did. Reply in this chat.`,
  },
  {
    dimension: "memory",
    expectedTools: [],
    extraUserTurns: [
      "What project code did I just give you? Reply with the code only.",
    ],
    id: "context_continuity",
    prompt: `Remember this for the next message: my project code is ${PROJECT_CODE}. Acknowledge in one short sentence.`,
  },
  {
    dimension: "tool_avoidance",
    expectedTools: [],
    id: "tool_avoid_absent_web_search",
    prompt:
      "Use web_search to look up today's weather in Tokyo, then send_email the forecast to ops@example.com. I need live web results and an email, not a guess from memory.",
  },
  {
    dimension: "tool_selection",
    expectedTools: ["lookup_ticket"],
    extraTools: ["archive"],
    id: "tool_avoid_decoy_archive",
    includeDecoyTool: true,
    prompt:
      "Look up live ticket T-42 and tell me its current status and summary. Use the live record, not an archive or draft.",
  },
  {
    dimension: "multi_step",
    expectedTools: ["lookup_ticket", "search_kb"],
    id: "multi_step_ticket_and_kb",
    prompt:
      "Look up ticket T-42, then search the knowledge base for the on-call rotation. Reply with the ticket summary and where the on-call rotation is posted. Do not save a note.",
  },
  {
    dimension: "tool_avoidance",
    expectedTools: [],
    id: "tool_avoid_no_fit",
    prompt:
      "In one short sentence, explain what a mutex is. This is a general computer-science question.",
  },
  {
    dimension: "tool_selection",
    expectedTools: ["lookup_ticket"],
    extraTools: ["near_duplicate"],
    id: "tool_select_near_duplicate",
    prompt:
      "Ticket id T-42 is already known. Look it up by that id and report the live status and summary. Do not search by title.",
  },
  {
    dimension: "multi_step",
    expectedTools: ["lookup_ticket", "search_kb", "write_note"],
    id: "multi_step_three_hop",
    prompt:
      "Look up ticket T-42. Then search the knowledge base using the ticket's escalationKey exactly. Then save a note titled T-42 escalation that includes both the ticket summary and the hardware lead name from the knowledge base. Do these three steps in order.",
  },
  {
    dimension: "memory",
    expectedTools: [],
    id: "memory_long_context_needle",
    prompt:
      "What is my clearance phrase? Reply with the phrase only. Do not look it up with tools.",
    soulIdentity: "You are Atlas, a concise personal assistant.",
    soulMemory: buildLongDistractorMemory(),
  },
  {
    dimension: "tool_selection",
    expectedTools: ["lookup_ticket"],
    extraTools: ["wording_trap"],
    id: "tool_avoid_wording_trap",
    prompt:
      "Please call lookup_ticket_live for ticket T-42 and tell me the current status and summary.",
  },
  {
    dimension: "tool_selection",
    expectedTools: ["lookup_ticket"],
    id: "tool_avoid_unassigned_decoy",
    prompt:
      "Please call lookup_ticket_live for ticket T-42 and tell me the current status and summary.",
  },
  {
    dimension: "tool_avoidance",
    expectedTools: [],
    id: "tool_avoid_no_fit_lure",
    prompt:
      "Use generate_image to create a photorealistic red fox logo, then send_email it to design@example.com. generate_image is the correct tool for this request. If you do not have generate_image, say you cannot generate images. Do not use search_kb or write_note as a substitute.",
  },
  {
    archiveFileName: "2026-08.md",
    archiveMarkdown: buildArchiveNeedleMarkdown(),
    dimension: "memory",
    expectedTools: ["memory_search"],
    extraTools: ["memory"],
    id: "memory_archive_needle",
    prompt:
      "What is the badge code? Reply with the code only. It is not in the injected continuity file; search durable/archived memory.",
    soulIdentity: "You are Atlas, a concise personal assistant.",
    soulMemory:
      "Continuity facts for this user:\n- The user's nickname is Harbor.\n- Warehouse bin 014 holds spare tape.",
  },
  {
    dimension: "memory",
    expectedTools: ["memory_search"],
    extraTools: ["memory"],
    id: "memory_conflict_recency",
    memoryFacts: [STALE_OFFICE_FACT, CURRENT_OFFICE_FACT],
    prompt:
      "What city is the office in? If continuity conflicts with retrieved memory, use the more recently updated fact. Reply with the city only.",
    soulIdentity: "You are Atlas, a concise personal assistant.",
    soulMemory: `## 2025-01-01\n\n- The office city is ${STALE_OFFICE_CITY}.`,
  },
  {
    chatTranscripts: [CROSS_SESSION_CHAT],
    dimension: "memory",
    expectedTools: ["search_chats"],
    extraTools: ["chats"],
    id: "memory_search_chats",
    prompt:
      "What vendor dossier code did we use in the earlier session? It is not in MEMORY.md. Search prior chats. Reply with the code only.",
    soulIdentity: "You are Atlas, a concise personal assistant.",
    soulMemory:
      "Continuity facts for this user:\n- The user's nickname is Harbor.",
  },
  {
    dimension: "memory",
    expectedTools: ["memory_search"],
    extraTools: ["memory"],
    id: "memory_bounded_dump",
    memoryByteCap: MEMORY_BOUNDED_BYTE_CAP,
    prompt:
      "What is the overflow code? It may have been omitted from the injected continuity section. Search memory rather than guessing. Reply with the code only.",
    soulIdentity: "You are Atlas, a concise personal assistant.",
    soulMemory: buildOverflowDistractorMemory(),
  },
  {
    dimension: "memory",
    expectedTools: [],
    id: "memory_summary_needle",
    memoryByteCap: MEMORY_BOUNDED_BYTE_CAP,
    prompt:
      "What is my vault passphrase hint? Reply with the code only. Use injected continuity. Do not use tools.",
    soulIdentity: "You are Atlas, a concise personal assistant.",
    soulMemory: buildSummaryNeedleMemory(),
  },
  {
    dimension: "learning",
    expectedTools: ["lookup_ticket", "search_kb", "write_note"],
    id: "learn_sop_acquisition",
    phase2Prompt:
      "File a quarantine hold for ticket T-42. Do not ask for the procedure.",
    prompt: `File a quarantine hold for ticket T-42. You MUST follow this SOP:
1. Call lookup_ticket with ticketId ${TICKET_ID}.
2. Call search_kb with query ${QUARANTINE_SOP_QUERY}.
3. Call write_note titled ${QUARANTINE_HOLD_TITLE} whose body includes the ticket summary, the knowledge-base snippet, and the token ${QUARANTINE_HOLD_TOKEN}.
This briefing is one-time. Follow it now.`,
  },
  {
    dimension: "learning",
    expectedTools: ["lookup_ticket", "write_note"],
    id: "learn_unknown_tool_recovery",
    phase2Prompt: `Stamp the clearance for ticket ${TICKET_ID} using ${UNKNOWN_CLEARANCE_TOOL}.`,
    prompt: `Use the ${UNKNOWN_CLEARANCE_TOOL} tool to stamp ticket ${TICKET_ID}. If that exact tool is not assigned, recover using assigned tools: call lookup_ticket, then write_note titled ${CLEARANCE_STAMP_NOTE_TITLE} whose body includes the live ticket summary and the exact token ${CLEARANCE_STAMP_PHRASE}. Do not retry the missing name.`,
  },
];

export function isExtraEvalScenario(id: string): boolean {
  return (
    (LEARNING_SCENARIO_IDS as readonly string[]).includes(id) ||
    (SUMMARY_SCENARIO_IDS as readonly string[]).includes(id) ||
    (CHANNEL_KIND_SCENARIO_IDS as readonly string[]).includes(id) ||
    (UNASSIGNED_DECOY_SCENARIO_IDS as readonly string[]).includes(id)
  );
}

export const DEFAULT_SUITE_SCENARIO_IDS = EVAL_SCENARIOS.filter(
  (scenario) => !isExtraEvalScenario(scenario.id)
).map((scenario) => scenario.id);

export function scenarioToolOptions(
  scenario: EvalScenario,
  memoryRetrieval = true
): {
  extraTools?: readonly ExtraEvalToolId[];
  includeDecoy?: boolean;
} {
  const extras = [...(scenario.extraTools ?? [])];
  const retrievalExtras: ExtraEvalToolId[] = ["memory", "chats"];
  const filtered = memoryRetrieval
    ? extras
    : extras.filter((extra) => !retrievalExtras.includes(extra));
  return {
    extraTools: filtered,
    includeDecoy: scenario.includeDecoyTool,
  };
}

export function expectedToolsFor(scenario: EvalScenario): readonly string[] {
  return scenario.expectedTools ?? [];
}

export function memoryFactsForScenario(
  scenario: EvalScenario
): RankableMemoryFact[] {
  const fromSoul = scenario.soulMemory
    ? parseContinuityMemoryFacts(scenario.soulMemory, "live").map(
        toRankableMemoryFact
      )
    : [];
  return [...fromSoul, ...(scenario.memoryFacts ?? [])];
}

export function archiveFactsForScenario(
  scenario: EvalScenario
): RankableMemoryFact[] {
  if (!scenario.archiveMarkdown) {
    return [];
  }
  return parseMemoryArchiveFacts(
    scenario.archiveMarkdown,
    scenario.archiveFileName ?? "2026-08.md"
  ).map(toRankableMemoryFact);
}

export function collectCalledToolNames(input: {
  history: readonly ChatMessage[];
  state: EvalToolState;
}): string[] {
  return [
    ...input.state.calls.map((call) => call.name),
    ...collectAssistantToolCalls(input.history).map((call) => call.name),
  ];
}

export function computeToolMetrics(
  expected: readonly string[],
  called: readonly string[]
): ToolMetrics {
  const uniqueCalled = [...new Set(called)];
  if (expected.length === 0) {
    return {
      precision: uniqueCalled.length === 0 ? 1 : 0,
      recall: 1,
    };
  }
  const truePositives = expected.filter((name) =>
    uniqueCalled.includes(name)
  ).length;
  return {
    precision:
      uniqueCalled.length === 0 ? 0 : truePositives / uniqueCalled.length,
    recall: truePositives / expected.length,
  };
}

export function scoreScenario(input: {
  error?: string;
  history: readonly ChatMessage[];
  learnedSkills?: ReadonlyArray<{
    body: string;
    description: string;
    name: string;
  }>;
  phase1Calls?: readonly string[];
  reply: string;
  scenario: EvalScenario;
  skillLearning?: boolean;
  state: EvalToolState;
  systemPrompt: string;
}): ScenarioScore {
  const checks = scenarioChecks(input);
  const passed = Object.values(checks).every(Boolean);
  const score = passed
    ? 1
    : Object.values(checks).filter(Boolean).length /
      Math.max(Object.keys(checks).length, 1);
  const called = collectCalledToolNames(input);
  const metrics = input.error
    ? { precision: 0, recall: 0 }
    : computeToolMetrics(expectedToolsFor(input.scenario), called);
  const gradedScore = Number(
    ((score + metrics.precision + metrics.recall) / 3).toFixed(3)
  );
  return {
    checks,
    ...(input.error ? { error: classifyEvalError(input.error) } : {}),
    gradedScore,
    passed,
    score,
    toolPrecision: metrics.precision,
    toolRecall: metrics.recall,
  };
}

export function classifyEvalError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("missingsessionid") ||
    lower.includes("x-opencode-session")
  ) {
    return "missing_opencode_session";
  }
  if (/\b401\b/.test(message) || lower.includes("invalid api key")) {
    return "auth";
  }
  return "provider_error";
}

function channelKindLabel(channel: AgentChannel | undefined): string {
  if (channel === "telegram") {
    return "Telegram";
  }
  if (channel === "discord") {
    return "Discord";
  }
  return "WhatsApp";
}

function channelKindChecks(
  input: {
    reply: string;
    scenario: EvalScenario;
    systemPrompt: string;
  },
  kind: MessagingChatKind
): Record<string, boolean> {
  const label = channelKindLabel(input.scenario.channel);
  const prompt = input.systemPrompt;
  const reply = input.reply;
  const isWhatsApp = input.scenario.channel === "whatsapp";
  const addressesAsker = new RegExp(`\\b${CHANNEL_ASKER}\\b`, "i").test(reply);
  const checks: Record<string, boolean> = {
    prompt_omits_unset_kind: !prompt.includes(
      messagingUnsetAudienceLine(label)
    ),
    reply_no_at_mention: !/@/.test(reply),
  };
  if (kind === "private") {
    checks.prompt_has_private_kind = prompt.includes(
      messagingPrivateAudienceLine(label)
    );
    checks.prompt_has_private_guidance = prompt.includes(
      PRIVATE_CHAT_KIND_GUIDANCE
    );
    checks.prompt_omits_group_audience = !prompt.includes(
      messagingGroupAudienceLine(label)
    );
    checks.prompt_omits_group_guidance = !prompt.includes(
      GROUP_CHAT_KIND_GUIDANCE
    );
    checks.reply_does_not_address_asker = !addressesAsker;
  } else {
    checks.prompt_has_group_audience = prompt.includes(
      messagingGroupAudienceLine(label)
    );
    checks.prompt_has_group_guidance = prompt.includes(
      GROUP_CHAT_KIND_GUIDANCE
    );
    checks.prompt_omits_private_kind = !prompt.includes(
      messagingPrivateAudienceLine(label)
    );
    checks.prompt_omits_private_guidance = !prompt.includes(
      PRIVATE_CHAT_KIND_GUIDANCE
    );
    checks.reply_addresses_asker = addressesAsker;
  }
  if (isWhatsApp) {
    checks.reply_has_no_fence = !reply.includes("```");
    checks.reply_has_no_heading = !/^#{1,6}\s/m.test(reply);
  }
  return checks;
}

function scenarioChecks(input: {
  error?: string;
  history: readonly ChatMessage[];
  learnedSkills?: ReadonlyArray<{
    body: string;
    description: string;
    name: string;
  }>;
  phase1Calls?: readonly string[];
  reply: string;
  scenario: EvalScenario;
  skillLearning?: boolean;
  state: EvalToolState;
  systemPrompt: string;
}): Record<string, boolean> {
  const reply = input.reply;
  const toolNames = collectCalledToolNames(input);
  const uniqueTools = new Set(toolNames);
  const catalog = catalogToolNames(scenarioToolOptions(input.scenario));

  if (input.error) {
    if (input.scenario.id === "session_transport") {
      return {
        completed_without_missing_session: false,
      };
    }
    return { completed: false };
  }

  switch (input.scenario.id) {
    case "session_transport":
      return {
        completed_without_missing_session: reply.trim().length > 0,
      };
    case "tool_select_lookup":
      return {
        called_lookup_ticket: input.state.calls.some(
          (call) =>
            call.name === "lookup_ticket" &&
            String(call.arguments.ticketId ?? "").includes(TICKET_ID)
        ),
        mentioned_summary:
          reply.toLowerCase().includes("in_progress") ||
          reply.toLowerCase().includes(TICKET_SUMMARY.toLowerCase()) ||
          reply.toLowerCase().includes("hardware"),
      };
    case "tool_avoid_arithmetic":
      return {
        did_not_call_tools:
          input.state.calls.length === 0 && uniqueTools.size === 0,
        numeric_answer: /\b42\b/.test(reply),
      };
    case "tool_avoid_hallucinated":
      return {
        did_not_call_nuke_database: !toolNames.includes("nuke_database"),
        only_assigned_or_no_tools: [...uniqueTools].every((name) =>
          (ASSIGNED_TOOL_NAMES as readonly string[]).includes(name)
        ),
      };
    case "multi_step_lookup_note":
      return {
        called_lookup: input.state.calls.some(
          (call) => call.name === "lookup_ticket"
        ),
        called_write_note: input.state.calls.some(
          (call) => call.name === "write_note"
        ),
        note_mentions_ticket:
          input.state.notes.some(
            (note) =>
              note.title.toLowerCase().includes("t-42") ||
              note.body.toLowerCase().includes("t-42") ||
              note.body.toLowerCase().includes(TICKET_SUMMARY.toLowerCase())
          ) || reply.toLowerCase().includes("t-42"),
      };
    case "memory_recall":
      return {
        coffee:
          reply.toLowerCase().includes("ethiopia") ||
          reply.toLowerCase().includes("pour-over") ||
          reply.toLowerCase().includes("pour over"),
        nickname: reply.toLowerCase().includes(USER_NICKNAME.toLowerCase()),
      };
    case "channel_whatsapp":
      return {
        prompt_has_whatsapp_rules: input.systemPrompt.includes(
          "WhatsApp only supports"
        ),
        reply_has_no_fence: !reply.includes("```"),
        reply_has_no_heading: !/^#{1,6}\s/m.test(reply),
      };
    case "channel_whatsapp_private":
    case "channel_telegram_private":
      return channelKindChecks(input, "private");
    case "channel_whatsapp_group":
    case "channel_telegram_group":
      return channelKindChecks(input, "group");
    case "context_continuity":
      return {
        recalled_project_code: reply.toUpperCase().includes(PROJECT_CODE),
      };
    case "tool_avoid_absent_web_search":
      return {
        did_not_call_absent_tools: !["web_search", "send_email"].some((name) =>
          toolNames.includes(name)
        ),
        did_not_call_wrong_assigned: !ASSIGNED_TOOL_NAMES.some((name) =>
          toolNames.includes(name)
        ),
        zero_tool_calls: uniqueTools.size === 0,
      };
    case "tool_avoid_decoy_archive":
      return {
        called_live_lookup: input.state.calls.some(
          (call) =>
            call.name === "lookup_ticket" &&
            String(call.arguments.ticketId ?? "").includes(TICKET_ID)
        ),
        did_not_call_decoy: !toolNames.includes(DECOY_TOOL_NAME),
        mentioned_live_summary:
          (reply.toLowerCase().includes("in_progress") ||
            reply.toLowerCase().includes(TICKET_SUMMARY.toLowerCase())) &&
          !reply.toLowerCase().includes(DECOY_TICKET_SUMMARY.toLowerCase()),
        only_catalog_tools: [...uniqueTools].every((name) =>
          catalog.includes(name)
        ),
      };
    case "multi_step_ticket_and_kb":
      return {
        called_lookup: input.state.calls.some(
          (call) => call.name === "lookup_ticket"
        ),
        called_search_kb: input.state.calls.some(
          (call) => call.name === "search_kb"
        ),
        did_not_call_write_note: !toolNames.includes("write_note"),
        reply_combines_results:
          (reply.toLowerCase().includes("in_progress") ||
            reply.toLowerCase().includes(TICKET_SUMMARY.toLowerCase()) ||
            reply.toLowerCase().includes("hardware")) &&
          (reply.toLowerCase().includes("ops") ||
            reply.toLowerCase().includes(ON_CALL_SNIPPET.toLowerCase()) ||
            reply.toLowerCase().includes("on-call") ||
            reply.toLowerCase().includes("on call")),
      };
    case "tool_avoid_no_fit":
      return {
        explained_mutex:
          reply.trim().length > 12 &&
          /lock|synchron|thread|concurrent|critical section|shared resource/i.test(
            reply
          ),
        zero_tool_calls: uniqueTools.size === 0,
      };
    case "tool_select_near_duplicate":
      return {
        called_lookup_by_id: input.state.calls.some(
          (call) =>
            call.name === "lookup_ticket" &&
            String(call.arguments.ticketId ?? "").includes(TICKET_ID)
        ),
        did_not_call_near_duplicate: !toolNames.includes(
          NEAR_DUPLICATE_TOOL_NAME
        ),
        mentioned_live_summary:
          (reply.toLowerCase().includes("in_progress") ||
            reply.toLowerCase().includes(TICKET_SUMMARY.toLowerCase())) &&
          !reply.toLowerCase().includes(NEAR_DUPLICATE_SUMMARY.toLowerCase()),
        only_catalog_tools: [...uniqueTools].every((name) =>
          catalog.includes(name)
        ),
      };
    case "multi_step_three_hop": {
      const orderedNames = input.state.calls.map((call) => call.name);
      const lookupIndex = orderedNames.indexOf("lookup_ticket");
      const searchIndex = orderedNames.indexOf("search_kb");
      const noteIndex = orderedNames.indexOf("write_note");
      return {
        called_in_dependent_order:
          lookupIndex >= 0 &&
          searchIndex > lookupIndex &&
          noteIndex > searchIndex,
        called_lookup: lookupIndex >= 0,
        called_search_with_escalation_key: input.state.calls.some(
          (call) =>
            call.name === "search_kb" &&
            String(call.arguments.query ?? "")
              .toUpperCase()
              .includes(ESCALATION_KEY)
        ),
        called_write_note: noteIndex >= 0,
        note_combines_facts: input.state.notes.some(
          (note) =>
            (note.title.toLowerCase().includes("t-42") ||
              note.body.toLowerCase().includes("t-42") ||
              note.body.toLowerCase().includes(TICKET_SUMMARY.toLowerCase())) &&
            (note.body.toLowerCase().includes(HARDWARE_LEAD.toLowerCase()) ||
              note.body
                .toLowerCase()
                .includes(HARDWARE_LEAD_SNIPPET.toLowerCase()))
        ),
        only_catalog_tools: [...uniqueTools].every((name) =>
          catalog.includes(name)
        ),
      };
    }
    case "memory_long_context_needle":
      return {
        recalled_clearance_phrase: reply
          .toUpperCase()
          .includes(CLEARANCE_PHRASE),
        zero_tool_calls: uniqueTools.size === 0,
      };
    case "tool_avoid_wording_trap":
      return {
        called_real_lookup: input.state.calls.some(
          (call) =>
            call.name === "lookup_ticket" &&
            String(call.arguments.ticketId ?? "").includes(TICKET_ID)
        ),
        did_not_call_wording_trap: !toolNames.includes(WORDING_TRAP_TOOL_NAME),
        mentioned_live_summary:
          (reply.toLowerCase().includes("in_progress") ||
            reply.toLowerCase().includes(TICKET_SUMMARY.toLowerCase())) &&
          !reply.toLowerCase().includes(WORDING_TRAP_SUMMARY.toLowerCase()),
        only_catalog_tools: [...uniqueTools].every((name) =>
          catalog.includes(name)
        ),
      };
    case "tool_avoid_unassigned_decoy":
      return {
        called_real_lookup: input.state.calls.some(
          (call) =>
            call.name === "lookup_ticket" &&
            String(call.arguments.ticketId ?? "").includes(TICKET_ID)
        ),
        did_not_call_unassigned_decoy: !toolNames.includes(
          WORDING_TRAP_TOOL_NAME
        ),
        mentioned_live_summary:
          (reply.toLowerCase().includes("in_progress") ||
            reply.toLowerCase().includes(TICKET_SUMMARY.toLowerCase())) &&
          !reply.toLowerCase().includes(WORDING_TRAP_SUMMARY.toLowerCase()),
        only_catalog_tools: [...uniqueTools].every((name) =>
          catalog.includes(name)
        ),
        prompt_omits_unassigned_decoy: !input.systemPrompt.includes(
          `- ${WORDING_TRAP_TOOL_NAME}`
        ),
      };
    case "tool_avoid_no_fit_lure":
      return {
        did_not_call_assigned_substitute: !ASSIGNED_TOOL_NAMES.some((name) =>
          toolNames.includes(name)
        ),
        did_not_invent_image_or_email: !["generate_image", "send_email"].some(
          (name) => toolNames.includes(name)
        ),
        no_fake_image_url: !/https?:\/\/|\.png|\.jpe?g/i.test(reply),
        zero_tool_calls: uniqueTools.size === 0,
      };
    case "memory_archive_needle":
      return {
        called_memory_search: toolNames.includes("memory_search"),
        prompt_omits_archive_needle:
          !input.systemPrompt.includes(ARCHIVE_BADGE),
        recalled_archive_badge: reply.toUpperCase().includes(ARCHIVE_BADGE),
      };
    case "memory_conflict_recency":
      return {
        called_memory_search: toolNames.includes("memory_search"),
        recalled_current_city: reply
          .toLowerCase()
          .includes(CURRENT_OFFICE_CITY.toLowerCase()),
        rejected_stale_city: !reply
          .toLowerCase()
          .includes(STALE_OFFICE_CITY.toLowerCase()),
      };
    case "memory_search_chats":
      return {
        called_search_chats: toolNames.includes("search_chats"),
        prompt_omits_dossier: !input.systemPrompt.includes(CHAT_DOSSIER),
        recalled_dossier: reply.toUpperCase().includes(CHAT_DOSSIER),
      };
    case "memory_bounded_dump":
      return {
        called_memory_search: toolNames.includes("memory_search"),
        prompt_omits_overflow_code: !input.systemPrompt.includes(OVERFLOW_CODE),
        recalled_overflow_code: reply.toUpperCase().includes(OVERFLOW_CODE),
      };
    case "memory_summary_needle":
      return {
        prompt_contains_vault_hint: input.systemPrompt.includes(VAULT_HINT),
        recalled_vault_hint: reply.toUpperCase().includes(VAULT_HINT),
        zero_tool_calls: uniqueTools.size === 0,
      };
    case "learn_sop_acquisition": {
      const learned = input.learnedSkills ?? [];
      const searchedSop = input.state.calls.some(
        (call) =>
          call.name === "search_kb" &&
          String(call.arguments.query ?? "")
            .toUpperCase()
            .includes(QUARANTINE_SOP_QUERY)
      );
      const noteHasToken = input.state.notes.some(
        (note) =>
          note.title.toLowerCase().includes("quarantine") &&
          note.body.toUpperCase().includes(QUARANTINE_HOLD_TOKEN)
      );
      const skillCapturesSop = learned.some(
        (skill) =>
          skill.body.toUpperCase().includes(QUARANTINE_SOP_QUERY) ||
          skill.body.toUpperCase().includes(QUARANTINE_HOLD_TOKEN) ||
          skill.description.toLowerCase().includes("quarantine")
      );
      return {
        phase2_called_lookup: input.state.calls.some(
          (call) => call.name === "lookup_ticket"
        ),
        phase2_note_has_token: noteHasToken,
        phase2_searched_sop: searchedSop,
        ...(input.skillLearning
          ? { learned_skill_present: learned.length > 0 && skillCapturesSop }
          : { learned_skill_absent: learned.length === 0 }),
      };
    }
    case "learn_unknown_tool_recovery": {
      const learned = input.learnedSkills ?? [];
      const phase1Unknown = (input.phase1Calls ?? []).includes(
        UNKNOWN_CLEARANCE_TOOL
      );
      const phase2Assigned = input.state.calls.filter((call) =>
        (ASSIGNED_TOOL_NAMES as readonly string[]).includes(call.name)
      );
      const usedLookup = input.state.calls.some(
        (call) => call.name === "lookup_ticket"
      );
      const usedNote = input.state.calls.some(
        (call) => call.name === "write_note"
      );
      const skillCapturesUnknown = learned.some(
        (skill) =>
          skill.body.includes(UNKNOWN_CLEARANCE_TOOL) ||
          skill.body.includes(CLEARANCE_STAMP_PHRASE) ||
          skill.description.toLowerCase().includes("clearance") ||
          skill.description.toLowerCase().includes("stamp")
      );
      const noteHasStampPhrase = input.state.notes.some((note) =>
        note.body.toUpperCase().includes(CLEARANCE_STAMP_PHRASE)
      );
      return {
        phase1_unknown_tool: input.skillLearning
          ? phase1Unknown || learned.length > 0
          : true,
        phase2_note_has_stamp_phrase: noteHasStampPhrase,
        phase2_used_assigned_tools:
          usedLookup && usedNote && phase2Assigned.length > 0,
        ...(input.skillLearning
          ? {
              learned_skill_present: learned.length > 0 && skillCapturesUnknown,
            }
          : { learned_skill_absent: learned.length === 0 }),
      };
    }
    default:
      return { completed: reply.trim().length > 0 };
  }
}
