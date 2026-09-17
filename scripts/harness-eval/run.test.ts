import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MEMORY_MD_BYTE_CAP,
  type GenerateChatInput,
  type ProviderClient,
} from "@atlas/core";
import {
  GROUP_CHAT_KIND_GUIDANCE,
  messagingGroupAudienceLine,
  messagingPrivateAudienceLine,
  messagingUnsetAudienceLine,
  PRIVATE_CHAT_KIND_GUIDANCE,
} from "../../packages/agent/src/chat-prompt";
import { applyEnvFile, parseEnvFile } from "./env";
import { parseHarnessEvalArgs } from "./flags";
import {
  computeAllowlistDeltas,
  type MatrixEvalReport,
  summarizeReport,
} from "./matrix";
import {
  assembleEvalSystemPrompt,
  evalBasePrompt,
  omitNativeToolSchemas,
} from "./run";
import {
  archiveFactsForScenario,
  computeToolMetrics,
  DEFAULT_SUITE_SCENARIO_IDS,
  EVAL_SCENARIOS,
  memoryFactsForScenario,
  scoreScenario,
} from "./scenarios";
import {
  ARCHIVE_BADGE,
  buildLongDistractorMemory,
  CHANNEL_ASKER,
  CHAT_DOSSIER,
  CLEARANCE_PHRASE,
  CLEARANCE_STAMP_PHRASE,
  CURRENT_OFFICE_CITY,
  createEvalToolState,
  ESCALATION_KEY,
  HARDWARE_LEAD,
  NEAR_DUPLICATE_TOOL_NAME,
  OVERFLOW_CODE,
  PROJECT_CODE,
  QUARANTINE_HOLD_TOKEN,
  QUARANTINE_SOP_QUERY,
  STALE_OFFICE_CITY,
  searchEvalChats,
  searchEvalMemories,
  TICKET_ID,
  TICKET_SUMMARY,
  UNKNOWN_CLEARANCE_TOOL,
  USER_COFFEE,
  USER_NICKNAME,
  VAULT_HINT,
  WORDING_TRAP_TOOL_NAME,
} from "./tools";

describe("harness-eval env", () => {
  test("parses export lines without exposing values in thrown errors", () => {
    const parsed = parseEnvFile(
      'export OPENCODE_GO_API_KEY="oc-test"\nOPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1\n'
    );
    expect(parsed.OPENCODE_GO_API_KEY).toBe("oc-test");
    expect(parsed.OPENCODE_GO_BASE_URL).toBe("https://opencode.ai/zen/go/v1");
  });

  test("does not overwrite an already-set environment value", () => {
    const env: NodeJS.ProcessEnv = { OPENCODE_GO_API_KEY: "existing" };
    applyEnvFile('OPENCODE_GO_API_KEY="from-file"', env);
    expect(env.OPENCODE_GO_API_KEY).toBe("existing");
  });
});

describe("harness-eval flags", () => {
  test("defaults keep work-rules, allowlist, native schemas, and memory retrieval on", () => {
    const flags = parseHarnessEvalArgs([], {});
    expect(flags.allowlist).toBe(true);
    expect(flags.workRules).toBe(true);
    expect(flags.nativeSchemas).toBe(true);
    expect(flags.memoryRetrieval).toBe(true);
    expect(flags.memorySummarization).toBe(true);
    expect(flags.archiveIndex).toBe(true);
    expect(flags.chatKind).toBe(true);
    expect(flags.skillLearning).toBe(false);
    expect(flags.matrix).toBe(false);
  });

  test("CLI flags override env and last duplicate wins", () => {
    const flags = parseHarnessEvalArgs(
      [
        "--no-allowlist",
        "--no-work-rules",
        "--no-native-schemas",
        "--allowlist",
        "--no-memory-retrieval",
        "--no-memory-summarization",
        "--no-archive-index",
        "--archive-index",
        "--no-chat-kind",
        "--chat-kind",
        "--skill-learning",
        "--no-skill-learning",
        "--skill-learning",
      ],
      {
        HARNESS_EVAL_ALLOWLIST: "0",
        HARNESS_EVAL_NATIVE_SCHEMAS: "1",
        HARNESS_EVAL_WORK_RULES: "1",
      }
    );
    expect(flags.allowlist).toBe(true);
    expect(flags.workRules).toBe(false);
    expect(flags.nativeSchemas).toBe(false);
    expect(flags.memoryRetrieval).toBe(false);
    expect(flags.memorySummarization).toBe(false);
    expect(flags.archiveIndex).toBe(true);
    expect(flags.chatKind).toBe(true);
    expect(flags.skillLearning).toBe(true);
  });

  test("parses model, scenario, and matrix model flags", () => {
    const flags = parseHarnessEvalArgs(
      [
        "--model",
        "glm-5.3-flash",
        "--scenario",
        "tool_select_lookup",
        "--scenario",
        "tool_avoid_no_fit_lure",
        "--matrix",
        "--strong-model",
        "kimi-k2.7-code",
        "--weak-model",
        "deepseek-flash",
      ],
      {}
    );
    expect(flags.model).toBe("glm-5.3-flash");
    expect(flags.scenarioIds).toEqual([
      "tool_select_lookup",
      "tool_avoid_no_fit_lure",
    ]);
    expect(flags.matrix).toBe(true);
    expect(flags.strongModel).toBe("kimi-k2.7-code");
    expect(flags.weakModel).toBe("deepseek-flash");
  });

  test("env 0/false disables ablation switches", () => {
    const flags = parseHarnessEvalArgs([], {
      HARNESS_EVAL_ALLOWLIST: "false",
      HARNESS_EVAL_ARCHIVE_INDEX: "0",
      HARNESS_EVAL_CHAT_KIND: "0",
      HARNESS_EVAL_MEMORY_RETRIEVAL: "0",
      HARNESS_EVAL_MEMORY_SUMMARIZATION: "off",
      HARNESS_EVAL_NATIVE_SCHEMAS: "off",
      HARNESS_EVAL_SKILL_LEARNING: "0",
      HARNESS_EVAL_WORK_RULES: "0",
    });
    expect(flags.allowlist).toBe(false);
    expect(flags.memoryRetrieval).toBe(false);
    expect(flags.memorySummarization).toBe(false);
    expect(flags.archiveIndex).toBe(false);
    expect(flags.chatKind).toBe(false);
    expect(flags.nativeSchemas).toBe(false);
    expect(flags.skillLearning).toBe(false);
    expect(flags.workRules).toBe(false);
  });
});

