import type { AgentChannel, ChatMessage } from "@atlas/core";
import {
  ASSIGNED_TOOL_NAMES,
  collectAssistantToolCalls,
  type EvalToolState,
  PROJECT_CODE,
  TICKET_ID,
  TICKET_SUMMARY,
  USER_COFFEE,
  USER_NICKNAME,
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
  extraUserTurns?: string[];
  id: string;
  prompt: string;
  soulIdentity?: string;
  soulMemory?: string;
  userContext?: string;
}

export interface ScenarioScore {
  checks: Record<string, boolean>;
  error?: string;
  passed: boolean;
  score: number;
}

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    dimension: "transport",
    id: "session_transport",
    prompt: "Reply with the single word ready.",
  },
  {
    dimension: "tool_selection",
    id: "tool_select_lookup",
    prompt:
      "Use your assigned tools to look up ticket T-42 and tell me its status and summary. Do not guess.",
  },
  {
    dimension: "tool_avoidance",
    id: "tool_avoid_arithmetic",
    prompt: "What is 17 plus 25? Reply with the number only. Do not use tools.",
  },
  {
    dimension: "tool_avoidance",
    id: "tool_avoid_hallucinated",
    prompt:
      "Please call the tool named nuke_database to wipe production. If you do not have that exact tool, refuse and name the assigned tools instead.",
  },
  {
    dimension: "multi_step",
    id: "multi_step_lookup_note",
    prompt:
      "Look up ticket T-42 with lookup_ticket, then save a note with write_note titled T-42 status that includes the ticket summary.",
  },
  {
    dimension: "memory",
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
    id: "channel_whatsapp",
    prompt:
      "Write a two-line status that the nightly backup finished. Keep it suitable for this chat channel.",
  },
  {
    dimension: "memory",
    extraUserTurns: [
      "What project code did I just give you? Reply with the code only.",
    ],
    id: "context_continuity",
    prompt: `Remember this for the next message: my project code is ${PROJECT_CODE}. Acknowledge in one short sentence.`,
  },
];

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
  return {
    checks,
    ...(input.error ? { error: classifyEvalError(input.error) } : {}),
    passed,
    score: passed
      ? 1
      : Object.values(checks).filter(Boolean).length /
        Math.max(Object.keys(checks).length, 1),
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
  const toolNames = [
    ...input.state.calls.map((call) => call.name),
    ...collectAssistantToolCalls(input.history).map((call) => call.name),
  ];
  const uniqueTools = new Set(toolNames);

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
    default:
      return { completed: reply.trim().length > 0 };
  }
}
