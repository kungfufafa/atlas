import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir as testTemporaryDirectory } from "node:os";
import path, { join as joinTestTemporaryPath } from "node:path";
import { PassThrough } from "node:stream";
import { createAgentHarness } from "@atlas/agent";
import {
  buildToolExecutionContext,
  type ChatMessage,
  runWithUserConfigDir,
} from "@atlas/core";
import { createSqliteDatabase, type DatabaseAdapter } from "@atlas/db";
import {
  readFileTool,
  writeFileTool,
} from "../../../../../../packages/core/src/tools/builtin";
import {
  loadSessionHistory,
  wrapPersistedSession,
} from "../../../services/session-persistence";
import { JsonRpcStdioClient, type JsonRpcStdioProcess } from "../jsonrpc-stdio";
import { setChatgptRuntimeForTests } from "../runtimes";
import { readSubscriptionSession } from "../session-store";
import { CodexAppServer, type CodexDynamicToolResult } from "./app-server";
import { createChatgptProvider } from "./provider";
import { ChatgptSubscriptionRuntime } from "./runtime";

const SESSION_ID = "session_h11";
const SOURCE = "  Café — 日本語\nid,value\n00123,4\n";
type Scenario =
  | "complete"
  | "conflict"
  | "disconnect"
  | "cancel"
  | "invalid_path";
interface RpcMessage {
  error?: unknown;
  id: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

/** The peer replaces native authentication/inference, never the Atlas layers. */
class PersistentCodexPeer extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: RpcMessage[] = [];
  readonly failures: unknown[] = [];
  private readonly pending = new Map<string, (message: RpcMessage) => void>();
  private buffer = "";
  private turn = 0;

  constructor(
    private readonly onAcknowledgement: (message: RpcMessage) => Promise<void>,
    private readonly onTurn: (
      peer: PersistentCodexPeer,
      turn: number
    ) => Promise<void>
  ) {
    super();
    this.stdin.on("data", (chunk) => {
      this.buffer += String(chunk);
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line) as RpcMessage;
          this.messages.push(message);
          void this.receive(message).catch((error) => {
            this.failures.push(error);
            this.disconnect();
          });
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  kill(): void {
    this.emit("exit", 0);
  }

  disconnect(): void {
    this.emit("exit", 1);
  }

  async call(
    requestId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<CodexDynamicToolResult> {
    const response = new Promise<RpcMessage>((resolve) =>
      this.pending.set(requestId, resolve)
    );
    this.send({
      id: requestId,
      method: "item/tool/call",
      params: {
        arguments: args,
        callId,
        threadId: "native-h11",
        tool,
        turnId: `turn-${this.turn}`,
      },
    });
    const message = await response;
    if (message.error) {
      throw new Error(JSON.stringify(message.error));
    }
    return message.result as CodexDynamicToolResult;
  }

  finish(): void {
    this.send({
      method: "item/agentMessage/delta",
      params: {
        delta: "Verified the persisted report.",
        threadId: "native-h11",
        turnId: `turn-${this.turn}`,
      },
    });
    this.send({
      method: "turn/completed",
      params: {
        threadId: "native-h11",
        turn: { id: `turn-${this.turn}`, status: "completed" },
      },
    });
  }

  private send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private async receive(message: RpcMessage): Promise<void> {
    if (!message.method) {
      await this.onAcknowledgement(message);
      const requestId = String(message.id);
      this.pending.get(requestId)?.(message);
      this.pending.delete(requestId);
      return;
    }
    let result: unknown;
    switch (message.method) {
      case "account/read":
        result = { account: { type: "chatgpt" } };
        break;
      case "model/list":
        result = { data: [{ id: "model-fixture", isDefault: true }] };
        break;
      case "thread/start":
      case "thread/resume":
        result = { thread: { id: "native-h11" } };
        break;
      case "thread/delete":
      case "turn/interrupt":
        result = {};
        break;
      case "turn/start":
        this.turn++;
        this.send({
          id: message.id,
          result: { turn: { id: `turn-${this.turn}` } },
        });
        await this.onTurn(this, this.turn);
        return;
      default:
        throw new Error(`Unexpected controlled peer method: ${message.method}`);
    }
    this.send({ id: message.id, result });
  }
}

function toolValue(result: CodexDynamicToolResult): Record<string, unknown> {
  const item = result.contentItems.find((entry) => entry.type === "inputText");
  if (item?.type !== "inputText") {
    throw new Error("No Atlas text result was returned over JSON-RPC.");
  }
  return JSON.parse(item.text);
}

async function seedDatabase(db: DatabaseAdapter) {
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: "org_h11",
    name: "H11",
    slug: "h11",
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: "profile_h11",
    isDefault: true,
    isSuper: false,
    model: "chatgpt::model-fixture",
    name: "H11",
    orgId: "org_h11",
    systemPrompt: "H11",
    updatedAt: now,
  });
  await db.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "web",
    createdAt: now,
    id: SESSION_ID,
    modelOverride: null,
    orgId: "org_h11",
    profileId: "profile_h11",
    title: null,
    userId: null,
  });
}

