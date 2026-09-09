import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  computeActionHash,
  type GenerateChatInput,
  globalApprovalGrantStore,
  type ProviderClient,
  type ToolApprovalDecision,
  type ToolDefinition,
} from "@atlas/core";
import { createAgentHarness } from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function provider(
  run: (input: GenerateChatInput) => Promise<string>
): ProviderClient {
  return {
    async generateChat(input) {
      const content = await run(input);
      return {
        assistantMessage: { content, role: "assistant" },
        content,
        toolCalls: [],
      };
    },
    async generateText() {
      return { content: "unused" };
    },
    name: "chatgpt",
    async streamChat(input, handlers) {
      const content = await run(input);
      handlers.onChunk(content);
      return {
        assistantMessage: { content, role: "assistant" },
        content,
        toolCalls: [],
      };
    },
  };
}

function tool(run: ToolDefinition["run"], name = "read_data"): ToolDefinition {
  return {
    description: "Inspect the test workspace",
    name,
    parameters: { type: "object" },
    run,
  };
}

test.each(["approved", "denied"] as const)(
  "runtime tools share Atlas history and await %s before a filesystem effect",
  async (decision) => {
    const workspace = await mkdtemp("/tmp/atlas-runtime-tools-");
    const path = join(workspace, "obsolete.txt");
    await writeFile(path, "old draft");
    const pending = deferred<void>();
    const response = deferred<ToolApprovalDecision>();
    let mutations = 0;
    let checkpointCount = 0;
    const session = createAgentHarness({
      provider: provider(async (input) => {
        const execute = input.executeToolCall!;
        const read = await execute({
          arguments: { path },
          id: "read",
          name: "read_data",
        });
        expect(JSON.parse(read.content)).toEqual({ text: "old draft" });
        expect(checkpointCount).toBe(1);
        const removed = await execute({
          arguments: { path },
          id: "remove",
          name: "delete_file",
        });
        expect(removed.success).toBe(decision === "approved");
        expect(checkpointCount).toBe(2);
        const verify = await execute({
          arguments: { path },
          id: "verify",
          name: "verify_file",
        });
        return JSON.parse(verify.content).exists
          ? "Kept the draft."
          : "Verified removal.";
      }),
      tools: [
        tool(async () => ({ text: await readFile(path, "utf8") })),
        tool(async () => {
          mutations += 1;
          await rm(path);
          return { removed: true };
        }, "delete_file"),
        tool(
          async () => ({ exists: await Bun.file(path).exists() }),
          "verify_file"
        ),
      ],
    }).createChatSession({
      toolContext: {
        orgId: "org-runtime",
        async requestToolApproval(request, onPending) {
          onPending();
          pending.resolve();
          const answer = await response.promise;
          if (answer.decision === "denied") {
            return answer;
          }
          const grant = globalApprovalGrantStore.createGrant({
            actionHash: computeActionHash({
              args: request.call.arguments,
              tool: request.call.name,
            }),
            executionId: request.runId,
            orgId: "org-runtime",
            sessionId: "session-runtime",
            userId: "user-runtime",
          });
          return { decision: "approved", grantId: grant.id };
        },
        sessionId: "session-runtime",
        userId: "user-runtime",
        workspaceRoot: workspace,
      },
    });
    try {
      const reply = session.sendStream(
        "Inspect, remove after approval, and verify.",
        { onChunk: () => {} },
        {
          onToolCheckpoint: async () => {
            checkpointCount += 1;
          },
        }
      );
      await pending.promise;
      expect(mutations).toBe(0);
      expect(await Bun.file(path).exists()).toBe(true);
      response.resolve(
        decision === "approved"
          ? { decision, grantId: "issued-by-callback" }
          : { decision }
      );
      expect(await reply).toBe(
        decision === "approved" ? "Verified removal." : "Kept the draft."
      );
      expect(mutations).toBe(decision === "approved" ? 1 : 0);
      expect(checkpointCount).toBe(3);
      const history = session.getHistory();
      expect(
        history
          .filter((message) => message.role === "tool")
          .map((message) => message.toolCallId)
      ).toEqual(["read", "remove", "verify"]);
      expect(
        history.filter(
          (message) => message.role === "assistant" && message.toolCalls?.length
        )
      ).toHaveLength(3);
      expect(
        history.find(
          (message) => message.role === "assistant" && message.approval
        )?.role
      ).toBe("assistant");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }
);

test("duplicate runtime call IDs share one execution and one history pair", async () => {
  let effects = 0;
  const session = createAgentHarness({
    provider: provider(async (input) => {
      const call = { arguments: { a: 1, b: 2 }, id: "same", name: "read_data" };
      const results = await Promise.all([
        input.executeToolCall!(call),
        input.executeToolCall!({ ...call, arguments: { a: 1, b: 2 } }),
      ]);
      expect(results[0]).toEqual(results[1]);
      return "Done.";
    }),
    tools: [tool(async () => ({ value: ++effects }))],
  }).createChatSession();
  expect(await session.send("Read")).toBe("Done.");
  expect(effects).toBe(1);
  expect(
    session.getHistory().filter((message) => message.role === "tool")
  ).toHaveLength(1);
});

test("a changed request under the same ID rejects even if the runtime swallows the error", async () => {
  let effects = 0;
  const session = createAgentHarness({
    provider: provider(async (input) => {
      await input.executeToolCall!({
        arguments: { a: 1 },
        id: "same",
        name: "read_data",
      });
      try {
        await input.executeToolCall!({
          arguments: { a: 2 },
          id: "same",
          name: "read_data",
        });
      } catch {
        /* exercise a misbehaving adapter */
      }
      return "Incorrect success.";
    }),
    tools: [tool(async () => ({ value: ++effects }))],
  }).createChatSession();
  await expect(session.send("Read")).rejects.toThrow();
  expect(effects).toBe(1);
  expect(session.getHistory().at(-1)).toMatchObject({
    role: "tool",
    toolCallId: "same",
  });
});

test("runtime tools cannot bypass schema validation", async () => {
  let effects = 0;
  const session = createAgentHarness({
    provider: provider(async (input) => {
      const result = await input.executeToolCall!({
        arguments: { value: 3 },
        id: "invalid",
        name: "read_data",
      });
      expect(result.success).toBe(false);
      return "Input rejected.";
    }),
    tools: [
      {
        ...tool(async () => {
          effects += 1;
          return {};
        }),
        parameters: {
          properties: { value: { type: "string" } },
          required: ["value"],
          type: "object",
        },
      },
    ],
  }).createChatSession();
  expect(await session.send("Read")).toBe("Input rejected.");
  expect(effects).toBe(0);
});

test("completed work is checkpointed before a runtime failure escapes", async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  let checkpointed = false;
  let effects = 0;
  const session = createAgentHarness({
    provider: provider(async (input) => {
      void input.executeToolCall!({
        arguments: {},
        id: "write",
        name: "read_data",
      }).catch(() => {});
      await started.promise;
      throw new Error("Runtime connection lost");
    }),
    tools: [
      tool(async () => {
        started.resolve();
        await finish.promise;
        effects += 1;
        return { written: true };
      }),
    ],
  }).createChatSession();
  const request = session.send("Write", {
    onToolCheckpoint: async () => {
      checkpointed = true;
    },
  });
  const rejected = request.then(
    () => null,
    (error: unknown) => error
  );
  await started.promise;
  finish.resolve();
  expect(await rejected).toBeInstanceOf(Error);
  expect(effects).toBe(1);
  expect(checkpointed).toBe(true);
  expect(session.getHistory().at(-1)).toMatchObject({
    content: '{"written":true}',
    role: "tool",
  });
});

