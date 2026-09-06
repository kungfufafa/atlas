import { expect, test } from "bun:test";
import type {
  ChatCompletionResult,
  GenerateChatInput,
  ProviderClient,
  ToolCall,
  ToolDefinition,
} from "@atlas/core";
import { createAgentHarness } from "./index";

function final(content = "Verified result."): ChatCompletionResult {
  return {
    assistantMessage: { content, role: "assistant" },
    content,
    toolCalls: [],
  };
}

function calls(toolCalls: ToolCall[]): ChatCompletionResult {
  return {
    assistantMessage: {
      content: "Working on it.",
      role: "assistant",
      toolCalls,
    },
    content: "Working on it.",
    toolCalls,
  };
}

function providerFrom(
  handler: (
    input: GenerateChatInput
  ) => ChatCompletionResult | Promise<ChatCompletionResult>
): ProviderClient {
  return {
    async generateChat(input) {
      return handler(input);
    },
    async generateText() {
      return { content: "unused" };
    },
    name: "openai",
    async streamChat(input, handlers) {
      const result = await handler(input);
      handlers.onChunk(result.content);
      return result;
    },
  };
}

function tool(
  run: ToolDefinition["run"],
  overrides: Partial<ToolDefinition> = {}
): ToolDefinition {
  return {
    description: "Read current job state",
    name: "status",
    parameters: { properties: {}, type: "object" },
    run,
    ...overrides,
  };
}

test.each(["send", "stream"] as const)(
  "%s keeps repeated polling when results are changing",
  async (mode) => {
    let toolCalls = 0;
    let requests = 0;
    const provider = providerFrom(() => {
      requests += 1;
      return toolCalls < 6
        ? calls([{ arguments: {}, id: `call-${requests}`, name: "status" }])
        : final("All six stages verified.");
    });
    const session = createAgentHarness({
      provider,
      tools: [tool(async () => ({ stage: ++toolCalls }))],
    }).createChatSession();
    const output =
      mode === "send"
        ? await session.send("Track the job")
        : await session.sendStream("Track the job", { onChunk: () => {} });
    expect(output).toBe("All six stages verified.");
    expect(toolCalls).toBe(6);
    expect(requests).toBe(7);
  }
);

test("identical outcomes stop with a grounded final response and a complete tool transcript", async () => {
  let toolCalls = 0;
  let requests = 0;
  const provider = providerFrom((input) => {
    requests += 1;
    if (requests > 4) {
      expect(input.tools).toBeUndefined();
      expect(
        input.messages.filter((message) => message.role === "tool")
      ).toHaveLength(4);
      return final("The job is still pending; completion is unverified.");
    }
    return calls([
      {
        arguments: requests % 2 ? { a: 1, b: 2 } : { a: 1, b: 2 },
        id: `call-${requests}`,
        name: "status",
      },
    ]);
  });
  const session = createAgentHarness({
    provider,
    tools: [
      tool(async () => {
        toolCalls += 1;
        return toolCalls % 2
          ? { done: false, stage: "pending" }
          : { done: false, stage: "pending" };
      }),
    ],
  }).createChatSession();
  expect(await session.send("Track the job")).toBe(
    "The job is still pending; completion is unverified."
  );
  expect(toolCalls).toBe(4);
  expect(requests).toBe(5);
  const history = session.getHistory();
  expect(history.at(-1)).toMatchObject({
    content: "The job is still pending; completion is unverified.",
    role: "assistant",
  });
  for (const message of history) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        expect(
          history.some(
            (result) => result.role === "tool" && result.toolCallId === call.id
          )
        ).toBe(true);
      }
    }
  }
});

test("iteration exhaustion produces one tool-free finalization instead of returning a preamble", async () => {
  let completed = 0;
  let requests = 0;
  const provider = providerFrom((input) => {
    requests += 1;
    if (!input.tools) {
      expect(completed).toBe(100);
      return final("100 steps completed; the remaining work is unfinished.");
    }
    return calls([{ arguments: {}, id: `call-${requests}`, name: "status" }]);
  });
  const session = createAgentHarness({
    provider,
    tools: [tool(async () => ({ step: ++completed }))],
  }).createChatSession();
  expect(await session.send("Long task")).toBe(
    "100 steps completed; the remaining work is unfinished."
  );
  expect(requests).toBe(101);
  expect(
    session.getHistory().filter((message) => message.role === "tool")
  ).toHaveLength(100);
});

test.each([false, true])(
  "duplicate IDs reject before executing a batch (parallel=%s)",
  async (parallelSafe) => {
    let executions = 0;
    const provider = providerFrom(() =>
      calls([
        { arguments: { one: 1 }, id: "duplicate", name: "status" },
        { arguments: { two: 2 }, id: "duplicate", name: "status" },
      ])
    );
    const session = createAgentHarness({
      provider,
      tools: [
        tool(
          async () => {
            executions += 1;
            return {};
          },
          { parallelSafe }
        ),
      ],
    }).createChatSession();
    await expect(session.send("Do two actions")).rejects.toThrow();
    expect(executions).toBe(0);
    expect(session.getHistory()).toEqual([]);
  }
);

