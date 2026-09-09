import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatMessage,
  type GenerateChatInput,
  runWithUserConfigDir,
} from "@atlas/core";
import { formatSubscriptionPrompt } from "../prompt";
import { readSubscriptionSession } from "../session-store";
import { CodexAppServer, type CodexDynamicToolResult } from "./app-server";
import { assertCodexTurnInputSize, codexTurnTextChars } from "./input-replay";
import { ChatgptSubscriptionRuntime } from "./runtime";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const RECEIPT_PARTS = Array.from(
  { length: 42 },
  (_, index) =>
    `receipt-${index}-start\n${"asset|ready|".repeat(2700)}\nreceipt-${index}-end`
);
const LARGE_RECEIPT = RECEIPT_PARTS.join("\n");
type TurnOptions = Parameters<CodexAppServer["startTurn"]>[0];
type ReadPart = { text: string; type: "text" } | { type: "image"; url: string };

class SourceCodexServer extends CodexAppServer {
  readonly started: Parameters<CodexAppServer["startThread"]>[0][] = [];
  readonly resumed: string[] = [];
  readonly deleted: string[] = [];
  readonly turns: TurnOptions[] = [];
  responseText = "Done.";
  onTurn: (options: TurnOptions) => Promise<void> = async () => undefined;
  override isConnected(): boolean {
    return true;
  }
  override async account() {
    return { type: "chatgpt" };
  }
  override async listModels() {
    return [
      {
        id: "model-test",
        inputModalities: ["text", "image"] as ("text" | "image")[],
        isDefault: true,
      },
    ];
  }
  override async startThread(
    options: Parameters<CodexAppServer["startThread"]>[0]
  ): Promise<string> {
    this.started.push(options);
    return `native-${this.started.length}`;
  }
  override async resumeThread(threadId: string): Promise<string> {
    this.resumed.push(threadId);
    return threadId;
  }
  override async deleteThread(threadId: string): Promise<void> {
    this.deleted.push(threadId);
  }
  override async startTurn(options: TurnOptions) {
    assertCodexTurnInputSize(options.input);
    this.turns.push(options);
    await this.onTurn(options);
    options.signal?.throwIfAborted();
    options.onDelta?.(this.responseText);
    return { text: this.responseText, thinking: "" };
  }
}

