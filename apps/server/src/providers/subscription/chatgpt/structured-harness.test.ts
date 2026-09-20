import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAgentHarness } from "@atlas/agent";
import {
  type ChatMessage,
  runWithUserConfigDir,
  type ToolDefinition,
} from "@atlas/core";
import { JsonRpcStdioClient, type JsonRpcStdioProcess } from "../jsonrpc-stdio";
import { setChatgptRuntimeForTests } from "../runtimes";
import { readSubscriptionSession } from "../session-store";
import { CodexAppServer, type CodexDynamicToolResult } from "./app-server";
import { createChatgptProvider } from "./provider";
import { ChatgptSubscriptionRuntime } from "./runtime";

interface RpcMessage {
  error?: unknown;
  id: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

/** Only the remote model/process is simulated; every Atlas execution layer is real. */
class HarnessCodexProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: RpcMessage[] = [];
  readonly acknowledgements: { checkpoints: number; id: number | string }[] =
    [];

  constructor(
    private readonly checkpointCount: () => number,
    private readonly disconnectAfterRead: boolean
  ) {
    super();
    this.stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        const message: RpcMessage = JSON.parse(line);
        this.messages.push(message);
        this.receive(message);
      }
    });
  }

  kill(): void {
    this.emit("exit", 0);
  }

  private send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private call(
    requestId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>
  ): void {
    this.send({
      id: requestId,
      method: "item/tool/call",
      params: {
        arguments: args,
        callId,
        threadId: "native-thread",
        tool,
        turnId: "native-turn",
      },
    });
  }

  private receive(message: RpcMessage): void {
    if (message.method) {
      this.receiveRequest(message);
      return;
    }
    this.acknowledgements.push({
      checkpoints: this.checkpointCount(),
      id: message.id,
    });
    if (message.id === "read-request") {
      if (this.disconnectAfterRead) {
        this.emit("exit", 1);
        return;
      }
      const result = readToolResult(message);
      // A fresh token from the first tool is the required argument of the next
      // tool. The simulated model cannot choose this value before receiving it.
      this.call("read-replay", "read-call", "read_inventory", {
        item: "notebook",
      });
      this.call("total-request", "total-call", "calculate_total", {
        quantity: 3,
        receipt: result.receipt,
      });
    }
    if (message.id === "total-request") {
      const result = readToolResult(message);
      this.send({
        method: "item/agentMessage/delta",
        params: {
          delta: `Total: ${result.total}.`,
          threadId: "native-thread",
          turnId: "native-turn",
        },
      });
      this.send({
        method: "turn/completed",
        params: {
          threadId: "native-thread",
          turn: { id: "native-turn", status: "completed" },
        },
      });
    }
  }

  private receiveRequest(message: RpcMessage): void {
    let result: unknown;
    switch (message.method) {
      case "config/read":
        result = { config: {} };
        break;
      case "account/read":
        result = { account: { type: "chatgpt" } };
        break;
      case "model/list":
        result = { data: [{ id: "model-test", isDefault: true }] };
        break;
      case "thread/start":
      case "thread/resume":
        result = { thread: { id: "native-thread" } };
        break;
      case "thread/delete":
      case "turn/interrupt":
        result = {};
        break;
      case "turn/start":
        this.send({ id: message.id, result: { turn: { id: "native-turn" } } });
        this.call("read-request", "read-call", "read_inventory", {
          item: "notebook",
        });
        return;
      default:
        this.send({
          error: { code: -32_601, message: "Unexpected test request" },
          id: message.id,
        });
        return;
    }
    this.send({ id: message.id, result });
  }
}

function readToolResult(message: RpcMessage): Record<string, unknown> {
  const result = message.result as CodexDynamicToolResult;
  const text = result.contentItems.find((item) => item.type === "inputText");
  if (!result.success || text?.type !== "inputText") {
    throw new Error("Expected a successful typed Atlas result.");
  }
  return JSON.parse(text.text);
}

function scenarioTools(effects: string[]): ToolDefinition[] {
  let receipt: string | undefined;
  return [
    {
      description: "Read the inventory price",
      name: "read_inventory",
      parameters: {
        properties: { item: { type: "string" } },
        required: ["item"],
        type: "object",
      },
      async run(args, context) {
        effects.push("read");
        expect(args.item).toBe("notebook");
        expect(context?.orgId).toBe("org-integration");
        expect(context?.sessionId).toBe("session-integration");
        receipt = crypto.randomUUID();
        return { receipt, unitPrice: 7 };
      },
    },
    {
      description: "Calculate the total for a verified inventory receipt",
      name: "calculate_total",
      parameters: {
        properties: {
          quantity: { type: "number" },
          receipt: { type: "string" },
        },
        required: ["quantity", "receipt"],
        type: "object",
      },
      async run(args) {
        effects.push("total");
        expect(args.receipt).toBe(receipt);
        expect(args.quantity).toBe(3);
        return { total: 21 };
      },
    },
  ];
}