test.each([false, true])(
  "tool failures produce failed activities without announcing saved memory (parallel=%s)",
  async (parallelSafe) => {
    let requests = 0;
    const activities: string[] = [];
    const saved: string[] = [];
    const provider = providerFrom(() =>
      ++requests === 1
        ? calls([
            { arguments: {}, id: "one", name: "update_profile_memory" },
            { arguments: {}, id: "two", name: "status" },
          ])
        : final("Both operations failed.")
    );
    const session = createAgentHarness({
      provider,
      tools: [
        tool(async () => ({ error: "Disk full" }), {
          name: "update_profile_memory",
          parallelSafe,
        }),
        tool(async () => ({ ok: false }), { parallelSafe }),
      ],
    }).createChatSession();
    await session.sendStream("Remember the result", {
      onActivityComplete: (activity) => activities.push(activity.status),
      onChunk: () => {},
      onMemorySaved: (message) => saved.push(message),
    });
    expect(activities).toEqual(["failed", "failed"]);
    expect(saved).toEqual([]);
  }
);

test("a failed model follow-up retains completed action evidence for the next turn", async () => {
  let writes = 0;
  let requests = 0;
  const provider = providerFrom((input) => {
    requests += 1;
    if (requests === 1) {
      return calls([{ arguments: {}, id: "write-1", name: "status" }]);
    }
    if (requests === 2) {
      throw new Error("Connection reset after the write");
    }
    expect(
      input.messages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "write-1" &&
          message.content.includes("receipt-1")
      )
    ).toBe(true);
    return final("The existing receipt confirms the write.");
  });
  const session = createAgentHarness({
    provider,
    tools: [
      tool(async () => {
        writes += 1;
        return { receipt: `receipt-${writes}` };
      }),
    ],
  }).createChatSession();
  await expect(session.send("Write the record")).rejects.toThrow();
  expect(session.getHistory().at(-1)).toMatchObject({
    role: "tool",
    toolCallId: "write-1",
  });
  expect(await session.send("Continue from the existing result")).toBe(
    "The existing receipt confirms the write."
  );
  expect(writes).toBe(1);
});

test.each(["empty", "unavailable-tool"])(
  "invalid terminal output is not treated as successful (%s)",
  async (failure) => {
    const provider = providerFrom(() =>
      failure === "empty"
        ? final("  ")
        : calls([{ arguments: {}, id: "call-1", name: "unavailable" }])
    );
    const session = createAgentHarness({ provider }).createChatSession();
    await expect(session.send("Complete a task")).rejects.toThrow();
    expect(session.getHistory()).toEqual([]);
  }
);

test("a long tool turn compacts before the next model request and preserves the current task and latest batch", async () => {
  const controller = new AbortController();
  const compaction = { contextWindow: 20_000, maxOutputTokens: 100 };
  const userRequest = "Inspect both records and preserve receipt IDs exactly.";
  let normalRequests = 0;
  let summaries = 0;
  const provider = providerFrom((input) => {
    expect(input.signal?.aborted).toBe(false);
    if (!input.tools) {
      summaries += 1;
      return final(
        "First record inspected; receipt-1 confirmed. Inspect the next record."
      );
    }
    normalRequests += 1;
    if (normalRequests === 1) {
      compaction.contextWindow = Math.ceil(input.system.length / 4) + 3500;
    }
    if (normalRequests <= 2) {
      const result = calls([
        { arguments: {}, id: `record-${normalRequests}`, name: "status" },
      ]);
      result.content = "Intermediate analysis. ".repeat(400);
      result.assistantMessage.content = result.content;
      return result;
    }
    expect(summaries).toBe(1);
    expect(
      input.messages.some(
        (message) => message.role === "user" && message.content === userRequest
      )
    ).toBe(true);
    expect(
      input.messages.some(
        (message) => message.role === "assistant" && message.summary
      )
    ).toBe(true);
    expect(
      input.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.toolCalls?.[0]?.id === "record-2"
      )
    ).toBe(true);
    expect(input.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "record-2",
    });
    return final("Both receipts verified.");
  });
  let receipts = 0;
  const session = createAgentHarness({
    provider,
    tools: [tool(async () => ({ receipt: `receipt-${++receipts}` }))],
  }).createChatSession({ compaction });
  expect(await session.send(userRequest, { signal: controller.signal })).toBe(
    "Both receipts verified."
  );
  expect(receipts).toBe(2);
  expect(session.getHistoryRevision()).toBeGreaterThan(0);
  const archives = session.getPendingHistoryArchives?.() ?? [];
  expect(archives).toHaveLength(1);
  expect(
    archives[0]?.messages.filter((message) => message.role === "tool")
  ).toHaveLength(2);
  expect(
    archives[0]?.messages.some(
      (message) => message.role === "assistant" && message.summary
    )
  ).toBe(false);
  session.acknowledgeHistoryArchives?.(archives.map((archive) => archive.id));
  expect(session.getPendingHistoryArchives?.()).toEqual([]);
});