describe("harness-eval prompt assembly", () => {
  test("covers the original suite plus discriminating scenarios", () => {
    const ids = EVAL_SCENARIOS.map((entry) => entry.id);
    expect(ids).toContain("session_transport");
    expect(ids).toContain("tool_avoid_no_fit");
    expect(ids).toContain("tool_select_near_duplicate");
    expect(ids).toContain("multi_step_three_hop");
    expect(ids).toContain("memory_long_context_needle");
    expect(ids).toContain("tool_avoid_wording_trap");
    expect(ids).toContain("tool_avoid_no_fit_lure");
    expect(ids).toContain("memory_archive_needle");
    expect(ids).toContain("memory_conflict_recency");
    expect(ids).toContain("memory_search_chats");
    expect(ids).toContain("memory_bounded_dump");
    expect(ids).toContain("memory_summary_needle");
    expect(ids).toContain("learn_sop_acquisition");
    expect(ids).toContain("learn_unknown_tool_recovery");
    expect(ids).toContain("channel_whatsapp_private");
    expect(ids).toContain("channel_whatsapp_group");
    expect(ids).toContain("channel_telegram_private");
    expect(ids).toContain("channel_telegram_group");
    expect(ids).toContain("tool_avoid_unassigned_decoy");
    expect(EVAL_SCENARIOS.length).toBeGreaterThanOrEqual(29);
  });

  test("injects WhatsApp channel rules", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "channel_whatsapp"
    );
    expect(scenario).toBeDefined();
    const prompt = assembleEvalSystemPrompt(scenario!);
    expect(prompt).toContain("WhatsApp only supports");
    expect(prompt).toContain("You have access to tools for this session");
    expect(prompt).toContain("# Assigned tools");
    expect(prompt).toContain("- lookup_ticket — purpose:");
    expect(prompt).toContain("- write_note — purpose:");
    expect(prompt).toContain("- search_kb — purpose:");
  });

  test("plumbs private vs group chatKind into WhatsApp and Telegram prompts", () => {
    const whatsappPrivate = EVAL_SCENARIOS.find(
      (entry) => entry.id === "channel_whatsapp_private"
    );
    const whatsappGroup = EVAL_SCENARIOS.find(
      (entry) => entry.id === "channel_whatsapp_group"
    );
    const telegramPrivate = EVAL_SCENARIOS.find(
      (entry) => entry.id === "channel_telegram_private"
    );
    const telegramGroup = EVAL_SCENARIOS.find(
      (entry) => entry.id === "channel_telegram_group"
    );
    expect(whatsappPrivate?.chatKind).toBe("private");
    expect(whatsappGroup?.chatKind).toBe("group");

    const privatePrompt = assembleEvalSystemPrompt(whatsappPrivate!);
    const groupPrompt = assembleEvalSystemPrompt(whatsappGroup!);
    const unsetPrompt = assembleEvalSystemPrompt(whatsappPrivate!, {
      chatKind: false,
    });

    expect(privatePrompt).toContain(messagingPrivateAudienceLine("WhatsApp"));
    expect(privatePrompt).toContain(PRIVATE_CHAT_KIND_GUIDANCE);
    expect(privatePrompt).not.toContain(messagingGroupAudienceLine("WhatsApp"));
    expect(groupPrompt).toContain(messagingGroupAudienceLine("WhatsApp"));
    expect(groupPrompt).toContain(GROUP_CHAT_KIND_GUIDANCE);
    expect(groupPrompt).not.toContain(messagingPrivateAudienceLine("WhatsApp"));
    expect(privatePrompt).not.toBe(groupPrompt);
    expect(unsetPrompt).toContain(messagingUnsetAudienceLine("WhatsApp"));
    expect(unsetPrompt).not.toContain(messagingPrivateAudienceLine("WhatsApp"));
    expect(unsetPrompt).not.toContain(messagingGroupAudienceLine("WhatsApp"));

    const telegramPrivatePrompt = assembleEvalSystemPrompt(telegramPrivate!);
    const telegramGroupPrompt = assembleEvalSystemPrompt(telegramGroup!);
    expect(telegramPrivatePrompt).toContain(
      messagingPrivateAudienceLine("Telegram")
    );
    expect(telegramGroupPrompt).toContain(
      messagingGroupAudienceLine("Telegram")
    );
    expect(telegramPrivatePrompt).not.toBe(telegramGroupPrompt);
  });

  test("unassigned decoy is omitted from the assigned-tool roster", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_avoid_unassigned_decoy"
    );
    expect(scenario).toBeDefined();
    const prompt = assembleEvalSystemPrompt(scenario!);
    expect(prompt).toContain("- lookup_ticket — purpose:");
    expect(prompt).not.toContain(`- ${WORDING_TRAP_TOOL_NAME}`);
    expect(prompt).toContain("Choose a tool by its purpose");
  });

  test("injects MEMORY.md facts and work rules by default", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_recall"
    );
    expect(scenario).toBeDefined();
    const prompt = assembleEvalSystemPrompt(scenario!);
    expect(prompt).toContain(USER_NICKNAME);
    expect(prompt).toContain(USER_COFFEE);
    expect(evalBasePrompt(scenario!)).toContain("Do not invent tools");
  });

  test("can omit work rules independently of the allowlist", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_select_lookup"
    );
    expect(scenario).toBeDefined();
    const prompt = assembleEvalSystemPrompt(scenario!, { workRules: false });
    expect(evalBasePrompt(scenario!, { workRules: false })).not.toContain(
      "Do not invent tools"
    );
    expect(prompt).toContain("# Assigned tools");
    expect(prompt).toContain("- lookup_ticket — purpose:");
  });

  test("can omit the assigned-tool allowlist independently of work rules", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_select_lookup"
    );
    expect(scenario).toBeDefined();
    const prompt = assembleEvalSystemPrompt(scenario!, { allowlist: false });
    expect(evalBasePrompt(scenario!)).toContain("Do not invent tools");
    expect(prompt).not.toContain("# Assigned tools");
    expect(prompt).not.toContain("- lookup_ticket — purpose:");
    expect(prompt).toContain(
      "Atlas executes these tools independently of the selected model provider"
    );
  });

  test("embeds the long-context needle in MEMORY.md", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_long_context_needle"
    );
    expect(scenario).toBeDefined();
    const prompt = assembleEvalSystemPrompt(scenario!);
    expect(prompt).toContain(CLEARANCE_PHRASE);
    expect(prompt).toContain("Warehouse bin 001");
    expect(prompt).toContain("Warehouse bin 090");
  });

  test("90-bin MEMORY.md stays under the product injection cap", () => {
    const bytes = new TextEncoder().encode(
      buildLongDistractorMemory()
    ).byteLength;
    expect(bytes).toBeLessThanOrEqual(DEFAULT_MEMORY_MD_BYTE_CAP);
  });

  test("dump-only injects overflow needle; retrieval bounding omits it", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_bounded_dump"
    );
    expect(scenario).toBeDefined();
    const dumped = assembleEvalSystemPrompt(scenario!, {
      memoryRetrieval: false,
    });
    expect(dumped).toContain(OVERFLOW_CODE);
    const bounded = assembleEvalSystemPrompt(scenario!);
    expect(bounded).not.toContain(OVERFLOW_CODE);
    expect(bounded).toContain("memory_search");
  });

  test("archive needle and chat dossier stay out of the injected prompt", () => {
    const archive = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_archive_needle"
    );
    const chats = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_search_chats"
    );
    expect(archive).toBeDefined();
    expect(chats).toBeDefined();
    expect(assembleEvalSystemPrompt(archive!)).not.toContain(ARCHIVE_BADGE);
    expect(assembleEvalSystemPrompt(chats!)).not.toContain(CHAT_DOSSIER);
  });

  test("extractive bounding omits the vault hint; a supplied summary keeps it", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_summary_needle"
    );
    expect(scenario).toBeDefined();
    const extractive = assembleEvalSystemPrompt(scenario!);
    expect(extractive).not.toContain(VAULT_HINT);
    expect(extractive).toContain("Warehouse bin");
    const summarized = evalBasePrompt(scenario!, {
      memorySummary: `The user's vault passphrase hint is ${VAULT_HINT}.`,
    });
    expect(summarized).toContain(VAULT_HINT);
    expect(summarized).toContain("Warehouse bin");
  });

  test("archive needle is loaded from production archive files, not live MEMORY.md", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_archive_needle"
    );
    expect(scenario).toBeDefined();
    expect(
      memoryFactsForScenario(scenario!).some((fact) =>
        fact.content.includes(ARCHIVE_BADGE)
      )
    ).toBe(false);
    expect(
      archiveFactsForScenario(scenario!).some((fact) =>
        fact.content.includes(ARCHIVE_BADGE)
      )
    ).toBe(true);
    expect(DEFAULT_SUITE_SCENARIO_IDS).toHaveLength(21);
    expect(DEFAULT_SUITE_SCENARIO_IDS).toContain("memory_archive_needle");
    expect(DEFAULT_SUITE_SCENARIO_IDS).not.toContain("memory_summary_needle");
    expect(DEFAULT_SUITE_SCENARIO_IDS).not.toContain(
      "channel_whatsapp_private"
    );
    expect(DEFAULT_SUITE_SCENARIO_IDS).not.toContain(
      "tool_avoid_unassigned_decoy"
    );
  });
});

