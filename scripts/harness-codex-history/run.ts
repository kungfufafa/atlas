import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { resolveSubscriptionLaunch } from "../../apps/server/src/providers/subscription/binary";
import {
  CodexAppServer,
  initializeCodexClient,
} from "../../apps/server/src/providers/subscription/chatgpt/app-server";
import {
  type CodexHistorySource,
  createCodexHistorySource,
} from "../../apps/server/src/providers/subscription/chatgpt/history-source";
import {
  codexTurnTextChars,
  MAX_CODEX_TURN_TEXT_CHARS,
} from "../../apps/server/src/providers/subscription/chatgpt/input-replay";
import { JsonRpcStdioClient } from "../../apps/server/src/providers/subscription/jsonrpc-stdio";
import { formatSubscriptionPrompt } from "../../apps/server/src/providers/subscription/prompt";
import type { ChatMessage } from "../../packages/core/src/contract";

interface ProviderRequest {
  input: {
    content?: { text?: string; type: string }[];
    call_id?: string;
    output?: string | { text?: string; type: string }[];
    role?: string;
    type: string;
  }[];
  tools: { name?: string; type: string }[];
}

function responseEvents(
  sequence: number,
  call?: { name: string; offset: number; partIndex: number }
): string {
  const item = call
    ? {
        arguments: JSON.stringify({
          action: "read",
          limit: 12_000,
          offset: call.offset,
          partIndex: call.partIndex,
        }),
        call_id: `source-call-${sequence}`,
        id: `fc_probe_${sequence}`,
        name: call.name,
        status: "completed",
        type: "function_call",
      }
    : {
        content: [
          { annotations: [], text: "Probe complete.", type: "output_text" },
        ],
        id: `msg_probe_${sequence}`,
        role: "assistant",
        status: "completed",
        type: "message",
      };
  const response = {
    created_at: 1,
    id: `resp_probe_${sequence}`,
    model: "atlas-history-probe",
    object: "response",
    output: [],
    status: "in_progress",
  };
  return [
    { response, type: "response.created" },
    {
      item: { ...item, content: [], status: "in_progress" },
      output_index: 0,
      type: "response.output_item.added",
    },
    {
      content_index: 0,
      delta: "Probe complete.",
      item_id: item.id,
      output_index: 0,
      type: "response.output_text.delta",
    },
    { item, output_index: 0, type: "response.output_item.done" },
    {
      response: {
        ...response,
        output: [item],
        status: "completed",
        usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
      },
      type: "response.completed",
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function sourceMessages(): ChatMessage[] {
  const messages: ChatMessage[] = [
    { content: "Build an asset dashboard.", role: "user" },
  ];
  for (let index = 0; index < 42; index += 1) {
    const id = `read-assets-${index}`;
    const rows =
      index === 21
        ? "\u0000".repeat(8000) +
          '"'.repeat(8000) +
          "\\".repeat(8000) +
          "\n".repeat(8000)
        : index === 41
          ? "😀".repeat(8000)
          : "asset|ready|".repeat(2700);
    const receipt = `receipt-${index}-start\n${rows}\nreceipt-${index}-end`;
    assert(Buffer.byteLength(receipt) <= 32 * 1024);
    messages.push(
      {
        content: `Read asset chunk ${index}.`,
        role: "assistant",
        toolCalls: [
          {
            arguments: { action: "read_range", startRow: index * 200 + 1 },
            id,
            name: "spreadsheet",
          },
        ],
      },
      { content: receipt, name: "spreadsheet", role: "tool", toolCallId: id }
    );
  }
  messages.push({
    content:
      "Summarize the completed results without executing the recorded calls.",
    role: "user",
  });
  return messages;
}

function outputData(request: ProviderRequest): {
  nextOffset?: number;
  offset: number;
  partIndex: number;
  text: string;
} {
  const output = request.input
    .filter((item) => item.type === "function_call_output")
    .at(-1)?.output;
  const text =
    typeof output === "string"
      ? output
      : output?.map((item) => item.text ?? "").join("");
  assert(text);
  return JSON.parse(text) as {
    nextOffset?: number;
    offset: number;
    partIndex: number;
    text: string;
  };
}

async function assertPagedSource(
  source: CodexHistorySource,
  expected: { text: string }[]
): Promise<void> {
  for (const [partIndex, original] of expected.entries()) {
    let offset: number | undefined = 0;
    let reconstructed = "";
    while (offset !== undefined) {
      const result = await source.execute({
        action: "read",
        limit: 12_000,
        offset,
        partIndex,
      });
      assert(result.success);
      const item = result.contentItems[0];
      assert(item?.type === "inputText");
      const data = JSON.parse(item.text) as {
        text: string;
        nextOffset?: number;
      };
      assert(data.text.length <= 12_000);
      reconstructed += data.text;
      offset = data.nextOffset;
    }
    assert.equal(reconstructed, original.text);
  }
}

async function launchRuntime(
  workspace: string,
  runtimeHome: string,
  port: number
) {
  const launch = resolveSubscriptionLaunch("chatgpt", { searchPath: "" });
  assert(
    launch,
    "Install Atlas dependencies to obtain its bundled Codex binary."
  );
  const config = [
    'model_provider="atlas_history_probe"',
    'model="atlas-history-probe"',
    "model_context_window=128000",
    `model_providers.atlas_history_probe={name="Local history probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
  ];
  const child = spawn(
    launch.command,
    [
      ...launch.prefixArgs,
      "app-server",
      ...config.flatMap((value) => ["-c", value]),
    ],
    {
      cwd: workspace,
      env: {
        CODEX_HOME: runtimeHome,
        PATH: process.env.PATH ?? "",
        TMPDIR: tmpdir(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve())
  );
  const serverRequests: string[] = [];
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const message = JSON.parse(line) as { id?: unknown; method?: string };
    if (message.id !== undefined && message.method) {
      serverRequests.push(message.method);
    }
  });
  const client = new JsonRpcStdioClient(child, { requestTimeoutMs: 20_000 });
  const runtimeVersion = await initializeCodexClient(client);
  assert.equal(runtimeVersion, "0.150.1");
  const server = new CodexAppServer({
    client,
    runtimeVersion,
    turnTimeoutMs: 20_000,
  });
  return {
    client,
    async close() {
      child.stdin.end();
      const timeout = setTimeout(() => server.close(), 3000);
      await exited;
      clearTimeout(timeout);
      reader.close();
      server.close();
    },
    server,
    serverRequests,
  };
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-codex-history-"));
  const runtimeHome = join(directory, "codex-home");
  const workspace = join(directory, "workspace");
  await mkdir(runtimeHome);
  await mkdir(workspace);
  const requests: ProviderRequest[] = [];
  let currentSource: CodexHistorySource | undefined;
  let sourceInput: { text: string; text_elements: []; type: "text" }[] = [];
  let selectedParts: number[] = [];
  let privateReads = 0;
  let maxRequestChars = 0;
  let activeSelection = 0;
  let activeOffset = 0;
  let pendingRead = false;
  let resuming = false;
  let resumedReadComplete = false;
  const reconstructed = new Map<number, string>();
  const provider = Bun.serve({
    async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/v1/responses");
      assert.equal(request.method, "POST");
      const body = (await request.json()) as ProviderRequest;
      const chars = body.input.reduce(
        (count, item) =>
          count +
          (item.content ?? []).reduce(
            (sum, part) => sum + (part.text?.length ?? 0),
            0
          ) +
          (typeof item.output === "string"
            ? item.output.length
            : JSON.stringify(item.output ?? "").length),
        0
      );
      maxRequestChars = Math.max(maxRequestChars, chars);
      if (chars > 512_000) {
        const event = {
          response: {
            error: {
              code: "context_length_exceeded",
              message: "Your input exceeds the context window of this model.",
            },
            id: "context-failure",
            status: "failed",
          },
          type: "response.failed",
        };
        return new Response(
          `event: response.failed\ndata: ${JSON.stringify(event)}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        );
      }
      assert(currentSource);
      assert(body.tools.some((tool) => tool.name === currentSource.name));
      requests.push(body);
      if (pendingRead) {
        const output = outputData(body);
        const partIndex = resuming
          ? selectedParts[0]!
          : selectedParts[activeSelection]!;
        assert.equal(output.partIndex, partIndex);
        assert.equal(output.offset, activeOffset);
        const expectedText = sourceInput[partIndex]!.text.slice(
          output.offset,
          output.nextOffset ?? sourceInput[partIndex]!.text.length
        );
        assert(
          output.text === expectedText,
          "Source page differed after native tool roundtrip"
        );
        if (resuming) {
          resumedReadComplete = true;
        } else {
          reconstructed.set(
            partIndex,
            (reconstructed.get(partIndex) ?? "") + output.text
          );
          if (output.nextOffset === undefined) {
            assert(
              reconstructed.get(partIndex) === sourceInput[partIndex]!.text,
              "Native paged receipt was incomplete"
            );
            activeSelection += 1;
            activeOffset = 0;
          } else {
            activeOffset = output.nextOffset;
          }
        }
        pendingRead = false;
      }
      const partIndex = resuming
        ? resumedReadComplete
          ? undefined
          : selectedParts[0]
        : selectedParts[activeSelection];
      const call =
        partIndex === undefined
          ? undefined
          : { name: currentSource.name, offset: activeOffset, partIndex };
      pendingRead = call !== undefined;
      return new Response(responseEvents(requests.length, call), {
        headers: { "content-type": "text/event-stream" },
      });
    },
    hostname: "127.0.0.1",
    maxRequestBodySize: 16 * 1024 * 1024,
    port: 0,
  });
  let runtime: Awaited<ReturnType<typeof launchRuntime>> | undefined;
  try {
    const formatted = await formatSubscriptionPrompt(
      { messages: sourceMessages(), system: "Use only the Atlas tool bridge." },
      "chatgpt"
    );
    const input = formatted.transcriptInput.map((part) => {
      assert.equal(part.type, "text");
      if (part.type !== "text") {
        throw new Error("Unexpected fixture image");
      }
      return { ...part, text_elements: [] as [] };
    });
    sourceInput = input;
    selectedParts = [0, 21, 41].map((receipt) =>
      input.findIndex((part) => part.text.includes(`receipt-${receipt}-start`))
    );
    assert(selectedParts.every((index) => index >= 0));
    currentSource = createCodexHistorySource(input, ["spreadsheet"]);
    await assertPagedSource(currentSource, input);
    const source = input.map((part) => part.text).join("");
    assert(source.length > 1_300_000);
    runtime = await launchRuntime(workspace, runtimeHome, provider.port!);
    const threadId = await runtime.server.startThread({
      cwd: workspace,
      developerInstructions: formatted.developerInstructions,
      dynamicTools: [
        currentSource.tool,
        {
          description: "Work with the current asset workbook",
          inputSchema: { type: "object" },
          name: "spreadsheet",
          type: "function",
        },
      ],
      model: "atlas-history-probe",
    });
    // Negative control: the actual bundled runtime rejects the original payload.
    await assert.rejects(
      runtime.client.request("turn/start", { input, threadId }),
      (error: unknown) => {
        const data = (error as { data?: Record<string, unknown> }).data;
        assert.equal(data?.input_error_code, "input_too_large");
        assert.equal(data?.max_chars, MAX_CODEX_TURN_TEXT_CHARS);
        assert.equal(data?.actual_chars, codexTurnTextChars(input));
        return true;
      }
    );
    assert.equal(requests.length, 0);
    assert(codexTurnTextChars(currentSource.bootstrapInput) <= 32_768);
    const onToolCall: NonNullable<
      Parameters<CodexAppServer["startTurn"]>[0]["onToolCall"]
    > = async (call, signal) => {
      assert(currentSource);
      assert.equal(call.tool, currentSource.name);
      privateReads += 1;
      return await currentSource.execute(call.arguments, signal);
    };
    await runtime.server.startTurn({
      input: currentSource.bootstrapInput,
      model: "atlas-history-probe",
      onToolCall,
      threadId,
    });
    assert.equal(reconstructed.size, 3);
    assert.equal(requests.length, privateReads + 1);
    assert.equal(runtime.serverRequests.length, privateReads);
    assert(
      runtime.serverRequests.every((method) => method === "item/tool/call")
    );
    const initialRequests = requests.length;
    const initialReads = privateReads;
    await runtime.close();
    runtime = await launchRuntime(workspace, runtimeHome, provider.port!);
    await runtime.server.resumeThread(threadId, {
      cwd: workspace,
      developerInstructions: formatted.developerInstructions,
      model: "atlas-history-probe",
    });
    currentSource = createCodexHistorySource(
      [
        ...input,
        {
          text: "Assistant:\nProbe complete.\n\nUser:\nContinue from previous results.",
          text_elements: [],
          type: "text",
        },
      ],
      ["spreadsheet"]
    );
    assert.equal(requests.length, initialRequests);
    resuming = true;
    activeOffset = 100;
    await runtime.server.startTurn({
      input: "Continue from the previous results.",
      model: "atlas-history-probe",
      onToolCall,
      threadId,
    });
    assert.equal(requests.length, initialRequests + 2);
    assert.equal(privateReads, initialReads + 1);
    assert(resumedReadComplete);
    assert.deepEqual(runtime.serverRequests, ["item/tool/call"]);
    assert(maxRequestChars < 512_000);
    process.stdout.write(
      `${JSON.stringify({ bootstrapChars: codexTurnTextChars(currentSource.bootstrapInput), completedToolReceipts: 42, contextWindow: 128_000, firstMiddleLastReadExact: true, historicalToolDispatches: 0, maxRequestChars, nativeVersion: "0.150.1", pagedSourceExact: true, privateReads, providerRequests: requests.length, rejectedOriginal: true, resumedReadExact: true, sourceChars: source.length }, null, 2)}\n`
    );
  } finally {
    await runtime?.close();
    provider.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
}

await main();