test.each(["empty", "more-tools"])(
  "invalid loop finalization retains executed results and propagates failure (%s)",
  async (failure) => {
    let actions = 0;
    const provider = providerFrom((input) => {
      if (!input.tools) {
        return failure === "empty"
          ? final("")
          : calls([{ arguments: {}, id: "extra", name: "status" }]);
      }
      return calls([{ arguments: {}, id: `call-${actions}`, name: "status" }]);
    });
    const session = createAgentHarness({
      provider,
      tools: [
        tool(async () => {
          actions += 1;
          return { pending: true };
        }),
      ],
    }).createChatSession();
    await expect(session.send("Track the job")).rejects.toThrow();
    expect(actions).toBe(4);
    expect(
      session.getHistory().filter((message) => message.role === "tool")
    ).toHaveLength(4);
    expect(session.getHistory().at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-3",
    });
  }
);

test.each([false, true])(
  "disconnected tool observers cannot erase completed batch results (parallel=%s)",
  async (parallelSafe) => {
    let requests = 0;
    let executed = 0;
    const provider = providerFrom((input) => {
      if (++requests === 1) {
        return calls([
          { arguments: {}, id: "first", name: "status" },
          { arguments: {}, id: "second", name: "status" },
        ]);
      }
      expect(
        input.messages.filter((message) => message.role === "tool")
      ).toHaveLength(2);
      return final("Both receipts confirmed.");
    });
    const session = createAgentHarness({
      provider,
      tools: [tool(async () => ({ receipt: ++executed }), { parallelSafe })],
    }).createChatSession();
    const disconnected = () => {
      throw new Error("Stream closed");
    };
    expect(
      await session.sendStream("Do both actions", {
        onActivityComplete: disconnected,
        onActivityStart: disconnected,
        onChunk: () => {},
        onToolEnd: disconnected,
        onToolStart: disconnected,
      })
    ).toBe("Both receipts confirmed.");
    expect(executed).toBe(2);
    expect(
      session
        .getHistory()
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId)
    ).toEqual(["first", "second"]);
  }
);

test("a failed first request discards archives containing its rejected user message", async () => {
  let fail = true;
  let summaries = 0;
  const provider = providerFrom((input) => {
    if (!input.tools) {
      summaries += 1;
      return final("The earlier record was resolved.");
    }
    if (fail) {
      throw new Error("Model unavailable");
    }
    return final("Fresh task completed.");
  });
  const initialHistory = [
    { content: "First old record. ".repeat(700), role: "user" as const },
    final("First resolved.").assistantMessage,
    { content: "Second old record. ".repeat(300), role: "user" as const },
    final("Second resolved.").assistantMessage,
  ];
  const session = createAgentHarness({
    provider,
    tools: [tool(async () => ({}))],
  }).createChatSession({ compaction: { contextWindow: 4500 }, initialHistory });
  await expect(session.send("rejected-message-unique")).rejects.toThrow();
  expect(summaries).toBe(1);
  expect(session.getHistory()).toEqual(initialHistory);
  expect(session.getPendingHistoryArchives?.()).toEqual([]);
  fail = false;
  expect(await session.send("Fresh task")).toBe("Fresh task completed.");
  expect(JSON.stringify(session.getPendingHistoryArchives?.())).not.toContain(
    "rejected-message-unique"
  );
});

test("clear during a delayed model follow-up cannot restore executed history or overwrite a fresh turn", async () => {
  const started = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<ChatCompletionResult>();
  let requests = 0;
  let oldSignal: AbortSignal | undefined;
  const provider = providerFrom((input) => {
    requests += 1;
    if (requests === 1) {
      return calls([{ arguments: {}, id: "old-action", name: "status" }]);
    }
    if (requests === 2) {
      oldSignal = input.signal;
      started.resolve();
      return delayed.promise;
    }
    return final("Fresh answer.");
  });
  const session = createAgentHarness({
    provider,
    tools: [tool(async () => ({ receipt: "old" }))],
  }).createChatSession();
  const oldTurn = session.send("Old task").then(
    (value) => ({ error: undefined, value }),
    (error: unknown) => ({ error, value: undefined })
  );
  await started.promise;
  session.clear();
  expect(oldSignal?.aborted).toBe(true);
  expect(await session.send("Fresh task")).toBe("Fresh answer.");
  delayed.resolve(final("Late old answer."));
  expect((await oldTurn).error).toBeInstanceOf(Error);
  expect(session.getHistory()).toEqual([
    { content: "Fresh task", role: "user" },
    final("Fresh answer.").assistantMessage,
  ]);
  expect(session.getPendingHistoryArchives?.()).toEqual([]);
});
