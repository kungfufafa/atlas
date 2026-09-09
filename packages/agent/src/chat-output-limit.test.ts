import { expect, test } from "bun:test";
import {
  type ChatCompletionResult,
  type GenerateChatInput,
  IncompleteCompletionError,
  type ProviderClient,
  type ToolDefinition,
} from "@atlas/core";
import { createAgentHarness } from "./index";

const usage = { inputTokens: 7, outputTokens: 11, totalTokens: 18 };
function limited(content = "") {
  return new IncompleteCompletionError("Fixture", {
    content,
    thinking: "unfinished reasoning",
    toolInputFragments: [
      { arguments: '{"value":', id: "partial", name: "write" },
    ],
    usage,
  });
}
function final(): ChatCompletionResult {
  return {
    assistantMessage: { content: "done", role: "assistant" },
    content: "done",
    toolCalls: [],
    usage,
  };
}
function call(id: string): ChatCompletionResult {
  const toolCalls = [{ arguments: { value: 1 }, id, name: "write" }];
  return {
    assistantMessage: { content: "", role: "assistant", toolCalls },
    content: "",
    toolCalls,
    usage,
  };
}
function providerFrom(
  run: (
    input: GenerateChatInput
  ) => Promise<ChatCompletionResult> | ChatCompletionResult
): ProviderClient {
  return {
    async generateChat(input) {
      return await run(input);
    },
    async generateText() {
      return { content: "unused" };
    },
    name: "openai_compatible",
    async streamChat(input, handlers) {
      const result = await run(input);
      handlers.onChunk(result.content);
      return result;
    },
  };
}
function writeTool(run: ToolDefinition["run"]): ToolDefinition {
  return {
    description: "Write a value",
    name: "write",
    parameters: {
      properties: { value: { type: "number" } },
      required: ["value"],
      type: "object",
    },
    run,
  };
}

test.each(["send", "stream"] as const)(
  "%s recovers once from completed receipts without executing partial calls",
  async (mode) => {
    const inputs: GenerateChatInput[] = [];
    let writes = 0;
    const failure = limited();
    const observed: IncompleteCompletionError[] = [];
    const charged: unknown[] = [];
    const provider = providerFrom((input) => {
      inputs.push(
        structuredClone({
          ...input,
          executeToolCall: undefined,
          signal: undefined,
        })
      );
      if (inputs.length === 1) {
        return call("completed");
      }
      if (inputs.length === 2) {
        throw failure;
      }
      return final();
    });
    const session = createAgentHarness({
      provider,
      tools: [writeTool(async () => ({ writes: ++writes }))],
    }).createChatSession({
      toolContext: { recordTurnUsage: (event) => charged.push(event) },
    });
    const options = {
      onIncompleteCompletion: (error: IncompleteCompletionError) =>
        observed.push(error),
    };
    const output =
      mode === "send"
        ? await session.send("Write once, then confirm", options)
        : await session.sendStream(
            "Write once, then confirm",
            { onChunk: () => {} },
            options
          );
    expect(output).toBe("done");
    expect(writes).toBe(1);
    expect(inputs).toHaveLength(3);
    expect(inputs[2]?.messages).toEqual(inputs[1]?.messages);
    expect(inputs[2]?.tools).toEqual(inputs[1]?.tools);
    expect(inputs[2]?.providerOptions).toEqual(inputs[1]?.providerOptions);
    expect(inputs[2]?.system).not.toBe(inputs[1]?.system);
    expect(JSON.stringify(inputs[2]?.messages)).not.toContain(
      "unfinished reasoning"
    );
    expect(JSON.stringify(session.getHistory())).not.toContain("partial");
    expect(observed).toEqual([failure]);
    expect(charged).toHaveLength(3);
    expect(charged).toEqual(
      Array.from({ length: 3 }, () => ({
        estimated: false,
        inputTokens: 7,
        optimized: false,
        outputTokens: 11,
      }))
    );
  }
);

test("a second output limit fails and retains both attempt diagnostics", async () => {
  let calls = 0;
  const observed: IncompleteCompletionError[] = [];
  const session = createAgentHarness({
    provider: providerFrom(() => {
      calls++;
      throw limited("partial final");
    }),
  }).createChatSession();
  await expect(
    session.send("Answer", { onIncompleteCompletion: (e) => observed.push(e) })
  ).rejects.toBeInstanceOf(IncompleteCompletionError);
  expect(calls).toBe(2);
  expect(observed).toHaveLength(2);
  expect(session.getHistory()).toHaveLength(0);
});

