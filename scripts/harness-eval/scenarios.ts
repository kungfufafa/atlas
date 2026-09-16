import type { AgentChannel, ChatMessage } from "@atlas/core";
import {
  ASSIGNED_TOOL_NAMES,
  buildLongDistractorMemory,
  CLEARANCE_PHRASE,
  catalogToolNames,
  collectAssistantToolCalls,
  DECOY_TICKET_SUMMARY,
  DECOY_TOOL_NAME,
  ESCALATION_KEY,
  type EvalToolState,
  type ExtraEvalToolId,
  HARDWARE_LEAD,
  HARDWARE_LEAD_SNIPPET,
  NEAR_DUPLICATE_SUMMARY,
  NEAR_DUPLICATE_TOOL_NAME,
  ON_CALL_SNIPPET,
  PROJECT_CODE,
  TICKET_ID,
  TICKET_SUMMARY,
  USER_COFFEE,
  USER_NICKNAME,
  WORDING_TRAP_SUMMARY,
  WORDING_TRAP_TOOL_NAME,
} from "./tools";

export type EvalDimension =
  | "channel"
  | "memory"
  | "multi_step"
  | "tool_avoidance"
  | "tool_selection"
  | "transport";

export interface EvalScenario {
  channel?: AgentChannel;
  dimension: EvalDimension;
  expectedTools?: readonly string[];
  extraTools?: readonly ExtraEvalToolId[];
  extraUserTurns?: string[];
  id: string;
  includeDecoyTool?: boolean;
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
    dimension: "tool_avoidance",
    expectedTools: [],
    id: "tool_avoid_no_fit_lure",
    prompt:
      "Use generate_image to create a photorealistic red fox logo, then send_email it to design@example.com. generate_image is the correct tool for this request. If you do not have generate_image, say you cannot generate images. Do not use search_kb or write_note as a substitute.",
  },
];

export function scenarioToolOptions(scenario: EvalScenario): {
  extraTools?: readonly ExtraEvalToolId[];
  includeDecoy?: boolean;
} {
  return {
    extraTools: scenario.extraTools,
    includeDecoy: scenario.includeDecoyTool,
  };
}

export function expectedToolsFor(scenario: EvalScenario): readonly string[] {
  return scenario.expectedTools ?? [];
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
  reply: string;
  scenario: EvalScenario;
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

function scenarioChecks(input: {
  error?: string;
  history: readonly ChatMessage[];
  reply: string;
  scenario: EvalScenario;
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
    default:
      return { completed: reply.trim().length > 0 };
  }
}
