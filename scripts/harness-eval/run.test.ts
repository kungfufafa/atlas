import { describe, expect, test } from "bun:test";
import { applyEnvFile, parseEnvFile } from "./env";
import { assembleEvalSystemPrompt, evalBasePrompt } from "./run";
import { EVAL_SCENARIOS, scoreScenario } from "./scenarios";
import {
  createEvalToolState,
  PROJECT_CODE,
  TICKET_ID,
  TICKET_SUMMARY,
  USER_COFFEE,
  USER_NICKNAME,
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

describe("harness-eval prompt assembly", () => {
  test("covers at least six scenarios", () => {
    expect(EVAL_SCENARIOS.length).toBeGreaterThanOrEqual(6);
  });

  test("injects WhatsApp channel rules", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "channel_whatsapp"
    );
    expect(scenario).toBeDefined();
    const prompt = assembleEvalSystemPrompt(scenario!);
    expect(prompt).toContain("WhatsApp only supports");
    expect(prompt).toContain("You have access to tools for this session");
  });

  test("injects MEMORY.md facts and work rules", () => {
    const scenario = EVAL_SCENARIOS.find(
      (entry) => entry.id === "memory_recall"
    );
    expect(scenario).toBeDefined();
    const prompt = assembleEvalSystemPrompt(scenario!);
    expect(prompt).toContain(USER_NICKNAME);
    expect(prompt).toContain(USER_COFFEE);
    expect(evalBasePrompt(scenario!)).toContain("Do not invent tools");
  });
});

describe("harness-eval scoring", () => {
  test("scores a successful ticket lookup", () => {
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
});