test("a callback captured from a finished turn cannot execute later", async () => {
  let callback: GenerateChatInput["executeToolCall"];
  let effects = 0;
  const session = createAgentHarness({
    provider: provider(async (input) => {
      callback = input.executeToolCall;
      return "Done.";
    }),
    tools: [
      tool(async () => {
        effects += 1;
        return {};
      }),
    ],
  }).createChatSession();
  await session.send("Read");
  await expect(
    callback!({ arguments: {}, id: "late", name: "read_data" })
  ).rejects.toThrow();
  expect(effects).toBe(0);
});

test.each([true, false])(
  "native tool loops are bounded (changing results=%s)",
  async (changing) => {
    let effects = 0;
    const session = createAgentHarness({
      provider: provider(async (input) => {
        if (!input.executeToolCall) {
          return "Stopped with observed results.";
        }
        for (let index = 0; index < 110; index += 1) {
          await input.executeToolCall({
            arguments: {},
            id: `call-${index}`,
            name: "read_data",
          });
        }
        throw new Error("Unbounded native tool loop");
      }),
      tools: [
        tool(async () => {
          effects += 1;
          return { value: changing ? effects : 1 };
        }),
      ],
    }).createChatSession();
    expect(await session.send("Poll")).toBe("Stopped with observed results.");
    expect(effects).toBe(changing ? 100 : 4);
  }
);