async function runScenario(
  mode: "send" | "stream",
  disconnectAfterRead = false
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-structured-harness-"));
  try {
    await runWithUserConfigDir(directory, async () => {
      const checkpoints: ChatMessage[][] = [];
      const effects: string[] = [];
      const process = new HarnessCodexProcess(
        () => checkpoints.length,
        disconnectAfterRead
      );
      const server = new CodexAppServer({
        client: new JsonRpcStdioClient(process),
        // Failed native cleanup may attempt reconnect; never launch a real
        // runtime/provider from this offline process-disconnection test.
        command: join(directory, "no-runtime-binary"),
        runtimeVersion: "0.150.1",
        turnTimeoutMs: 1000,
      });
      const runtime = new ChatgptSubscriptionRuntime(server);
      setChatgptRuntimeForTests(runtime);
      const session = createAgentHarness({
        provider: createChatgptProvider({ model: "model-test" }),
        tools: scenarioTools(effects),
      }).createChatSession({
        toolContext: {
          orgId: "org-integration",
          sessionId: "session-integration",
          workspaceRoot: directory,
        },
      });
      const sendOptions = {
        async onToolCheckpoint() {
          checkpoints.push(structuredClone([...session.getHistory()]));
        },
      };
      const chunks: string[] = [];
      const prompt =
        "Read the notebook price and calculate the total for three.";
      try {
        const reply =
          mode === "send"
            ? session.send(prompt, sendOptions)
            : session.sendStream(
                prompt,
                { onChunk: (chunk) => chunks.push(chunk) },
                sendOptions
              );
        if (disconnectAfterRead) {
          await expect(reply).rejects.toBeInstanceOf(Error);
          expect(effects).toEqual(["read"]);
          expect(checkpoints).toHaveLength(1);
          expect(
            await readSubscriptionSession("chatgpt", "session-integration")
          ).toBeNull();
        } else {
          expect(await reply).toBe("Total: 21.");
          expect(effects).toEqual(["read", "total"]);
          expect(checkpoints).toHaveLength(2);
          if (mode === "stream") {
            expect(chunks.join("")).toBe("Total: 21.");
          }
        }

        const expectedCallIds = disconnectAfterRead
          ? ["read-call"]
          : ["read-call", "total-call"];
        const history = session.getHistory();
        const toolMessages = history.filter(
          (message) => message.role === "tool"
        );
        expect(toolMessages.map((message) => message.toolCallId)).toEqual(
          expectedCallIds
        );
        expect(
          history.flatMap((message) =>
            message.role === "assistant"
              ? (message.toolCalls ?? []).map((call) => call.id)
              : []
          )
        ).toEqual(expectedCallIds);
        expect(
          checkpoints.at(-1)?.filter((message) => message.role === "tool")
        ).toEqual(toolMessages);
        expect(
          process.acknowledgements.find((ack) => ack.id === "read-request")
            ?.checkpoints
        ).toBe(1);
        if (!disconnectAfterRead) {
          expect(
            process.acknowledgements.find((ack) => ack.id === "total-request")
              ?.checkpoints
          ).toBe(2);
        }

        const starts = process.messages.filter(
          (message) => message.method === "thread/start"
        );
        expect(starts).toHaveLength(1);
        expect(starts[0]?.params?.dynamicTools).toMatchObject([
          {
            inputSchema: { required: ["item"] },
            name: "read_inventory",
            type: "function",
          },
          {
            inputSchema: { required: ["quantity", "receipt"] },
            name: "calculate_total",
            type: "function",
          },
        ]);
        expect(
          process.messages.filter((message) => message.method === "turn/start")
        ).toHaveLength(1);
        expect(
          JSON.stringify(starts[0]?.params?.developerInstructions)
        ).not.toContain("atlas-tool-call");
      } finally {
        runtime.close();
        setChatgptRuntimeForTests(null);
      }
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("Codex JSON-RPC through the Atlas harness", () => {
  test.each(["send", "stream"] as const)(
    "%s executes dependent structured tools within one native turn",
    async (mode) => {
      await runScenario(mode);
    }
  );

  test("retains one completed call and result after the runtime process disconnects", async () => {
    await runScenario("stream", true);
  });
});
