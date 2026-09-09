import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir as testTemporaryDirectory } from "node:os";
import path, { join as joinTestTemporaryPath } from "node:path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createAgentHarness } from "@atlas/agent";
import {
  buildToolExecutionContext,
  type ChatMessage,
  runWithUserConfigDir,
  type SubscriptionAuthState,
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
import { setClaudeRuntimeForTests } from "../runtimes";
import { readSubscriptionSession } from "../session-store";
import { createClaudeProvider } from "./provider";
import { type ClaudeAgentSdk, ClaudeSubscriptionRuntime } from "./runtime";
import type { ClaudeAtlasToolBridge } from "./structured-tool-bridge";

const SESSION_ID = "session_h12";
const SOURCE = "  Café — 日本語\nid,value\n00123,4\n";
type McpResult = {
  content: Array<{ text: string; type: string }>;
  isError?: boolean;
};

class AuthenticatedRuntime extends ClaudeSubscriptionRuntime {
  override async getAuthState(): Promise<SubscriptionAuthState> {
    // Authentication and model generation are the controlled peer, never live.
    return { authenticated: true, provider: "claude", status: "authenticated" };
  }
}

async function connectMcp(
  server: ClaudeAtlasToolBridge["server"],
  onAcknowledgement: (id: number, result: McpResult) => Promise<void>
) {
  const pending = new Map<
    string | number,
    (message: Record<string, unknown>) => void
  >();
  const transport = {
    async close() {},
    onmessage: undefined as ((message: unknown) => void) | undefined,
    async send(message: unknown) {
      const record = message as Record<string, unknown>;
      if (typeof record.id === "number" && record.result) {
        await onAcknowledgement(record.id, record.result as McpResult);
      }
      if (typeof record.id === "number" || typeof record.id === "string") {
        pending.get(record.id)?.(record);
        pending.delete(record.id);
      }
    },
    async start() {},
  };
  await server.instance.connect(
    transport as Parameters<typeof server.instance.connect>[0]
  );
  const request = (
    id: string | number,
    method: string,
    params: Record<string, unknown>
  ) =>
    new Promise<Record<string, unknown>>((resolve) => {
      pending.set(id, resolve);
      transport.onmessage?.({ id, jsonrpc: "2.0", method, params });
    });
  await request("initialize", "initialize", {
    capabilities: {},
    clientInfo: { name: "atlas-h12-controlled-peer", version: "1" },
    protocolVersion: "2025-11-25",
  });
  return {
    async call(
      id: number,
      name: string,
      args: Record<string, unknown>
    ): Promise<McpResult> {
      const response = await request(id, "tools/call", {
        arguments: args,
        name,
      });
      if (response.error) {
        throw new Error(JSON.stringify(response.error));
      }
      return response.result as McpResult;
    },
  };
}

type McpPeer = Awaited<ReturnType<typeof connectMcp>>;
type Scenario = "complete" | "conflict" | "cancel" | "invalid_path";

function toolValue(result: McpResult): Record<string, unknown> {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("MCP did not return the serialized Atlas tool result.");
  }
  return JSON.parse(text);
}

async function seedDatabase(db: DatabaseAdapter) {
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: "org_h12",
    name: "H12",
    slug: "h12",
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: "profile_h12",
    isDefault: true,
    isSuper: false,
    model: "claude::model-fixture",
    name: "H12",
    orgId: "org_h12",
    systemPrompt: "H12",
    updatedAt: now,
  });
  await db.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "web",
    createdAt: now,
    id: SESSION_ID,
    modelOverride: null,
    orgId: "org_h12",
    profileId: "profile_h12",
    title: null,
    userId: null,
  });
}