test.each(["content_filter", "context limit", "network length timeout"])(
  "does not retry ordinary %s failures",
  async (message) => {
    let calls = 0;
    const failure = new Error(message);
    const session = createAgentHarness({
      provider: providerFrom(() => {
        calls++;
        throw failure;
      }),
    }).createChatSession();
    await expect(session.send("Answer")).rejects.toBe(failure);
    expect(calls).toBe(1);
  }
);

test.each(["abort", "clear"] as const)(
  "%s during incomplete evidence observation prevents another generation",
  async (action) => {
    const abort = new AbortController();
    let calls = 0;
    const session = createAgentHarness({
      provider: providerFrom(() => {
        calls++;
        throw limited();
      }),
    }).createChatSession();
    await expect(
      session.send("Answer", {
        onIncompleteCompletion() {
          if (action === "abort") {
            abort.abort();
          } else {
            session.clear();
          }
        },
        signal: abort.signal,
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(session.getHistory()).toHaveLength(0);
  }
);

test("runtime managed context prevents retries even without a tool call", async () => {
  let calls = 0;
  const provider = providerFrom(() => {
    calls++;
    throw limited();
  });
  provider.managesContext = true;
  const session = createAgentHarness({ provider }).createChatSession();
  await expect(session.send("Answer")).rejects.toBeInstanceOf(
    IncompleteCompletionError
  );
  expect(calls).toBe(1);
});

test("a native dispatched effect is checkpointed and never retried after truncation", async () => {
  let calls = 0;
  let writes = 0;
  let checkpoints = 0;
  const provider = providerFrom(async (input) => {
    calls++;
    await input.executeToolCall?.({
      arguments: { value: 1 },
      id: "native-write",
      name: "write",
    });
    throw limited();
  });
  const session = createAgentHarness({
    provider,
    tools: [writeTool(async () => ({ writes: ++writes }))],
  }).createChatSession();
  await expect(
    session.send("Write once", {
      onToolCheckpoint: async () => {
        checkpoints++;
      },
    })
  ).rejects.toBeInstanceOf(IncompleteCompletionError);
  expect(calls).toBe(1);
  expect(writes).toBe(1);
  expect(checkpoints).toBe(1);
  expect(session.getHistory().filter((m) => m.role === "tool")).toHaveLength(1);
});

test("visible streamed final text cannot be silently replaced even if error evidence omits it", async () => {
  let calls = 0;
  let text = "";
  const provider = providerFrom(() => final());
  provider.streamChat = async (_input, handlers) => {
    calls++;
    handlers.onChunk("partial final");
    throw limited();
  };
  const session = createAgentHarness({ provider }).createChatSession();
  await expect(
    session.sendStream("Answer", {
      onChunk: (delta) => {
        text += delta;
      },
    })
  ).rejects.toBeInstanceOf(IncompleteCompletionError);
  expect(calls).toBe(1);
  expect(text).toBe("partial final");
  expect(session.getHistory()).toHaveLength(0);
});

test("a failed completed tool result is retained across bounded recovery", async () => {
  let requests = 0;
  let writes = 0;
  const inputs: GenerateChatInput[] = [];
  const session = createAgentHarness({
    provider: providerFrom((input) => {
      inputs.push(input);
      requests++;
      if (requests === 1) {
        return call("failed-write");
      }
      if (requests === 2) {
        throw limited();
      }
      return final();
    }),
    tools: [
      writeTool(async () => {
        writes++;
        return { error: "disk full" };
      }),
    ],
  }).createChatSession();
  expect(await session.send("Write once")).toBe("done");
  expect(writes).toBe(1);
  expect(inputs[2]?.messages.filter((m) => m.role === "tool")).toMatchObject([
    { content: '{"error":"disk full"}' },
  ]);
});

test("tool-free finalization shares the same one-retry budget", async () => {
  let requests = 0;
  let tools = 0;
  const session = createAgentHarness({
    provider: providerFrom((input) => {
      requests++;
      if (requests === 1 || !input.tools?.length) {
        throw limited();
      }
      return call(`call-${requests}`);
    }),
    tools: [
      writeTool(async () => {
        tools++;
        return { pending: true };
      }),
    ],
  }).createChatSession();
  await expect(session.send("Track changes")).rejects.toBeInstanceOf(
    IncompleteCompletionError
  );
  expect(tools).toBe(4);
  expect(requests).toBe(6);
});

test("tool-free finalization can recover once when the retry budget is unused", async () => {
  let finalRequests = 0;
  let toolRequests = 0;
  const session = createAgentHarness({
    provider: providerFrom((input) => {
      if (input.tools?.length) {
        return call(`call-${++toolRequests}`);
      }
      if (++finalRequests === 1) {
        throw limited();
      }
      return final();
    }),
    tools: [writeTool(async () => ({ pending: true }))],
  }).createChatSession();
  expect(await session.send("Track changes")).toBe("done");
  expect(toolRequests).toBe(4);
  expect(finalRequests).toBe(2);
});

test("a visible streamed tool draft is not left orphaned by an automatic retry", async () => {
  let calls = 0;
  const drafts: unknown[] = [];
  const provider = providerFrom(() => final());
  provider.streamChat = async (_input, handlers) => {
    calls++;
    handlers.onToolInputDelta?.({
      accumulatedArguments: '{"value":',
      delta: '{"value":',
      tool: "write",
      toolCallId: "partial",
    });
    throw limited();
  };
  const session = createAgentHarness({
    provider,
    tools: [
      writeTool(async () => {
        throw new Error("must not execute");
      }),
    ],
  }).createChatSession();
  await expect(
    session.sendStream("Write once", {
      onChunk: () => {},
      onToolInputDelta: (draft) => drafts.push(draft),
    })
  ).rejects.toBeInstanceOf(IncompleteCompletionError);
  expect(calls).toBe(1);
  expect(drafts).toHaveLength(1);
  expect(session.getHistory()).toHaveLength(0);
});

test("an output limit followed by a transport failure retains usage but cannot retry", async () => {
  let calls = 0;
  const recorded: unknown[] = [];
  const cause = new Error("socket closed");
  const failure = new IncompleteCompletionError("Fixture", limited().evidence, {
    cause,
    recoveryAllowed: false,
  });
  const session = createAgentHarness({
    provider: providerFrom(() => {
      calls++;
      throw failure;
    }),
  }).createChatSession({
    toolContext: { recordTurnUsage: (event) => recorded.push(event) },
  });
  await expect(session.send("Answer")).rejects.toBe(failure);
  expect(calls).toBe(1);
  expect(recorded).toHaveLength(1);
  expect(failure.cause).toBe(cause);
});

test("a native callback failure takes precedence without discarding the failed model attempt's usage", async () => {
  let requests = 0;
  let writes = 0;
  const recorded: unknown[] = [];
  const observed: IncompleteCompletionError[] = [];
  const failure = limited();
  const provider = providerFrom(async (input) => {
    requests++;
    await input.executeToolCall?.({
      arguments: { value: 1 },
      id: "done",
      name: "write",
    });
    try {
      await input.executeToolCall?.({
        arguments: { value: 2 },
        id: "done",
        name: "write",
      });
    } catch {
      // Native runtimes may wrap a tool bridge failure as a provider failure.
    }
    throw failure;
  });
  const session = createAgentHarness({
    provider,
    tools: [writeTool(async () => ({ writes: ++writes }))],
  }).createChatSession({
    toolContext: { recordTurnUsage: (event) => recorded.push(event) },
  });
  let rejected: unknown;
  try {
    await session.send("Write", {
      onIncompleteCompletion: (error) => observed.push(error),
    });
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(Error);
  expect(rejected).not.toBe(failure);
  expect(requests).toBe(1);
  expect(writes).toBe(1);
  expect(recorded).toHaveLength(1);
  expect(observed).toEqual([failure]);
  expect(session.getHistory().filter((m) => m.role === "tool")).toHaveLength(1);
});

test("a tool-free finalization that emits an unexpected tool draft also cannot retry", async () => {
  let toolRequests = 0;
  let finalRequests = 0;
  const drafts: unknown[] = [];
  const provider = providerFrom(() => final());
  provider.streamChat = async (input, handlers) => {
    if (input.tools?.length) {
      return call(`call-${++toolRequests}`);
    }
    finalRequests++;
    handlers.onToolInputDelta?.({
      delta: '{"value":',
      tool: "write",
      toolCallId: "invalid-final-draft",
    });
    throw limited();
  };
  const session = createAgentHarness({
    provider,
    tools: [writeTool(async () => ({ pending: true }))],
  }).createChatSession();
  await expect(
    session.sendStream("Track changes", {
      onChunk: () => {},
      onToolInputDelta: (event) => drafts.push(event),
    })
  ).rejects.toBeInstanceOf(IncompleteCompletionError);
  expect(toolRequests).toBe(4);
  expect(finalRequests).toBe(1);
  expect(drafts).toHaveLength(1);
});
