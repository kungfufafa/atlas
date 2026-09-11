import { expect, test } from "bun:test";
import type {
  GenerateChatInput,
  ProviderClient,
  ToolDefinition,
} from "@atlas/core";
import { createAgentHarness } from "./index";

type StopFixtureKind =
  | "stall"
  | "iterate"
  | "invalid-input"
  | "native-stop"
  | "native-invalid-stop"
  | "native-natural"
  | "native-limit";

function fixture(kind: StopFixtureKind) {
  let requests = 0;
  let effects = 0;
  let ordinary = false;
  let finalError: Error | undefined;
  const invalidInput =
    kind === "invalid-input" || kind === "native-invalid-stop";
  const finalText = "Observed results are saved; remaining work is unfinished.";
  const tool: ToolDefinition = {
    description: "Inspect current state",
    name: "read_state",
    parameters: {
      properties: { value: { type: "integer" } },
      type: "object",
    },
    async run() {
      effects += 1;
      return {
        step: kind === "iterate" || kind === "native-limit" ? effects : 0,
      };
    },
  };
  async function generate(input: GenerateChatInput) {
    requests += 1;
    const end = () => ({
      assistantMessage: { content: finalText, role: "assistant" as const },
      content: finalText,
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    if (ordinary) {
      return end();
    }
    if (!input.tools) {
      if (finalError) {
        throw finalError;
      }
      return end();
    }
    if (kind.startsWith("native")) {
      for (
        let index = 0;
        index <
        (kind === "native-limit"
          ? 101
          : kind === "native-stop" || kind === "native-invalid-stop"
            ? 5
            : 4);
        index += 1
      ) {
        await input.executeToolCall!({
          arguments: invalidInput ? { value: String(index) } : {},
          id: "native-" + index,
          name: "read_state",
        });
      }
      return end();
    }
    const toolCalls = [
      {
        arguments: invalidInput ? { value: String(requests) } : {},
        id: "call-" + requests,
        name: "read_state",
      },
    ];
    return {
      assistantMessage: {
        content: "Inspecting.",
        role: "assistant" as const,
        toolCalls,
      },
      content: "Inspecting.",
      toolCalls,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    };
  }
  const provider: ProviderClient = {
    generateChat: generate,
    async generateText() {
      return { content: "unused" };
    },
    name: "openai_compatible",
    async streamChat(input, handlers) {
      const result = await generate(input);
      handlers.onChunk(result.content);
      return result;
    },
  };
  const usages: unknown[] = [];
  const endings: string[] = [];
  const session = createAgentHarness({
    provider,
    tools: [tool],
  }).createChatSession({
    toolContext: {
      async onToolTurnEnd(_id, status) {
        endings.push(status);
      },
      recordTurnUsage: (usage) => usages.push(usage),
      runId: "test-run",
    },
  });
  return {
    counts: () => ({ effects, requests }),
    endings,
    failFinal: (error: Error) => {
      finalError = error;
    },
    finalText,
    session,
    succeed: () => {
      ordinary = true;
    },
    usages,
  };
}

test.each(["send", "stream"] as const)(
  "%s preserves strings/history and reports one typed stop only for that invocation",
  async (mode) => {
    const f = fixture("stall");
    const reasons: string[] = [];
    const chunks: string[] = [];
    const options = {
      onToolLoopStop: (reason: string) => {
        reasons.push(reason);
      },
    };
    const output =
      mode === "send"
        ? await f.session.send("Observe", options)
        : await f.session.sendStream(
            "Observe",
            { onChunk: (chunk) => chunks.push(chunk) },
            options
          );
    expect(output).toBe(f.finalText);
    expect(reasons).toEqual(["no_progress"]);
    expect(f.counts()).toEqual({ effects: 4, requests: 5 });
    expect(
      f.session.getHistory().filter((m) => m.role === "tool")
    ).toHaveLength(4);
    expect(f.session.getHistory().at(-1)?.content).toBe(f.finalText);
    expect(f.usages).toHaveLength(5);
    expect(f.endings).toEqual(["completed"]);
    if (mode === "stream") {
      expect(chunks.join("")).toContain(f.finalText);
    }
    f.succeed();
    const next: string[] = [];
    expect(
      await f.session.send("Next invocation", {
        onToolLoopStop: (reason) => {
          next.push(reason);
        },
      })
    ).toBe(f.finalText);
    expect(next).toEqual([]);
  }
);

test("iteration limit has a distinct typed reason without additional generation", async () => {
  const f = fixture("iterate");
  const reasons: string[] = [];
  expect(
    await f.session.send("Work", {
      onToolLoopStop: (reason) => {
        reasons.push(reason);
      },
    })
  ).toBe(f.finalText);
  expect(reasons).toEqual(["iteration_limit"]);
  expect(f.counts()).toEqual({ effects: 100, requests: 101 });
  expect(f.usages).toHaveLength(101);
});

test.each(["invalid-input", "native-invalid-stop"] as const)(
  "%s finalizes after changing inputs are repeatedly rejected",
  async (kind) => {
    const f = fixture(kind);
    const reasons: string[] = [];
    expect(
      await f.session.send("Work", {
        onToolLoopStop: (reason) => {
          reasons.push(reason);
        },
      })
    ).toBe(f.finalText);
    expect(reasons).toEqual(["no_progress"]);
    expect(f.counts()).toEqual({
      effects: 0,
      requests: kind === "invalid-input" ? 5 : 2,
    });
    const failures = f.session.getHistory().filter((m) => m.role === "tool");
    expect(failures).toHaveLength(4);
    for (const failure of failures) {
      expect(JSON.parse(failure.content)).toMatchObject({
        errorCode: "INVALID_ARGUMENT",
      });
    }
    expect(f.session.getHistory().at(-1)?.content).toBe(f.finalText);
  }
);

test.each(["native-stop", "native-natural", "native-limit"] as const)(
  "%s distinguishes rejected additional dispatch from a natural finish",
  async (kind) => {
    const f = fixture(kind);
    const reasons: string[] = [];
    expect(
      await f.session.send("Work", {
        onToolLoopStop: (reason) => {
          reasons.push(reason);
        },
      })
    ).toBe(f.finalText);
    expect(reasons).toEqual(
      kind === "native-limit"
        ? ["iteration_limit"]
        : kind === "native-stop"
          ? ["no_progress"]
          : []
    );
    expect(f.counts()).toEqual({
      effects: kind === "native-limit" ? 100 : 4,
      requests: kind === "native-natural" ? 1 : 2,
    });
    expect(
      f.session.getHistory().filter((m) => m.role === "tool")
    ).toHaveLength(kind === "native-limit" ? 100 : 4);
  }
);

test.each([false, true])(
  "observer failure does not replace final output, usage or cleanup (async=%s)",
  async (asyncFailure) => {
    const f = fixture("stall");
    const error = new Error("Observer disconnected");
    let observed = 0;
    expect(
      await f.session.send("Observe", {
        onToolLoopStop: () => {
          observed += 1;
          if (asyncFailure) {
            return Promise.reject(error);
          }
          throw error;
        },
      })
    ).toBe(f.finalText);
    await Promise.resolve();
    expect(observed).toBe(1);
    expect(f.usages).toHaveLength(5);
    expect(f.endings).toEqual(["completed"]);
  }
);

test.each(["send", "stream"] as const)(
  "%s failed finalization retains original error and completed effects",
  async (mode) => {
    const f = fixture("stall");
    const error = new Error("Final provider failed");
    f.failFinal(error);
    const reasons: string[] = [];
    const chunks: string[] = [];
    const options = {
      onToolLoopStop: (reason: string) => {
        reasons.push(reason);
      },
    };
    const run =
      mode === "send"
        ? f.session.send("Observe", options)
        : f.session.sendStream(
            "Observe",
            { onChunk: (chunk) => chunks.push(chunk) },
            options
          );
    await expect(run).rejects.toBe(error);
    if (mode === "stream") {
      expect(chunks).toHaveLength(4);
      expect(chunks).not.toContain(f.finalText);
    }
    expect(reasons).toEqual(["no_progress"]);
    expect(f.session.getHistory().at(-1)?.role).toBe("tool");
    expect(f.counts()).toEqual({ effects: 4, requests: 5 });
    expect(f.usages).toHaveLength(4);
    expect(f.endings).toEqual(["failed"]);
  }
);

test.each(["send", "stream"] as const)(
  "%s cancellation after stop prevents finalization and retains tool evidence",
  async (mode) => {
    const f = fixture("stall");
    const controller = new AbortController();
    const error = new Error("Cancelled by owner");
    const chunks: string[] = [];
    const options = {
      onToolLoopStop: () => controller.abort(error),
      signal: controller.signal,
    };
    const run =
      mode === "send"
        ? f.session.send("Observe", options)
        : f.session.sendStream(
            "Observe",
            { onChunk: (chunk) => chunks.push(chunk) },
            options
          );
    await expect(run).rejects.toBe(error);
    if (mode === "stream") {
      expect(chunks).toHaveLength(4);
    }
    expect(f.counts()).toEqual({ effects: 4, requests: 4 });
    expect(f.session.getHistory().at(-1)?.role).toBe("tool");
    expect(f.usages).toHaveLength(4);
    expect(f.endings).toEqual(["cancelled"]);
  }
);

test.each([
  [false, 1],
  [true, 1],
  [false, 30],
] as const)(
  "formatting revision budget bounds real dispatch (native=%s, calls per response=%s)",
  async (native, callsPerResponse) => {
    let effects = 0;
    const reasons: string[] = [];
    const tool: ToolDefinition = {
      description: "Edit workbook",
      name: "spreadsheet",
      parameters: { type: "object" },
      async run() {
        effects += 1;
        return {
          path: `assets-v${effects + 1}.xlsx`,
          sourcePath: `assets-v${effects}.xlsx`,
          status: "formatted",
        };
      },
    };
    const generate = async (input: GenerateChatInput) => {
      const end = {
        assistantMessage: {
          content: "Latest workbook saved; further styling is unfinished.",
          role: "assistant" as const,
        },
        content: "Latest workbook saved; further styling is unfinished.",
        toolCalls: [],
      };
      if (!input.tools) {
        return end;
      }
      const call = () => ({
        arguments: { action: "format_range", range: `A${effects + 1}` },
        id: `format-${effects}`,
        name: "spreadsheet",
      });
      if (native) {
        for (let index = 0; index < 49; index += 1) {
          await input.executeToolCall!(call());
        }
        return end;
      }
      const toolCalls = Array.from(
        { length: callsPerResponse },
        (_, index) => ({ ...call(), id: `format-${effects}-${index}` })
      );
      return {
        assistantMessage: {
          content: "",
          role: "assistant" as const,
          toolCalls,
        },
        content: "",
        toolCalls,
      };
    };
    const provider: ProviderClient = {
      generateChat: generate,
      async generateText() {
        return { content: "" };
      },
      name: "openai",
      async streamChat(input) {
        return await generate(input);
      },
    };
    const session = createAgentHarness({
      provider,
      tools: [tool],
    }).createChatSession({ tools: [tool] });
    await session.send("Format the report", {
      onToolLoopStop: (reason) => {
        reasons.push(reason);
      },
    });
    expect(effects).toBe(8);
    expect(reasons).toEqual(["iteration_limit"]);
    const receipts = session
      .getHistory()
      .filter((message) => message.role === "tool");
    expect(receipts).toHaveLength(callsPerResponse === 30 ? 30 : 8);
    expect(JSON.parse(receipts[7]!.content).path).toBe("assets-v9.xlsx");
    for (const skipped of receipts.slice(8)) {
      expect(JSON.parse(skipped.content).errorCode).toBe(
        "TOOL_ITERATION_LIMIT"
      );
    }
  }
);