describe("harness-eval scoring", () => {
  test("scores a successful ticket lookup with perfect tool metrics", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_select_lookup"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: "lookup_ticket",
    });
    const scored = scoreScenario({
      history: [],
      reply: `Ticket ${TICKET_ID} is in_progress: ${TICKET_SUMMARY}`,
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(true);
    expect(scored.score).toBe(1);
    expect(scored.toolPrecision).toBe(1);
    expect(scored.toolRecall).toBe(1);
    expect(scored.gradedScore).toBe(1);
  });

  test("gives partial credit and lower precision when an extra tool is called", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_select_lookup"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: "lookup_ticket",
    });
    state.calls.push({
      arguments: { query: "status" },
      name: "search_kb",
    });
    const scored = scoreScenario({
      history: [],
      reply: `Ticket ${TICKET_ID} is in_progress: ${TICKET_SUMMARY}`,
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(true);
    expect(scored.toolPrecision).toBe(0.5);
    expect(scored.toolRecall).toBe(1);
    expect(scored.gradedScore).toBeLessThan(1);
  });

  test("classifies MissingSessionID as a transport failure", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "session_transport"
    );
    expect(scenario).toBeDefined();
    const scored = scoreScenario({
      error:
        "OpenCode Go request failed (400): MissingSessionID Request is missing x-opencode-session",
      history: [],
      reply: "",
      scenario: scenario!,
      state: createEvalToolState(),
      systemPrompt: "",
    });
    expect(scored.passed).toBe(false);
    expect(scored.error).toBe("missing_opencode_session");
    expect(scored.toolPrecision).toBe(0);
    expect(scored.toolRecall).toBe(0);
  });

  test("fails hallucinated nuke_database calls", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_avoid_hallucinated"
    );
    expect(scenario).toBeDefined();
    const scored = scoreScenario({
      history: [
        {
          content: "",
          role: "assistant",
          toolCalls: [{ arguments: {}, id: "1", name: "nuke_database" }],
        },
      ],
      reply: "wiping",
      scenario: scenario!,
      state: createEvalToolState(),
      systemPrompt: "",
    });
    expect(scored.passed).toBe(false);
    expect(scored.checks.did_not_call_nuke_database).toBe(false);
    expect(scored.toolPrecision).toBe(0);
  });

  test("fails using assigned tools when the request needs absent web/email tools", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_avoid_absent_web_search"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({
      arguments: { query: "tokyo weather" },
      name: "search_kb",
    });
    const scored = scoreScenario({
      history: [],
      reply: "Rain in Tokyo. Email sent.",
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(false);
    expect(scored.checks.zero_tool_calls).toBe(false);
    expect(scored.checks.did_not_call_wrong_assigned).toBe(false);
    expect(scored.toolPrecision).toBe(0);
  });

  test("fails calling the archive decoy instead of the live lookup", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_avoid_decoy_archive"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: "lookup_ticket_archive",
    });
    const scored = scoreScenario({
      history: [],
      reply: "Ticket T-42 is closed: Closed archive copy",
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(false);
    expect(scored.checks.did_not_call_decoy).toBe(false);
    expect(scored.checks.called_live_lookup).toBe(false);
    expect(scored.toolPrecision).toBe(0);
    expect(scored.toolRecall).toBe(0);
  });

  test("scores combining lookup_ticket and search_kb", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "multi_step_ticket_and_kb"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: "lookup_ticket",
    });
    state.calls.push({
      arguments: { query: "on-call rotation" },
      name: "search_kb",
    });
    const scored = scoreScenario({
      history: [],
      reply: `${TICKET_SUMMARY}. On-call rotation is posted in the ops channel.`,
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(true);
    expect(scored.toolPrecision).toBe(1);
    expect(scored.toolRecall).toBe(1);
  });

  test("fails a general question that still called a tool", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_avoid_no_fit"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({ arguments: { query: "mutex" }, name: "search_kb" });
    const scored = scoreScenario({
      history: [],
      reply: "A mutex is a lock that serializes access to a shared resource.",
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(false);
    expect(scored.checks.zero_tool_calls).toBe(false);
    expect(scored.checks.explained_mutex).toBe(true);
  });

  test("scores two-turn project code recall", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "context_continuity"
    );
    expect(scenario).toBeDefined();
    const scored = scoreScenario({
      history: [],
      reply: PROJECT_CODE,
      scenario: scenario!,
      state: createEvalToolState(),
      systemPrompt: "",
    });
    expect(scored.passed).toBe(true);
  });

  test("fails the near-duplicate title search when the id is already known", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_select_near_duplicate"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({
      arguments: { title: "T-42" },
      name: NEAR_DUPLICATE_TOOL_NAME,
    });
    const scored = scoreScenario({
      history: [],
      reply: "Title search miss — not the live T-42 record",
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(false);
    expect(scored.checks.did_not_call_near_duplicate).toBe(false);
    expect(scored.checks.called_lookup_by_id).toBe(false);
  });

  test("requires the three-hop chain to use the ticket escalation key in order", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "multi_step_three_hop"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: "lookup_ticket",
    });
    state.calls.push({
      arguments: { query: ESCALATION_KEY },
      name: "search_kb",
    });
    state.calls.push({
      arguments: {
        body: `${TICKET_SUMMARY}; hardware lead ${HARDWARE_LEAD}`,
        title: "T-42 escalation",
      },
      name: "write_note",
    });
    state.notes.push({
      body: `${TICKET_SUMMARY}; hardware lead ${HARDWARE_LEAD}`,
      title: "T-42 escalation",
    });
    const scored = scoreScenario({
      history: [],
      reply: "Saved the escalation note.",
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(true);
    expect(scored.toolRecall).toBe(1);

    const skippedDependency = createEvalToolState();
    skippedDependency.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: "lookup_ticket",
    });
    skippedDependency.calls.push({
      arguments: { query: "on-call" },
      name: "search_kb",
    });
    skippedDependency.calls.push({
      arguments: { body: TICKET_SUMMARY, title: "T-42 escalation" },
      name: "write_note",
    });
    skippedDependency.notes.push({
      body: TICKET_SUMMARY,
      title: "T-42 escalation",
    });
    const partial = scoreScenario({
      history: [],
      reply: "Saved.",
      scenario: scenario!,
      state: skippedDependency,
      systemPrompt: "",
    });
    expect(partial.passed).toBe(false);
    expect(partial.checks.called_search_with_escalation_key).toBe(false);
    expect(partial.score).toBeGreaterThan(0);
    expect(partial.score).toBeLessThan(1);
  });

  test("scores long-context needle recall and penalizes tool use", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_long_context_needle"
    );
    expect(scenario).toBeDefined();
    const scored = scoreScenario({
      history: [],
      reply: CLEARANCE_PHRASE,
      scenario: scenario!,
      state: createEvalToolState(),
      systemPrompt: "",
    });
    expect(scored.passed).toBe(true);

    const usedTools = createEvalToolState();
    usedTools.calls.push({
      arguments: { query: "clearance" },
      name: "search_kb",
    });
    const failed = scoreScenario({
      history: [],
      reply: CLEARANCE_PHRASE,
      scenario: scenario!,
      state: usedTools,
      systemPrompt: "",
    });
    expect(failed.passed).toBe(false);
    expect(failed.checks.recalled_clearance_phrase).toBe(true);
    expect(failed.score).toBe(0.5);
  });

  test("fails the wording-trap decoy that matches the user phrasing", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_avoid_wording_trap"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: WORDING_TRAP_TOOL_NAME,
    });
    const scored = scoreScenario({
      history: [],
      reply: "Live-index preview stub",
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(false);
    expect(scored.checks.did_not_call_wording_trap).toBe(false);
    expect(scored.toolPrecision).toBe(0);
  });

  test("scores private vs group channel replies", () => {
    const privateScenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "channel_whatsapp_private"
    );
    const groupScenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "channel_whatsapp_group"
    );
    expect(privateScenario).toBeDefined();
    expect(groupScenario).toBeDefined();
    const privatePrompt = assembleEvalSystemPrompt(privateScenario!);
    const groupPrompt = assembleEvalSystemPrompt(groupScenario!);

    const privatePass = scoreScenario({
      history: [],
      reply: "Nightly backup finished.",
      scenario: privateScenario!,
      state: createEvalToolState(),
      systemPrompt: privatePrompt,
    });
    expect(privatePass.passed).toBe(true);
    expect(privatePass.checks.reply_does_not_address_asker).toBe(true);

    const privateFail = scoreScenario({
      history: [],
      reply: `${CHANNEL_ASKER} — nightly backup finished.`,
      scenario: privateScenario!,
      state: createEvalToolState(),
      systemPrompt: privatePrompt,
    });
    expect(privateFail.passed).toBe(false);
    expect(privateFail.checks.reply_does_not_address_asker).toBe(false);

    const groupPass = scoreScenario({
      history: [],
      reply: `${CHANNEL_ASKER} nightly backup finished.`,
      scenario: groupScenario!,
      state: createEvalToolState(),
      systemPrompt: groupPrompt,
    });
    expect(groupPass.passed).toBe(true);
    expect(groupPass.checks.reply_addresses_asker).toBe(true);

    const groupFail = scoreScenario({
      history: [],
      reply: "Nightly backup finished.",
      scenario: groupScenario!,
      state: createEvalToolState(),
      systemPrompt: groupPrompt,
    });
    expect(groupFail.passed).toBe(false);
    expect(groupFail.checks.reply_addresses_asker).toBe(false);
  });

  test("unassigned decoy fails when the missing close name is invented", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_avoid_unassigned_decoy"
    );
    expect(scenario).toBeDefined();
    const invented = createEvalToolState();
    invented.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: WORDING_TRAP_TOOL_NAME,
    });
    const failed = scoreScenario({
      history: [],
      reply: "Live-index preview stub",
      scenario: scenario!,
      state: invented,
      systemPrompt: assembleEvalSystemPrompt(scenario!),
    });
    expect(failed.passed).toBe(false);
    expect(failed.checks.did_not_call_unassigned_decoy).toBe(false);
    expect(failed.checks.prompt_omits_unassigned_decoy).toBe(true);

    const mapped = createEvalToolState();
    mapped.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: "lookup_ticket",
    });
    const passed = scoreScenario({
      history: [],
      reply: `Ticket ${TICKET_ID} is in_progress: ${TICKET_SUMMARY}`,
      scenario: scenario!,
      state: mapped,
      systemPrompt: assembleEvalSystemPrompt(scenario!),
    });
    expect(passed.passed).toBe(true);
    expect(passed.checks.called_real_lookup).toBe(true);
  });

  test("fails a no-fit lure that substitutes search_kb or invents generate_image", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "tool_avoid_no_fit_lure"
    );
    expect(scenario).toBeDefined();
    const state = createEvalToolState();
    state.calls.push({
      arguments: { query: "red fox logo" },
      name: "search_kb",
    });
    const scored = scoreScenario({
      history: [],
      reply: "https://example.com/fox.png",
      scenario: scenario!,
      state,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(false);
    expect(scored.checks.zero_tool_calls).toBe(false);
    expect(scored.checks.no_fake_image_url).toBe(false);

    const refused = scoreScenario({
      history: [],
      reply: "I cannot generate images with the assigned tools.",
      scenario: scenario!,
      state: createEvalToolState(),
      systemPrompt: "",
    });
    expect(refused.passed).toBe(true);
    expect(refused.toolPrecision).toBe(1);
  });
});

