import { expect, test } from "bun:test";
import type {
  GenerateChatInput,
  ProviderClient,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@atlas/core";
import { createAgentHarness } from "./index";
import type { ToolExecutionLifecycle } from "./tool-execution-lifecycle";
import { executeToolCall } from "./tool-loop";

for (const native of [false, true]) {
  for (const streaming of [false, true]) {
    test(`${native ? "native" : "API"} ${streaming ? "stream" : "send"} completes actual invocations before checkpoints`, async () => {
      const order: string[] = [];
      const captured: ToolExecutionResult<unknown>[] = [];
      const calls: string[] = [];
      let requests = 0;
      const tool: ToolDefinition = {
        description: "Produce a fixture output",
        name: "produce_fixture",
        parameters: { properties: {}, type: "object" },
        async run(_input, context) {
          expect(context.artifactPublisher).toBeDefined();
          expect(Object.keys(context.artifactPublisher!)).toEqual([
            "stageBytes",
          ]);
          expect("toolExecutionLifecycle" in context).toBe(false);
          order.push("effect");
          await context.artifactPublisher!.stageBytes({
            bytes: new Uint8Array([7, 8]),
            sourcePath: "artifacts/fixture.bin",
          });
          return { actual: "effect receipt" };
        },
      };
      const lifecycle: ToolExecutionLifecycle = {
        begin(call, context) {
          calls.push(call.id);
          expect(context.runId).toBeTruthy();
          return {
            async complete(result) {
              order.push("complete");
              captured.push(result);
            },
            publisher: {
              async stageBytes(input) {
                expect([...input.bytes]).toEqual([7, 8]);
                order.push("stage");
              },
            },
          };
        },
      };
      const end = () => ({
        assistantMessage: { content: "Done.", role: "assistant" as const },
        content: "Done.",
        toolCalls: [],
      });
      const call = { arguments: {}, id: "provider-call", name: tool.name };
      async function generate(input: GenerateChatInput) {
        requests += 1;
        if (native) {
          await input.executeToolCall!(call);
          return end();
        }
        if (requests > 1) {
          return end();
        }
        return {
          assistantMessage: {
            content: "",
            role: "assistant" as const,
            toolCalls: [call],
          },
          content: "",
          toolCalls: [call],
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
      const session = createAgentHarness({
        provider,
        tools: [tool],
      }).createChatSession({
        toolExecutionLifecycle: lifecycle,
      });
      const options = {
        async onToolCheckpoint() {
          order.push("checkpoint");
        },
      };
      const reply = streaming
        ? await session.sendStream(
            "Produce a fixture",
            { onChunk() {} },
            options
          )
        : await session.send("Produce a fixture", options);
      expect(reply).toBe("Done.");
      expect(calls).toEqual(["provider-call"]);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.success).toBe(true);
      expect(captured[0]?.data).toEqual({ actual: "effect receipt" });
      expect(order.slice(0, 3)).toEqual(["effect", "stage", "complete"]);
      expect(order.slice(3).length).toBeGreaterThan(0);
      expect(order.slice(3).every((item) => item === "checkpoint")).toBe(true);
    });
  }
}

test("parallel invocations receive separate publishers and no inherited capability", async () => {
  const perCall = new Map<string, number[]>();
  let inheritedCalls = 0;
  const context: ToolContext = {
    artifactPublisher: {
      async stageBytes() {
        inheritedCalls += 1;
      },
    },
  };
  const tool: ToolDefinition = {
    description: "Inspect fixture",
    name: "read_fixture",
    parallelSafe: true,
    parameters: {
      properties: { value: { type: "number" } },
      required: ["value"],
      type: "object",
    },
    async run(input, actual) {
      await actual.artifactPublisher?.stageBytes({
        bytes: new Uint8Array([(input as { value: number }).value]),
        sourcePath: "artifacts/fixture.bin",
      });
      return { ok: true };
    },
  };
  const lifecycle: ToolExecutionLifecycle = {
    begin(call) {
      const seen: number[] = [];
      perCall.set(call.id, seen);
      return {
        async complete() {},
        publisher: {
          async stageBytes(input) {
            seen.push(...input.bytes);
          },
        },
      };
    },
  };
  await Promise.all(
    [1, 2].map((value) =>
      executeToolCall(
        [tool],
        {
          arguments: { value },
          id: String(value),
          name: tool.name,
        },
        context,
        lifecycle
      )
    )
  );
  await executeToolCall(
    [tool],
    { arguments: { value: 3 }, id: "3", name: tool.name },
    context
  );
  expect([...perCall]).toEqual([
    ["1", [1]],
    ["2", [2]],
  ]);
  expect(inheritedCalls).toBe(0);
});

test("API chat parallel batches propagate the host lifecycle to each invocation", async () => {
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completed: string[] = [];
  const definition: ToolDefinition = {
    description: "Inspect fixture",
    name: "read_fixture",
    parallelSafe: true,
    parameters: { properties: {}, type: "object" },
    async run(_input, context) {
      expect(context.artifactPublisher).toBeDefined();
      entered += 1;
      if (entered === 2) {
        release();
      }
      await gate;
      return { inspected: true };
    },
  };
  let requests = 0;
  const provider: ProviderClient = {
    async generateChat() {
      requests += 1;
      const toolCalls =
        requests === 1
          ? ["first", "second"].map((id) => ({
              arguments: {},
              id,
              name: definition.name,
            }))
          : [];
      return {
        assistantMessage: { content: "Done.", role: "assistant", toolCalls },
        content: "Done.",
        toolCalls,
      };
    },
    async generateText() {
      return { content: "unused" };
    },
    name: "openai_compatible",
    async streamChat() {
      throw new Error("Unused stream path");
    },
  };
  const session = createAgentHarness({
    provider,
    tools: [definition],
  }).createChatSession({
    toolExecutionLifecycle: {
      begin(call) {
        return {
          async complete() {
            completed.push(call.id);
          },
          publisher: { async stageBytes() {} },
        };
      },
    },
  });
  await session.send("Inspect both");
  expect(entered).toBe(2);
  expect(completed.sort()).toEqual(["first", "second"]);
});

test("publication completion sees protected rejection and failed data without bypassing guards", async () => {
  let effects = 0;
  const captured: ToolExecutionResult<unknown>[] = [];
  const tool: ToolDefinition = {
    description: "Fixture",
    name: "produce_fixture",
    parameters: { properties: {}, type: "object" },
    async run() {
      effects += 1;
      return { ok: false, success: true };
    },
  };
  const lifecycle: ToolExecutionLifecycle = {
    begin() {
      return {
        async complete(result) {
          captured.push(result);
        },
      };
    },
  };
  await executeToolCall(
    [tool],
    { arguments: {}, id: "blocked", name: tool.name },
    {
      async beforeToolCall() {
        throw new Error("Current access revoked");
      },
    },
    lifecycle
  );
  await executeToolCall(
    [tool],
    { arguments: {}, id: "failed-data", name: tool.name },
    {},
    lifecycle
  );
  expect(effects).toBe(1);
  expect(captured[0]?.success).toBe(false);
  expect(captured[1]?.success).toBe(true);
  expect(captured[1]?.data).toEqual({ ok: false, success: true });
});

for (const phase of ["begin", "complete"] as const) {
  test(`${phase} and diagnostic failures preserve the actual effect exactly once`, async () => {
    let effects = 0;
    const errors: string[] = [];
    const tool: ToolDefinition = {
      description: "Fixture",
      name: "produce_fixture",
      parameters: { properties: {}, type: "object" },
      async run() {
        effects += 1;
        return { receipt: "saved" };
      },
    };
    const result = await executeToolCall(
      [tool],
      { arguments: {}, id: "one", name: tool.name },
      {},
      {
        begin() {
          if (phase === "begin") {
            throw new Error("setup failed");
          }
          return {
            async complete() {
              throw new Error("publication failed");
            },
          };
        },
        onError(_error, actualPhase) {
          errors.push(actualPhase);
          return Promise.reject(new Error("diagnostic failed"));
        },
      }
    );
    expect(result).toEqual({ receipt: "saved" });
    expect(effects).toBe(1);
    expect(errors).toEqual([phase]);
  });
}