async function runScenario(scenario: Scenario) {
  const directory = await mkdtemp(
    joinTestTemporaryPath(testTemporaryDirectory(), "atlas-h12-")
  );
  try {
    await runWithUserConfigDir(directory, async () => {
      const database = await createSqliteDatabase(
        `file:${path.join(directory, "h12.sqlite")}`
      );
      await seedDatabase(database.adapter);
      const context = buildToolExecutionContext({
        orgId: "org_h12",
        profileId: "profile_h12",
        sessionId: SESSION_ID,
      });
      const workspace = context.workspaceRoot!;
      await mkdir(workspace, { recursive: true });
      const controller = new AbortController();
      const persistenceStarted = Promise.withResolvers<void>();
      const persistenceReleased = Promise.withResolvers<void>();
      let heldCheckpoint = false;
      let queryCount = 0;
      let outputPath = "";
      const acknowledged: Array<{
        id: number;
        toolCount: number;
        result?: McpResult;
      }> = [];
      const queryOptions: Array<Record<string, unknown>> = [];
      const queryRecords: Array<{
        closed: boolean;
        inputs: number;
        metadataReads: number;
        tools: number;
        inputSettled: Promise<unknown>;
      }> = [];

      const drive = async (peer: McpPeer, turn: number) => {
        if (turn > 1) {
          const read = await peer.call(1, "read_file", { path: outputPath });
          expect(read.isError).not.toBe(true);
          expect(toolValue(read).content).toContain("00123,4");
          return;
        }
        if (scenario === "invalid_path") {
          const rejected = await peer.call(9, "write_file", {
            content: "outside",
            path: "../outside.txt",
          });
          expect(rejected.isError).toBe(true);
          expect(existsSync(path.join(workspace, "../outside.txt"))).toBe(
            false
          );
        }
        const args = { content: SOURCE, path: "artifacts/report.txt" };
        const first = await peer.call(1, "write_file", args);
        expect(first.isError).not.toBe(true);
        outputPath = String(toolValue(first).path);
        expect(await readFile(outputPath, "utf8")).toBe(SOURCE);
        if (scenario === "conflict") {
          await peer.call(1, "write_file", {
            ...args,
            content: "conflicting replay",
          });
          return;
        }
        const replay = await peer.call(1, "write_file", args);
        expect(replay).toEqual(first);
        const read = await peer.call(2, "read_file", { path: outputPath });
        expect(read.isError).not.toBe(true);
        expect(toolValue(read).content).toContain("00123,4");
      };

      const sdk: ClaudeAgentSdk = {
        createSdkMcpServer,
        async deleteSession() {},
        query({ options = {}, prompt }) {
          const firstInput =
            typeof prompt === "string"
              ? Promise.resolve({ done: false as const, value: prompt })
              : prompt[Symbol.asyncIterator]().next();
          const queryRecord = {
            closed: false,
            inputSettled: firstInput.then((next) => {
              if (!next.done) {
                queryRecord.inputs += 1;
              }
            }),
            inputs: 0,
            metadataReads: 0,
            tools: 0,
          };
          queryRecords.push(queryRecord);
          return {
            async *[Symbol.asyncIterator]() {
              const next = await firstInput;
              if (next.done || queryRecord.closed) {
                return;
              }
              queryOptions.push(options);
              const turn = ++queryCount;
              yield {
                session_id: "native-h12",
                subtype: "init",
                type: "system",
              };
              const server = (
                options.mcpServers as { atlas: ClaudeAtlasToolBridge["server"] }
              ).atlas;
              const peer = await connectMcp(server, async (id, result) => {
                const rows =
                  await database.adapter.listMessagesForSession(SESSION_ID);
                acknowledged.push({
                  id,
                  result,
                  toolCount: rows.filter(
                    (row) => (row.payload as ChatMessage).role === "tool"
                  ).length,
                });
              });
              await drive(
                {
                  async call(id, name, args) {
                    expect(queryRecord.inputs).toBe(1);
                    expect(queryRecord.metadataReads).toBe(0);
                    queryRecord.tools += 1;
                    return await peer.call(id, name, args);
                  },
                },
                turn
              );
              yield {
                is_error: false,
                result: "Verified the persisted report.",
                session_id: "native-h12",
                subtype: "success",
                type: "result",
              };
            },
            close() {
              queryRecord.closed = true;
            },
            async interrupt() {},
            async supportedModels() {
              queryRecord.metadataReads += 1;
              return [{ value: "model-fixture" }];
            },
          };
        },
      };
      const runtime = new AuthenticatedRuntime({ sdk, turnTimeoutMs: 3000 });
      setClaudeRuntimeForTests(runtime);
      const makeSession = (initialHistory: ChatMessage[] = []) => {
        const session = createAgentHarness({
          provider: createClaudeProvider({ model: "model-fixture" }),
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
          "Write the report, replay its call and read the returned file.",
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
          expect(acknowledged).toEqual([]);
          controller.abort();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(turnSettled).toBe(false);
          expect(acknowledged).toEqual([]);
          persistenceReleased.resolve();
          await expect(pending).rejects.toThrow();
        } else if (scenario === "conflict") {
          await expect(pending).rejects.toThrow();
        } else {
          expect(await pending).toBe("Verified the persisted report.");
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
        expect(
          await readFile(path.join(workspace, "artifacts/report.txt"), "utf8")
        ).toBe(SOURCE);
        const outputs = (
          await readdir(path.join(workspace, "artifacts"))
        ).filter((name) => !name.endsWith(".atlas-meta.json"));
        expect(outputs).toEqual(["report.txt"]);
        const successfulWriteAcknowledgements = acknowledged.filter(
          (ack) => ack.id === 1 && !ack.result?.isError
        );
        for (const acknowledgement of successfulWriteAcknowledgements) {
          expect(acknowledgement.toolCount).toBeGreaterThanOrEqual(1);
        }
        if (scenario === "complete") {
          expect(successfulWriteAcknowledgements).toHaveLength(2);
          const reopened = makeSession(stored);
          expect(await reopened.send("Read the existing report again.")).toBe(
            "Verified the persisted report."
          );
          expect(queryOptions[1]?.resume).toBe("native-h12");
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
            await readSubscriptionSession("claude", SESSION_ID)
          ).toBeNull();
          expect(stored.at(-1)?.role).toBe("tool");
        }
        await Promise.all(queryRecords.map((query) => query.inputSettled));
        expect(queryCount).toBe(scenario === "complete" ? 2 : 1);
        const discoveryQueries = queryRecords.filter(
          (query) => query.metadataReads > 0
        );
        expect(queryRecords).toHaveLength(queryCount + discoveryQueries.length);
        for (const query of discoveryQueries) {
          expect(query).toMatchObject({ closed: true, inputs: 0, tools: 0 });
        }
      } finally {
        persistenceReleased.resolve();
        setClaudeRuntimeForTests(null);
        database.close();
      }
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test.each(["complete", "conflict", "cancel", "invalid_path"] as const)(
  "H12 actual MCP to protected files and SQLite: %s",
  async (scenario) => runScenario(scenario),
  10_000
);