async function inTemporaryConfig(
  operation: () => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-codex-source-"));
  try {
    await runWithUserConfigDir(directory, operation);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function makeInput(): GenerateChatInput {
  const messages: ChatMessage[] = [
    { content: "Build the dashboard.", role: "user" },
  ];
  for (const [index, content] of RECEIPT_PARTS.entries()) {
    const id = `read-assets-${index}`;
    messages.push(
      {
        content: `Reading asset chunk ${index}.`,
        role: "assistant",
        toolCalls: [
          {
            arguments: { action: "read_range", startRow: index * 200 + 1 },
            id,
            name: "spreadsheet",
          },
        ],
      },
      { content, name: "spreadsheet", role: "tool", toolCallId: id }
    );
  }
  messages.push({
    content: "Summarize the findings without re-reading the export.",
    role: "user",
  });
  return {
    conversationId: "conversation-source",
    executeToolCall: async () => {
      throw new Error("Historical tool calls must never execute.");
    },
    messages,
    system: "You are Atlas.",
    tools: [
      {
        description: "Work with assets",
        name: "spreadsheet",
        parameters: { type: "object" },
      },
    ],
  };
}

function sourceReader(server: SourceCodexServer, options: TurnOptions) {
  const source = server.started
    .at(-1)
    ?.dynamicTools?.find((tool) =>
      tool.name.startsWith("atlas_history_source")
    );
  if (!(source && options.onToolCall)) {
    throw new Error("Missing private history reader");
  }
  const handler = options.onToolCall;
  let sequence = 0;
  return async (
    args: Record<string, unknown>
  ): Promise<CodexDynamicToolResult> =>
    await handler(
      {
        arguments: args,
        callId: `history-${++sequence}`,
        threadId: options.threadId,
        tool: source.name,
        turnId: `turn-${server.turns.length}`,
      },
      options.signal ?? new AbortController().signal
    );
}

function resultData<T>(result: CodexDynamicToolResult): T {
  if (!result.success) {
    throw new Error("History read failed");
  }
  const text = result.contentItems.find((item) => item.type === "inputText");
  if (!text || text.type !== "inputText") {
    throw new Error("Missing history read metadata");
  }
  return JSON.parse(text.text) as T;
}

async function readEntireSource(
  read: ReturnType<typeof sourceReader>
): Promise<ReadPart[]> {
  const parts: ReadPart[] = [];
  let listOffset: number | undefined = 0;
  while (listOffset !== undefined) {
    const listing = resultData<{
      nextOffset?: number;
      parts: { partIndex: number; type: "text" | "image" }[];
    }>(await read({ action: "list", limit: 20, offset: listOffset }));
    for (const part of listing.parts) {
      let offset: number | undefined = 0;
      let text = "";
      while (offset !== undefined) {
        const result = await read(
          part.type === "image"
            ? { action: "read", partIndex: part.partIndex }
            : {
                action: "read",
                limit: 12_000,
                offset,
                partIndex: part.partIndex,
              }
        );
        const data = resultData<{ nextOffset?: number; text?: string }>(result);
        if (part.type === "image") {
          const image = result.contentItems.find(
            (item) => item.type === "inputImage"
          );
          if (!image || image.type !== "inputImage") {
            throw new Error("Missing original image");
          }
          parts.push({ type: "image", url: image.imageUrl });
          break;
        }
        text += data.text ?? "";
        offset = data.nextOffset;
      }
      if (part.type === "text") {
        parts.push({ text, type: "text" });
      }
    }
    listOffset = listing.nextOffset;
  }
  return parts;
}

test("large aggregate tool history stays exactly recoverable through bounded private source reads", async () => {
  await inTemporaryConfig(async () => {
    const server = new SourceCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const input = makeInput();
    const expected = await formatSubscriptionPrompt(
      { ...input, tools: undefined },
      "chatgpt"
    );
    for (const receipt of input.messages.filter(
      (message) => message.role === "tool"
    )) {
      expect(String(receipt.content).length).toBeLessThanOrEqual(32 * 1024);
    }
    let source: ReadPart[] = [];
    server.onTurn = async (options) => {
      source = await readEntireSource(sourceReader(server, options));
    };
    const result = await runtime.generateChat(input);
    expect(source).toEqual(expected.transcriptInput);
    expect(server.started).toHaveLength(1);
    expect(server.turns).toHaveLength(1);
    expect(codexTurnTextChars(server.turns[0]!.input)).toBeLessThanOrEqual(
      32 * 1024
    );
    expect(server.started[0]?.dynamicTools?.map((tool) => tool.name)).toEqual([
      "spreadsheet",
      "atlas_history_source",
    ]);
    expect(result.toolCalls).toEqual([]);
    expect(
      (await readSubscriptionSession("chatgpt", input.conversationId!))
        ?.lastMessageCount
    ).toBe(input.messages.length);
    const originalParts = source;
    const continued: GenerateChatInput = {
      ...input,
      messages: [
        ...input.messages,
        result.assistantMessage,
        { content: "Continue.", role: "user" },
      ],
    };
    await runtime.generateChat(continued);
    const continuedExpected = await formatSubscriptionPrompt(
      { ...continued, tools: undefined },
      "chatgpt"
    );
    expect(source).toEqual(continuedExpected.transcriptInput);
    expect(source.slice(0, originalParts.length)).toEqual(originalParts);
    expect(server.resumed).toEqual(["native-1"]);
    expect(server.started).toHaveLength(1);
    expect(server.turns[1]?.input).toEqual([
      { text: "User:\nContinue.", text_elements: [], type: "text" },
    ]);
  });
});

test("history reader exposes original images in their source positions without converting them to text", async () => {
  await inTemporaryConfig(async () => {
    const server = new SourceCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const input = makeInput();
    input.messages[0] = {
      content: [
        { text: "before-image", type: "text" },
        { data: TINY_PNG_BASE64, mediaType: "image/png", type: "image" },
        { text: "after-image", type: "text" },
      ],
      role: "user",
    };
    let source: ReadPart[] = [];
    server.onTurn = async (options) => {
      source = await readEntireSource(sourceReader(server, options));
    };
    await runtime.generateChat(input);
    expect(source[0]).toEqual({ text: "User:\nbefore-image", type: "text" });
    expect(source[1]).toEqual({
      type: "image",
      url: `data:image/png;base64,${TINY_PNG_BASE64}`,
    });
    expect(source[2]).toEqual({ text: "after-image", type: "text" });
    expect(
      source
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toContain(RECEIPT_PARTS.at(-1)!);
  });
});

test("crossing the transport cap with a giant user message installs the source reader on a fresh thread", async () => {
  await inTemporaryConfig(async () => {
    const server = new SourceCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const input = {
      ...makeInput(),
      messages: [{ content: "Start here.", role: "user" } as ChatMessage],
    };
    const first = await runtime.generateChat(input);
    const giant = `latest-start${"a".repeat(1_300_000)}latest-end`;
    let source: ReadPart[] = [];
    server.onTurn = async (options) => {
      source = await readEntireSource(sourceReader(server, options));
    };
    await runtime.generateChat({
      ...input,
      messages: [
        ...input.messages,
        first.assistantMessage,
        { content: giant, role: "user" },
      ],
    });
    expect(server.resumed).toEqual([]);
    expect(server.started).toHaveLength(2);
    expect(
      source
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toContain(giant);
    expect(codexTurnTextChars(server.turns[1]!.input)).toBeLessThanOrEqual(
      32 * 1024
    );
    expect(server.deleted).toEqual(["native-1"]);
    expect(
      (await readSubscriptionSession("chatgpt", input.conversationId!))
        ?.runtimeSessionId
    ).toBe("native-2");
  });
});

test("a large continuation below the transport cap remains bounded on an existing source-backed thread", async () => {
  await inTemporaryConfig(async () => {
    const server = new SourceCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const input = makeInput();
    const first = await runtime.generateChat(input);
    const latest = `latest-request-start${"b".repeat(900_000)}latest-request-end`;
    let source: ReadPart[] = [];
    server.onTurn = async (options) => {
      source = await readEntireSource(sourceReader(server, options));
    };
    await runtime.generateChat({
      ...input,
      messages: [
        ...input.messages,
        first.assistantMessage,
        { content: latest, role: "user" },
      ],
    });
    expect(server.resumed).toEqual(["native-1"]);
    expect(server.started).toHaveLength(1);
    expect(codexTurnTextChars(server.turns[1]!.input)).toBeLessThanOrEqual(
      32 * 1024
    );
    expect(source.at(-1)).toEqual({ text: `User:\n${latest}`, type: "text" });
    expect(server.deleted).toEqual([]);
  });
});

test("revoking an application tool keeps historical receipts readable without restoring execution authority", async () => {
  await inTemporaryConfig(async () => {
    const server = new SourceCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const input = makeInput();
    const first = await runtime.generateChat(input);
    server.onTurn = async (options) => {
      const source = await readEntireSource(sourceReader(server, options));
      expect(
        source
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      ).toContain(RECEIPT_PARTS[0]!);
      await expect(
        options.onToolCall!(
          {
            arguments: { action: "write_range" },
            callId: "revoked",
            threadId: options.threadId,
            tool: "spreadsheet",
            turnId: "turn-2",
          },
          new AbortController().signal
        )
      ).rejects.toBeInstanceOf(Error);
    };
    await runtime.generateChat({
      ...input,
      messages: [
        ...input.messages,
        first.assistantMessage,
        { content: "Continue with recorded results.", role: "user" },
      ],
      tools: [],
    });
    expect(server.resumed).toEqual([]);
    expect(server.started[1]?.dynamicTools?.map((tool) => tool.name)).toEqual([
      "atlas_history_source",
    ]);
    expect(server.deleted).toEqual(["native-1"]);
  });
});

test("a giant one-shot summarization has complete source access and deletes its finished native thread", async () => {
  await inTemporaryConfig(async () => {
    const server = new SourceCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const original = `Summarize this transcript only:\n${LARGE_RECEIPT}`;
    let source: ReadPart[] = [];
    server.onTurn = async (options) => {
      source = await readEntireSource(sourceReader(server, options));
    };
    const result = await runtime.generateChat({
      messages: [{ content: original, role: "user" }],
      system: "Preserve the user's constraints in the summary.",
    });
    expect(source).toEqual([{ text: `User:\n${original}`, type: "text" }]);
    expect(codexTurnTextChars(server.turns[0]!.input)).toBeLessThanOrEqual(
      32 * 1024
    );
    expect(server.started[0]?.dynamicTools?.map((tool) => tool.name)).toEqual([
      "atlas_history_source",
    ]);
    expect(result.toolCalls).toEqual([]);
    expect(server.deleted).toEqual(["native-1"]);
  });
});

test("large legacy tool prompts retain source access and parse buffered Atlas calls without registering an application executor", async () => {
  await inTemporaryConfig(async () => {
    const server = new SourceCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const input = { ...makeInput(), executeToolCall: undefined };
    const originalMessages = structuredClone(input.messages);
    const chunks: string[] = [];
    server.responseText = [
      "The recorded results are ready.",
      "```atlas-tool-call",
      JSON.stringify({
        arguments: { action: "write_range", values: [[0, false]] },
        name: "spreadsheet",
      }),
      "```",
    ].join("\n");
    server.onTurn = async (options) => {
      const read = sourceReader(server, options);
      const first = resultData<{ text: string }>(
        await read({ action: "read", partIndex: 0 })
      );
      expect(first.text).toContain("Build the dashboard.");
    };

    const result = await runtime.streamChat(input, {
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        arguments: { action: "write_range", values: [[0, false]] },
        name: "spreadsheet",
      }),
    ]);
    expect(chunks).toEqual([result.content]);
    expect(result.content).toBe("The recorded results are ready.");
    expect(server.started[0]?.dynamicTools?.map((tool) => tool.name)).toEqual([
      "atlas_history_source",
    ]);
    expect(input.messages).toEqual(originalMessages);
    expect(
      (await readSubscriptionSession("chatgpt", input.conversationId!))
        ?.lastMessageCount
    ).toBe(originalMessages.length);
    expect(codexTurnTextChars(server.turns[0]!.input)).toBeLessThanOrEqual(
      32 * 1024
    );
  });
});

for (const failure of ["rejected", "cancelled"] as const) {
  test(`${failure} source-backed turns do not retain a reusable native binding`, async () => {
    await inTemporaryConfig(async () => {
      const server = new SourceCodexServer();
      const runtime = new ChatgptSubscriptionRuntime(server);
      const controller = new AbortController();
      server.onTurn = async (options) => {
        const read = sourceReader(server, options);
        expect((await read({ action: "list" })).success).toBe(true);
        if (failure === "cancelled") {
          controller.abort(new Error("Cancelled while reading source"));
          return;
        }
        throw new Error("Native turn failed after reading source");
      };
      const input = { ...makeInput(), signal: controller.signal };
      await expect(runtime.generateChat(input)).rejects.toBeInstanceOf(Error);
      expect(server.turns).toHaveLength(1);
      expect(server.deleted).toEqual(["native-1"]);
      expect(
        await readSubscriptionSession("chatgpt", input.conversationId!)
      ).toBeNull();
    });
  });
}
