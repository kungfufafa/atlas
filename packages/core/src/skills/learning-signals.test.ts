import { describe, expect, test } from "bun:test";
import {
  collectSkillLearningSignals,
  looksLikeTaughtProcedure,
  parseUnknownToolName,
  resolveSkillFailureLearningEnabled,
  skillLearningAllowedOnChannel,
  skillLearningIsEligible,
} from "./learning-signals";

describe("resolveSkillFailureLearningEnabled", () => {
  test("defaults off", () => {
    expect(resolveSkillFailureLearningEnabled({})).toBe(false);
  });

  test("session override wins over org review", () => {
    expect(
      resolveSkillFailureLearningEnabled({
        orgSkillsPostTurnReview: true,
        sessionEnabled: false,
      })
    ).toBe(false);
    expect(
      resolveSkillFailureLearningEnabled({
        orgSkillsPostTurnReview: false,
        sessionEnabled: true,
      })
    ).toBe(true);
  });

  test("inherits opted-in post-turn review when session unset", () => {
    expect(
      resolveSkillFailureLearningEnabled({
        orgSkillsPostTurnReview: true,
        profileSkillsPostTurnReview: null,
      })
    ).toBe(true);
  });
});

describe("skillLearningAllowedOnChannel", () => {
  test("allows web and cli and skips messaging/automation", () => {
    expect(skillLearningAllowedOnChannel("web")).toBe(true);
    expect(skillLearningAllowedOnChannel("cli")).toBe(true);
    expect(skillLearningAllowedOnChannel("whatsapp")).toBe(false);
    expect(skillLearningAllowedOnChannel("telegram")).toBe(false);
    expect(skillLearningAllowedOnChannel("discord")).toBe(false);
    expect(skillLearningAllowedOnChannel("automation")).toBe(false);
    expect(skillLearningAllowedOnChannel("task")).toBe(false);
  });
});

describe("collectSkillLearningSignals", () => {
  test("extracts unknown tool names from JSON tool errors", () => {
    const signals = collectSkillLearningSignals({
      turnMessages: [
        { content: "Use clearance_stamp on T-42", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [{ arguments: "{}", id: "1", name: "clearance_stamp" }],
        },
        {
          content: JSON.stringify({ error: "Unknown tool: clearance_stamp" }),
          name: "clearance_stamp",
          role: "tool",
          toolCallId: "1",
        },
      ],
    });
    expect(signals).toEqual([
      { kind: "unknown_tool", toolName: "clearance_stamp" },
    ]);
    expect(skillLearningIsEligible(signals)).toBe(true);
  });

  test("records mechanical loop stops", () => {
    const signals = collectSkillLearningSignals({
      stopReason: "no_progress",
      turnMessages: [{ content: "keep going", role: "user" }],
    });
    expect(signals).toEqual([
      { kind: "tool_loop_stop", reason: "no_progress" },
    ]);
  });

  test("flags a taught multi-step SOP when the turn used tools", () => {
    expect(
      looksLikeTaughtProcedure(
        "You MUST follow these steps:\n1. lookup\n2. search"
      )
    ).toBe(true);
    const signals = collectSkillLearningSignals({
      turnMessages: [
        {
          content:
            "You MUST follow this SOP:\n1. Call lookup_ticket\n2. Call search_kb",
          role: "user",
        },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            { arguments: "{}", id: "1", name: "lookup_ticket" },
            { arguments: "{}", id: "2", name: "search_kb" },
          ],
        },
        { content: "{}", name: "lookup_ticket", role: "tool", toolCallId: "1" },
        { content: "{}", name: "search_kb", role: "tool", toolCallId: "2" },
      ],
    });
    expect(signals.some((signal) => signal.kind === "taught_procedure")).toBe(
      true
    );
  });

  test("flags a requested snake_case tool that is not assigned even without a call", () => {
    const signals = collectSkillLearningSignals({
      assignedToolNames: ["lookup_ticket", "write_note"],
      turnMessages: [
        {
          content: "Use the clearance_stamp tool to stamp ticket T-42",
          role: "user",
        },
        {
          content:
            "I don't have clearance_stamp. I can look the ticket up instead.",
          role: "assistant",
        },
      ],
    });
    expect(signals).toEqual([
      { kind: "requested_unassigned_tool", toolName: "clearance_stamp" },
    ]);
    expect(skillLearningIsEligible(signals)).toBe(true);
  });

  test("does not flag assigned snake_case names as missing tools", () => {
    const signals = collectSkillLearningSignals({
      assignedToolNames: ["lookup_ticket", "write_note"],
      turnMessages: [
        { content: "Call lookup_ticket then write_note", role: "user" },
        { content: "ok", role: "assistant" },
      ],
    });
    expect(
      signals.some((signal) => signal.kind === "requested_unassigned_tool")
    ).toBe(false);
  });

  test("ignores chit-chat with no failures", () => {
    expect(
      skillLearningIsEligible(
        collectSkillLearningSignals({
          turnMessages: [
            { content: "hello", role: "user" },
            { content: "hi", role: "assistant" },
          ],
        })
      )
    ).toBe(false);
  });
});

describe("parseUnknownToolName", () => {
  test("reads the prefix from a plain or JSON error", () => {
    expect(parseUnknownToolName("Unknown tool: nuke_database")).toBe(
      "nuke_database"
    );
    expect(
      parseUnknownToolName(
        JSON.stringify({ error: "Unknown tool: clearance_stamp" })
      )
    ).toBe("clearance_stamp");
    expect(parseUnknownToolName('{"ok":true}')).toBeNull();
  });
});