describe("harness-eval tool metrics", () => {
  test("empty expected tools treats any call as precision 0", () => {
    expect(computeToolMetrics([], [])).toEqual({ precision: 1, recall: 1 });
    expect(computeToolMetrics([], ["search_kb"])).toEqual({
      precision: 0,
      recall: 1,
    });
  });

  test("nonempty expected tools score recall independently of extra calls", () => {
    expect(
      computeToolMetrics(["lookup_ticket", "write_note"], ["lookup_ticket"])
    ).toEqual({ precision: 1, recall: 0.5 });
    expect(
      computeToolMetrics(["lookup_ticket"], ["lookup_ticket", "search_kb"])
    ).toEqual({ precision: 0.5, recall: 1 });
  });
});

describe("harness-eval native schema wrap", () => {
  test("strips tools from generateChat and streamChat", async () => {
    const seen: Array<GenerateChatInput["tools"]> = [];
    const inner = {
      generateChat(input: GenerateChatInput) {
        seen.push(input.tools);
        return Promise.resolve({
          assistantMessage: { content: "ok", role: "assistant" as const },
          content: "ok",
        });
      },
      generateText() {
        return Promise.resolve({ content: "text" });
      },
      name: "mock",
      streamChat(input: GenerateChatInput) {
        seen.push(input.tools);
        return this.generateChat(input);
      },
    } as unknown as ProviderClient;
    const wrapped = omitNativeToolSchemas(inner);
    const tool = {
      description: "Look up a ticket",
      name: "lookup_ticket",
      parameters: { properties: {}, type: "object" as const },
    };
    await wrapped.generateChat({
      messages: [],
      system: "sys",
      tools: [tool],
    });
    await wrapped.streamChat(
      {
        messages: [],
        system: "sys",
        tools: [tool],
      },
      { onChunk: () => undefined }
    );
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe("harness-eval matrix summary", () => {
  test("computes allowlist deltas from paired cells", () => {
    const report = (passed: number, precision: number): MatrixEvalReport => ({
      generatedAt: "t",
      scenarios: [
        {
          dimension: "tool_avoidance",
          gradedScore: precision,
          id: "tool_avoid_hallucinated",
          passed: passed === 1,
          toolCalls: passed === 1 ? [] : ["nuke_database"],
          toolPrecision: precision,
          toolRecall: 1,
        },
      ],
      summary: {
        failed: 1 - passed,
        meanScore: precision,
        passed,
        transportOk: true,
      },
    });
    const off = summarizeReport(
      report(0, 0),
      {
        allowlist: false,
        model: "deepseek-flash",
        modelClass: "weak",
        nativeSchemas: true,
        workRules: false,
      },
      "off.json"
    );
    const on = summarizeReport(
      report(1, 1),
      {
        allowlist: true,
        model: "deepseek-flash",
        modelClass: "weak",
        nativeSchemas: true,
        workRules: false,
      },
      "on.json"
    );
    const deltas = computeAllowlistDeltas([off, on]);
    const precision = deltas.find(
      (delta) => delta.metric === "meanToolPrecision"
    );
    const hallucination = deltas.find(
      (delta) => delta.metric === "hallucinationRate"
    );
    expect(precision?.delta).toBe(1);
    expect(hallucination?.delta).toBe(-1);
  });
});

describe("harness-eval memory retrieval yardsticks", () => {
  test("dump-only scoring fails the four retrieval scenarios", () => {
    for (const id of [
      "memory_archive_needle",
      "memory_conflict_recency",
      "memory_search_chats",
      "memory_bounded_dump",
    ]) {
      const scenario = EVAL_SCENARIOS.find((entry) => entry.id === id);
      expect(scenario).toBeDefined();
      const dumped = assembleEvalSystemPrompt(scenario!, {
        memoryRetrieval: false,
      });
      const scored = scoreScenario({
        history: [],
        reply: id === "memory_conflict_recency" ? STALE_OFFICE_CITY : "unknown",
        scenario: scenario!,
        state: createEvalToolState(),
        systemPrompt: dumped,
      });
      expect(scored.passed).toBe(false);
    }
  });

  test("retrieval scoring passes when the store is searched", () => {
    const archive = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_archive_needle"
    );
    expect(archive).toBeDefined();
    const state = createEvalToolState({
      memories: [
        ...memoryFactsForScenario(archive!),
        ...archiveFactsForScenario(archive!),
      ],
    });
    state.calls.push({
      arguments: { query: "badge code" },
      name: "memory_search",
    });
    const scored = scoreScenario({
      history: [],
      reply: ARCHIVE_BADGE,
      scenario: archive!,
      state,
      systemPrompt: assembleEvalSystemPrompt(archive!),
    });
    expect(scored.passed).toBe(true);
    expect(scored.toolPrecision).toBe(1);
    expect(scored.toolRecall).toBe(1);
  });

  test("summary yardstick fails on extractive injection and passes when the hint is present", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_summary_needle"
    );
    expect(scenario).toBeDefined();
    const extractive = assembleEvalSystemPrompt(scenario!);
    const failed = scoreScenario({
      history: [],
      reply: "I do not see a vault hint.",
      scenario: scenario!,
      state: createEvalToolState(),
      systemPrompt: extractive,
    });
    expect(failed.passed).toBe(false);
    expect(failed.checks.prompt_contains_vault_hint).toBe(false);

    const summarized = evalBasePrompt(scenario!, {
      memorySummary: `The user's vault passphrase hint is ${VAULT_HINT}.`,
    });
    const passed = scoreScenario({
      history: [],
      reply: VAULT_HINT,
      scenario: scenario!,
      state: createEvalToolState(),
      systemPrompt: summarized,
    });
    expect(passed.passed).toBe(true);
    expect(passed.checks.prompt_contains_vault_hint).toBe(true);
    expect(passed.checks.recalled_vault_hint).toBe(true);
  });

  test("shared ranking returns the newer office city and the overflow code", () => {
    const conflict = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_conflict_recency"
    );
    const overflow = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_bounded_dump"
    );
    expect(conflict).toBeDefined();
    expect(overflow).toBeDefined();
    const office = searchEvalMemories(
      memoryFactsForScenario(conflict!),
      "What city is the office in?",
      3
    );
    expect(office[0]?.content).toContain(CURRENT_OFFICE_CITY);
    expect(
      office.some((item) => item.content.includes(STALE_OFFICE_CITY))
    ).toBe(false);
    const codes = searchEvalMemories(
      memoryFactsForScenario(overflow!),
      "overflow code",
      3
    );
    expect(codes[0]?.content).toContain(OVERFLOW_CODE);
  });

  test("production archive parser ranks the badge that live MEMORY.md omits", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_archive_needle"
    );
    expect(scenario).toBeDefined();
    const live = searchEvalMemories(
      memoryFactsForScenario(scenario!),
      "badge code",
      3
    );
    expect(live.some((item) => item.content.includes(ARCHIVE_BADGE))).toBe(
      false
    );
    const archived = searchEvalMemories(
      archiveFactsForScenario(scenario!),
      "badge code",
      3
    );
    expect(archived[0]?.content).toContain(ARCHIVE_BADGE);
  });

  test("search_chats ranking finds the other-session dossier", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_search_chats"
    );
    expect(scenario).toBeDefined();
    const hits = searchEvalChats(
      scenario!.chatTranscripts ?? [],
      "vendor dossier code"
    );
    expect(hits[0]?.matchedSnippet).toContain(CHAT_DOSSIER);
  });
});

