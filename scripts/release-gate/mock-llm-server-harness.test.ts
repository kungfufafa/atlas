import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteFileInputSchema } from "../../packages/core/src/tools/builtin";
import { officeDocumentInputSchema } from "../../packages/core/src/tools/office-document";
import { spreadsheetTool } from "../../packages/core/src/tools/spreadsheet";
import { writePptxInputSchema } from "../../packages/core/src/tools/write-pptx";
import { MockLLMServerHarness } from "./mock-llm-server-harness";
import {
  parseChatStreamEvents,
  requirePendingDeleteApproval,
} from "./suites/golden-journeys-suite";

describe("release-gate mock response routing", () => {
  test("current-run Office fixtures invoke schema-valid real tools", async () => {
    const harness = new MockLLMServerHarness();
    const runId = "123e4567-e89b-12d3-a456-426614174000";
    const prompts = [
      "Make a presentation about Atlas.",
      "Turn that research into a board-ready 8-slide presentation.",
      "Make slide 4 more visual and cut the text by half.",
      "Create a financial model from these assumptions.",
      "Add a downside case.",
      "Research our competitors and build a spreadsheet plus presentation.",
      'Inspect the uploaded Office fixture. Original file reference: {"documentRef":"att_original"}',
    ];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "atlas-gate-fixture-"));
    try {
      for (const prompt of prompts) {
        const response = harness.resolveResponse({
          messages: [
            { content: `${prompt}\nrelease-gate-run: ${runId}`, role: "user" },
          ],
        });
        expect(response.toolCalls?.length).toBeGreaterThan(0);
        for (const call of response.toolCalls ?? []) {
          if (call.name === "write_pptx") {
            expect(writePptxInputSchema.safeParse(call.args).success).toBe(
              true
            );
          } else if (call.name === "office_document") {
            expect(officeDocumentInputSchema.safeParse(call.args).success).toBe(
              true
            );
          } else {
            const result = await spreadsheetTool.run(call.args, {
              workspaceRoot,
            });
            expect(result).toHaveProperty("path");
          }
        }
      }
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  test("cancellation fixture stays active and missing upload cannot claim a read", () => {
    const harness = new MockLLMServerHarness();
    const suffix = "\nrelease-gate-run: 123e4567-e89b-12d3-a456-426614174000";
    expect(
      harness.resolveResponse({
        messages: [{ content: `Start long research${suffix}`, role: "user" }],
      }).delayMs
    ).toBeGreaterThan(10_000);
    expect(
      harness.resolveResponse({
        messages: [
          {
            content: `Inspect the uploaded Office fixture${suffix}`,
            role: "user",
          },
        ],
      }).toolCalls
    ).toBeUndefined();
    expect(
      harness.resolveResponse({
        messages: [
          {
            content: `For future presentations, keep them concise and executive-friendly.${suffix}`,
            role: "user",
          },
        ],
      }).toolCalls?.[0]?.name
    ).toBe("memory_write");
  });

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

    expect(response.content).not.toContain("October 12");
    expect(response.content).not.toContain("bun add");
  });

  test("history and memory replies derive only from retrieved content", () => {
    const harness = new MockLLMServerHarness();
    for (const [name, result, expected] of [
      [
        "search_chats",
        { results: [{ matchedSnippet: "Apollo launches June 7." }] },
        "June 7",
      ],
      [
        "memory_search",
        { memories: [{ content: "Use concrete code examples." }] },
        "concrete code examples",
      ],
    ] as const) {
      const response = harness.resolveResponse({
        messages: [
          {
            content:
              "When did I say Apollo launches? How should you present technical explanations?",
            role: "user",
          },
          { content: JSON.stringify(result), name, role: "tool" },
        ],
      });
      expect(response.content).toContain(expected);
      expect(response.content).not.toContain("October 12");
    }
    const empty = harness.resolveResponse({
      messages: [
        {
          content: "How should you present technical explanations?",
          role: "user",
        },
        {
          content: '{"count":0,"memories":[]}',
          name: "memory_search",
          role: "tool",
        },
      ],
    });
    expect(empty.content).not.toContain("executive-friendly");
    expect(
      harness.resolveResponse({
        messages: [
          {
            content: "How should you present technical explanations?",
            role: "user",
          },
        ],
      }).toolCalls?.[0]?.name
    ).toBe("memory_search");
  });

  test("recovery requests actual sequential fetches and cannot invent a successful result", () => {
    const harness = new MockLLMServerHarness();
    const prompt =
      "Fetch broken-source.atlas-gate.test\nrelease-gate-run: 123e4567-e89b-12d3-a456-426614174000";
    const initial = harness.resolveResponse({
      messages: [{ content: prompt, role: "user" }],
    });
    expect(initial.toolCalls?.[0]?.name).toBe("web_fetch");
    expect(initial.content).toBeUndefined();
    const afterFailure = harness.resolveResponse({
      messages: [
        { content: prompt, role: "user" },
        {
          content: '{"error":"web_fetch failed: HTTP 503"}',
          name: "web_fetch",
          role: "tool",
        },
      ],
    });
    expect(afterFailure.toolCalls?.[0]?.args.url).toContain(
      "alternative-source"
    );
    expect(afterFailure.content).toBeUndefined();
    const empty = harness.resolveResponse({
      messages: [
        { content: prompt, role: "user" },
        { content: "{}", name: "web_fetch", role: "tool" },
      ],
    });
    expect(empty.content).not.toContain("Recovered fixture data");
  });

  test("keeps Bun response fixture after narrowing history routing (not web-search evidence)", () => {
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