async function runScenario(scenario: Scenario) {
  const directory = await mkdtemp(
    joinTestTemporaryPath(testTemporaryDirectory(), "atlas-h11-")
  );
  try {
    await runWithUserConfigDir(directory, async () => {
      const database = await createSqliteDatabase(
        `file:${path.join(directory, "h11.sqlite")}`
      );
      await seedDatabase(database.adapter);
      const context = buildToolExecutionContext({
        orgId: "org_h11",
        profileId: "profile_h11",
        sessionId: SESSION_ID,
      });
      const workspace = context.workspaceRoot!;
      await mkdir(workspace, { recursive: true });
      const originalPath = path.join(workspace, "original.csv");
      await writeFile(originalPath, SOURCE);
      const controller = new AbortController();
      const persistenceStarted = Promise.withResolvers<void>();
      const persistenceReleased = Promise.withResolvers<void>();
      let heldCheckpoint = false;
      let outputPath = "";
      const responses: CodexDynamicToolResult[] = [];
      const acknowledgements: Array<{ requestId: string; toolCount: number }> =
        [];
      const peer = new PersistentCodexPeer(
        async (message) => {
          const rows =
            await database.adapter.listMessagesForSession(SESSION_ID);
          acknowledgements.push({
            requestId: String(message.id),
            toolCount: rows.filter(
              (row) => (row.payload as ChatMessage).role === "tool"
            ).length,
          });
        },
        async (native, turn) => {
          if (turn > 1) {
            responses.push(
              await native.call("followup-read", "followup-call", "read_file", {
                path: outputPath,
              })
            );
            native.finish();
            return;
          }
          if (scenario === "invalid_path") {
            responses.push(
              await native.call(
                "invalid-request",
                "invalid-call",
                "write_file",
                { content: "outside", path: "../outside.txt" }
              )
            );
          }
          const args = { content: SOURCE, path: "artifacts/report.txt" };
          const first = await native.call(
            "write-request",
            "write-call",
            "write_file",
            args
          );
          responses.push(first);
          outputPath = String(toolValue(first).path);
          if (scenario === "disconnect") {
            native.disconnect();
            return;
          }
          if (scenario === "conflict") {
            await native.call(
              "conflicting-replay",
              "write-call",
              "write_file",
              { ...args, content: "conflicting replay" }
            );
            return;
          }
          responses.push(
            await native.call("write-replay", "write-call", "write_file", args)
          );
          responses.push(
            await native.call("read-request", "read-call", "read_file", {
              path: outputPath,
            })
          );
          native.finish();
        }
      );
      const server = new CodexAppServer({
        client: new JsonRpcStdioClient(peer),
        command: path.join(directory, "no-live-runtime"),
        runtimeVersion: "0.150.1",
        turnTimeoutMs: 3000,
      });
      const runtime = new ChatgptSubscriptionRuntime(server);
      setChatgptRuntimeForTests(runtime);
      const makeSession = (initialHistory: ChatMessage[] = []) => {
        const session = createAgentHarness({
          provider: createChatgptProvider({ model: "model-fixture" }),
          tools: [writeFileTool, readFileTool],
        }).createChatSession({ initialHistory, toolContext: context });
        return wrapPersistedSession(SESSION_ID, session, database.adapter, {
          async beforePersist() {
            if (scenario === "cancel" && !heldCheckpoint) {
              heldCheckpoint = true;
              persistenceStarted.resolve();
              await persistenceReleased.promise;
            }
          },
        });
      };
      try {
        const session = makeSession();
        const pending = session.sendStream(
          "Save the report, replay the call, then read its returned file reference.",
          { onChunk() {} },
          { signal: controller.signal }
        );
        let turnSettled = false;
        void pending
          .finally(() => {
            turnSettled = true;
          })
          .catch(() => undefined);
        if (scenario === "cancel") {
          await persistenceStarted.promise;
          expect(
            await readFile(path.join(workspace, "artifacts/report.txt"), "utf8")
          ).toBe(SOURCE);
          expect(
            await database.adapter.listMessagesForSession(SESSION_ID)
          ).toEqual([]);
          expect(acknowledgements).toEqual([]);
          controller.abort();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(turnSettled).toBe(false);
          expect(acknowledgements).toEqual([]);
          persistenceReleased.resolve();
          await expect(pending).rejects.toThrow();
        } else if (scenario === "conflict" || scenario === "disconnect") {
          await expect(pending).rejects.toThrow();
        } else {
          expect(await pending).toBe("Verified the persisted report.");
          expect(peer.failures).toEqual([]);
        }
        await database.reopen();
        let stored = await loadSessionHistory(database.adapter, SESSION_ID);
        const calls = stored.flatMap((message) =>
          message.role === "assistant" ? (message.toolCalls ?? []) : []
        );
        const results = stored.filter((message) => message.role === "tool");
        const expectedCount =
          scenario === "invalid_path" ? 3 : scenario === "complete" ? 2 : 1;
        expect(results).toHaveLength(expectedCount);
        expect(calls.map((call) => call.id)).toEqual(
          results.map((message) => message.toolCallId)
        );
        expect(new Set(calls.map((call) => call.id)).size).toBe(expectedCount);
        expect(await readFile(originalPath, "utf8")).toBe(SOURCE);
        expect(
          await readFile(path.join(workspace, "artifacts/report.txt"), "utf8")
        ).toBe(SOURCE);
        expect(existsSync(path.join(workspace, "../outside.txt"))).toBe(false);
        const outputs = (
          await readdir(path.join(workspace, "artifacts"))
        ).filter((name) => !name.endsWith(".atlas-meta.json"));
        expect(outputs).toEqual(["report.txt"]);
        if (scenario !== "cancel") {
          expect(
            acknowledgements.find((ack) => ack.requestId === "write-request")
              ?.toolCount
          ).toBe(scenario === "invalid_path" ? 2 : 1);
        }
        if (scenario === "complete" || scenario === "invalid_path") {
          const offset = scenario === "invalid_path" ? 1 : 0;
          expect(responses[offset]?.success).toBe(true);
          expect(responses[offset + 1]).toEqual(responses[offset]);
          expect(toolValue(responses[offset + 2]!).content).toContain(
            "00123,4"
          );
          expect(
            acknowledgements.find((ack) => ack.requestId === "read-request")
              ?.toolCount
          ).toBe(expectedCount);
          if (scenario === "invalid_path") {
            expect(responses[0]?.success).toBe(false);
          }
        }
        if (scenario === "complete") {
          const reopened = makeSession(stored);
          expect(await reopened.send("Read the existing report again.")).toBe(
            "Verified the persisted report."
          );
          expect(
            peer.messages.filter((message) => message.method === "thread/start")
          ).toHaveLength(1);
          expect(
            peer.messages.filter(
              (message) => message.method === "thread/resume"
            )
          ).toHaveLength(1);
          expect(toolValue(responses.at(-1)!).content).toContain("00123,4");
          await database.reopen();
          stored = await loadSessionHistory(database.adapter, SESSION_ID);
          expect(
            stored.filter(
              (message) =>
                message.role === "tool" && message.name === "write_file"
            )
          ).toHaveLength(1);
          expect(
            stored.filter(
              (message) =>
                message.role === "tool" && message.name === "read_file"
            )
          ).toHaveLength(2);
        } else if (scenario !== "invalid_path") {
          expect(
            await readSubscriptionSession("chatgpt", SESSION_ID)
          ).toBeNull();
          expect(stored.at(-1)?.role).toBe("tool");
        }
      } finally {
        persistenceReleased.resolve();
        runtime.close();
        setChatgptRuntimeForTests(null);
        database.close();
      }
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test.each([
  "complete",
  "conflict",
  "disconnect",
  "cancel",
  "invalid_path",
] as const)(
  "H11 actual JSON-RPC to protected files and SQLite: %s",
  async (scenario) => runScenario(scenario),
  10_000
);