test.each([false, true])(
  "an old tool cannot overlap a new turn (clear=%s)",
  async (clear) => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const abort = new AbortController();
    let captured: GenerateChatInput["executeToolCall"];
    let turns = 0;
    let effects = 0;
    let checkpoints = 0;
    const session = createAgentHarness({
      provider: provider(async (input) => {
        turns += 1;
        if (turns > 1) {
          return "Fresh reply.";
        }
        captured = input.executeToolCall;
        await captured!({ arguments: {}, id: "old", name: "read_data" });
        return "Old reply.";
      }),
      tools: [
        tool(async () => {
          started.resolve();
          await finish.promise;
          effects += 1;
          return { effect: "old" };
        }),
      ],
    }).createChatSession();
    const oldTurn = session
      .send("Old request", {
        onToolCheckpoint: async () => {
          checkpoints += 1;
        },
        signal: abort.signal,
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    await started.promise;
    if (clear) {
      session.clear();
      expect(await session.send("Fresh request")).toBe("Fresh reply.");
      await expect(
        captured!({ arguments: {}, id: "late", name: "read_data" })
      ).rejects.toThrow();
    } else {
      abort.abort();
      await expect(session.send("Too early")).rejects.toThrow();
    }
    finish.resolve();
    expect(await oldTurn).toBeInstanceOf(Error);
    expect(effects).toBe(1);
    expect(checkpoints).toBe(clear ? 0 : 1);
    if (clear) {
      expect(session.getHistory()).toEqual([
        { content: "Fresh request", role: "user" },
        { content: "Fresh reply.", role: "assistant" },
      ]);
    } else {
      expect(session.getHistory().at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "old",
      });
      expect(await session.send("Fresh request")).toBe("Fresh reply.");
    }
  }
);

test.each(["unassigned", "schema", "guest", "principal"] as const)(
  "%s tool requests are rejected before approval",
  async (reason) => {
    let effects = 0;
    let approvals = 0;
    const session = createAgentHarness({
      provider: provider(async (input) => {
        const result = await input.executeToolCall!({
          arguments: { path: 42 },
          id: "invalid",
          name: "delete_file",
        });
        expect(result.success).toBe(false);
        return "Rejected.";
      }),
      tools: [
        {
          ...tool(
            async () => {
              effects += 1;
              return {};
            },
            reason === "unassigned" ? "another_tool" : "delete_file"
          ),
          parameters:
            reason === "schema"
              ? {
                  properties: { path: { type: "string" } },
                  required: ["path"],
                  type: "object",
                }
              : { type: "object" },
        },
      ],
    }).createChatSession({
      toolContext: {
        orgId: "org",
        async requestToolApproval() {
          approvals += 1;
          return { decision: "denied" };
        },
        userId:
          reason === "guest"
            ? "user_channel_guest_test"
            : reason === "principal"
              ? undefined
              : "user",
      },
    });
    expect(await session.send("Delete")).toBe("Rejected.");
    expect(effects).toBe(0);
    expect(approvals).toBe(0);
  }
);

test("API tool batches retain completed effects when a later approval is interrupted", async () => {
  let effects = 0;
  let checkpoints = 0;
  const session = createAgentHarness({
    provider: {
      async generateChat() {
        const toolCalls = [
          { arguments: {}, id: "read", name: "read_data" },
          { arguments: { path: "fixture" }, id: "delete", name: "delete_file" },
        ];
        return {
          assistantMessage: {
            content: "",
            role: "assistant" as const,
            toolCalls,
          },
          content: "",
          toolCalls,
        };
      },
      async generateText() {
        return { content: "unused" };
      },
      name: "api",
    },
    tools: [
      tool(async () => {
        effects += 1;
        return { effect: "read" };
      }),
      tool(async () => {
        throw new Error("Must not run");
      }, "delete_file"),
    ],
  }).createChatSession({
    toolContext: {
      orgId: "org",
      async requestToolApproval() {
        throw new Error("Approval interrupted");
      },
      userId: "user",
    },
  });
  await expect(
    session.send("Read and delete", {
      onToolCheckpoint: async () => {
        checkpoints += 1;
      },
    })
  ).rejects.toThrow();
  expect(effects).toBe(1);
  expect(checkpoints).toBe(1);
  expect(session.getHistory().at(-1)).toMatchObject({
    role: "tool",
    toolCallId: "read",
  });
});
