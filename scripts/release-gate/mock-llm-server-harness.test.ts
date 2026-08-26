import { describe, expect, test } from "bun:test";
import { deleteFileInputSchema } from "../../packages/core/src/tools/builtin";
import { MockLLMServerHarness } from "./mock-llm-server-harness";
import {
  parseChatStreamEvents,
  requirePendingDeleteApproval,
} from "./suites/golden-journeys-suite";

describe("release-gate mock response routing", () => {
  test("routes empty chat-search results by tool identity, not generic JSON keys", () => {
    const harness = new MockLLMServerHarness();
    const response = harness.resolveResponse({
      messages: [
        { content: "When did I say Apollo launches?", role: "user" },
        {
          content: "",
          role: "assistant",
          tool_calls: [
            {
              function: { name: "search_chats" },
              id: "call_history",
            },
          ],
        },
        {
          content: '{"count":0,"query":"Apollo launch date","results":[]}',
          role: "tool",
          tool_call_id: "call_history",
        },
      ],
    });

    expect(response.content).toContain("October 12");
    expect(response.content).not.toContain("bun add");
  });

  test("keeps Bun web-search synthesis after narrowing history routing", () => {
    const harness = new MockLLMServerHarness();
    const response = harness.resolveResponse({
      messages: [
        {
          content:
            "Search the web for the official Bun package install command.",
          role: "user",
        },
        {
          content: "",
          role: "assistant",
          tool_calls: [
            {
              function: { name: "web_search" },
              id: "call_web",
            },
          ],
        },
        {
          content: '{"results":[]}',
          role: "tool",
          tool_call_id: "call_web",
        },
      ],
    });

    expect(response.content).toContain("bun add");
  });

  test("uses a schema-valid destructive tool call for the approval journey", () => {
    const harness = new MockLLMServerHarness();
    const response = harness.resolveResponse({
      messages: [
        {
          content: "Delete the archived Atlas export permanently.",
          role: "user",
        },
      ],
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0]?.name).toBe("delete_file");
    expect(
      deleteFileInputSchema.safeParse(response.toolCalls?.[0]?.args).success
    ).toBe(true);
  });
});

describe("release-gate chat stream parsing", () => {
  test("parses typed SSE events and ignores keepalives", () => {
    const events = parseChatStreamEvents(
      [
        ": ping",
        "",
        'data: {"type":"approval_requested","approval":{"status":"pending"}}',
        "",
        'data: {"type":"done","reply":"Waiting for approval to continue."}',
        "",
      ].join("\n")
    );

    expect(events.map((event) => event.type)).toEqual([
      "approval_requested",
      "done",
    ]);
  });

  test("rejects malformed data events instead of silently weakening the gate", () => {
    expect(() =>
      parseChatStreamEvents('data: {"reply":"missing type"}')
    ).toThrow("invalid event payload");
  });

  test("requires the exact destructive approval and rejects early execution", () => {
    const events = parseChatStreamEvents(
      [
        'data: {"type":"approval_requested","approval":{"consequenceSummary":"Target: artifacts/archived-atlas-export.zip · Affected resources: 1 · This action is irreversible.","details":{"path":"artifacts/archived-atlas-export.zip"},"status":"pending","title":"Permanently delete 1 file(s)","tool":"delete_file"}}',
        'data: {"type":"done","reply":"Waiting for approval to continue."}',
      ].join("\n\n")
    );

    expect(() => requirePendingDeleteApproval(events)).not.toThrow();
    expect(() =>
      requirePendingDeleteApproval([
        ...events,
        { tool: "delete_file", type: "tool_end" },
      ])
    ).toThrow("executed before user approval");
  });
});