describe("harness-eval learning yardsticks", () => {
  test("phase 2 SOP fails without a learned skill and passes with one", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "learn_sop_acquisition"
    );
    expect(scenario).toBeDefined();
    const empty = createEvalToolState();
    const without = scoreScenario({
      history: [],
      learnedSkills: [],
      reply: "I filed it",
      scenario: scenario!,
      skillLearning: false,
      state: empty,
      systemPrompt: "",
    });
    expect(without.passed).toBe(false);

    const withLearning = createEvalToolState();
    withLearning.calls.push(
      { arguments: { ticketId: TICKET_ID }, name: "lookup_ticket" },
      { arguments: { query: QUARANTINE_SOP_QUERY }, name: "search_kb" },
      {
        arguments: {
          body: `summary + ${QUARANTINE_HOLD_TOKEN}`,
          title: "quarantine-hold",
        },
        name: "write_note",
      }
    );
    withLearning.notes.push({
      body: `summary + ${QUARANTINE_HOLD_TOKEN}`,
      title: "quarantine-hold",
    });
    const scored = scoreScenario({
      history: [],
      learnedSkills: [
        {
          body: `Call search_kb with ${QUARANTINE_SOP_QUERY}`,
          description: "File a quarantine hold",
          name: "quarantine-hold",
        },
      ],
      reply: "done",
      scenario: scenario!,
      skillLearning: true,
      state: withLearning,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(true);
  });

  test("unknown-tool recovery requires assigned tools on phase 2 when learning is on", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "learn_unknown_tool_recovery"
    );
    expect(scenario).toBeDefined();
    const failed = createEvalToolState();
    failed.calls.push({
      arguments: { ticketId: TICKET_ID },
      name: UNKNOWN_CLEARANCE_TOOL,
    });
    const without = scoreScenario({
      history: [],
      learnedSkills: [],
      phase1Calls: [UNKNOWN_CLEARANCE_TOOL],
      reply: "unknown tool",
      scenario: scenario!,
      skillLearning: false,
      state: failed,
      systemPrompt: "",
    });
    expect(without.passed).toBe(false);

    const guessed = createEvalToolState();
    guessed.calls.push(
      { arguments: { ticketId: TICKET_ID }, name: "lookup_ticket" },
      {
        arguments: { body: TICKET_SUMMARY, title: "clearance-stamp" },
        name: "write_note",
      }
    );
    guessed.notes.push({ body: TICKET_SUMMARY, title: "clearance-stamp" });
    const guessedScore = scoreScenario({
      history: [],
      learnedSkills: [],
      phase1Calls: [UNKNOWN_CLEARANCE_TOOL],
      reply: "looked up and noted",
      scenario: scenario!,
      skillLearning: false,
      state: guessed,
      systemPrompt: "",
    });
    expect(guessedScore.passed).toBe(false);
    expect(guessedScore.checks.phase2_note_has_stamp_phrase).toBe(false);

    const recovered = createEvalToolState();
    recovered.calls.push(
      { arguments: { ticketId: TICKET_ID }, name: "lookup_ticket" },
      {
        arguments: {
          body: `${TICKET_SUMMARY} ${CLEARANCE_STAMP_PHRASE}`,
          title: "clearance-stamp",
        },
        name: "write_note",
      }
    );
    recovered.notes.push({
      body: `${TICKET_SUMMARY} ${CLEARANCE_STAMP_PHRASE}`,
      title: "clearance-stamp",
    });
    const scored = scoreScenario({
      history: [],
      learnedSkills: [
        {
          body: `Never call \`${UNKNOWN_CLEARANCE_TOOL}\`. Token ${CLEARANCE_STAMP_PHRASE}`,
          description: "Recover when the user asks to clearance stamp",
          name: "recover-clearance-stamp",
        },
      ],
      phase1Calls: [UNKNOWN_CLEARANCE_TOOL],
      reply: "stamped via note",
      scenario: scenario!,
      skillLearning: true,
      state: recovered,
      systemPrompt: "",
    });
    expect(scored.passed).toBe(true);
  });
});
