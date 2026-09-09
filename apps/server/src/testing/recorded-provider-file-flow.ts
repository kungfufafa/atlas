import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type {
  ChatMessage,
  LlmToolDefinition,
  ProviderInstance,
  ToolDefinition,
} from "@atlas/core";
import { http } from "msw";
import { setupServer } from "msw/node";
import {
  readFileTool,
  writeFileTool,
} from "../../../../packages/core/src/tools/builtin";
import { executeProtectedTool } from "../../../../packages/core/src/tools/execution";
import { createProviderForInstance } from "../providers/create";
import {
  type LlmCassette,
  normalizeCassetteExchanges,
} from "./llm-msw-cassette";

export interface RecordedFileFlow {
  cassette: string;
  cassetteArchive: string;
  cassetteArchiveSha256: string;
  cassetteFormattedSha256: string;
  cassetteSha256: string;
  fileSha256: string;
  id: string;
  kind: "probe" | "service";
  model: string;
  provider: "gemini" | "openai_compatible";
  trace: string;
  traceArchive: string;
  traceArchiveSha256: string;
  traceFormattedSha256: string;
  traceSha256: string;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function relocate<T>(value: T, original: string, current: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(original, current)) as T;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
  );
}

function capturedInput(
  body: Record<string, unknown>,
  provider: RecordedFileFlow["provider"]
): { system: string; tools: LlmToolDefinition[] } {
  assert.ok(Array.isArray(body.tools));
  if (provider === "gemini") {
    assert.deepEqual(body.generationConfig, {});
    const instruction = object(body.systemInstruction);
    assert.ok(Array.isArray(instruction.parts));
    const system = instruction.parts.map((part) => object(part).text).join("");
    const declarations = body.tools.flatMap((tool) => {
      const value = object(tool).functionDeclarations;
      assert.ok(Array.isArray(value));
      return value;
    });
    return { system, tools: declarations as LlmToolDefinition[] };
  }
  assert.ok(Array.isArray(body.messages));
  const system = object(body.messages[0]).content;
  assert.equal(typeof system, "string");
  assert.equal(body.stream, undefined);
  assert.equal(body.reasoning_effort, undefined);
  return {
    system: system as string,
    tools: body.tools.map(
      (tool) => object(tool).function
    ) as LlmToolDefinition[],
  };
}

function withoutGeneratedArtifactMetadata(value: unknown): unknown {
  const result = structuredClone(object(value));
  if (Array.isArray(result.artifacts)) {
    result.artifacts = result.artifacts.map((artifact) => {
      const fields = { ...object(artifact) };
      delete fields.id;
      delete fields.createdAt;
      delete fields.sessionId;
      return fields;
    });
  }
  return result;
}

async function readVerifiedRecording(
  fixtureDirectory: string,
  fixture: RecordedFileFlow,
  kind: "cassette" | "trace"
): Promise<unknown> {
  const bytes = await readFile(path.join(fixtureDirectory, fixture[kind]));
  const archive = await readFile(
    path.join(fixtureDirectory, fixture[`${kind}Archive`])
  );
  assert.equal(
    createHash("sha256").update(archive).digest("hex"),
    fixture[`${kind}ArchiveSha256`]
  );
  const original = gunzipSync(archive);
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    fixture[`${kind}Sha256`]
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    fixture[`${kind}FormattedSha256`]
  );
  const formatted = JSON.parse(bytes.toString());
  assert.deepEqual(formatted, JSON.parse(original.toString()));
  return formatted;
}

export async function replayRecordedFileFlow(
  fixtureDirectory: string,
  fixture: RecordedFileFlow
): Promise<{
  fileSha256: string;
  guardedCalls: number;
  httpExchanges: number;
}> {
  const cassette = (await readVerifiedRecording(
    fixtureDirectory,
    fixture,
    "cassette"
  )) as LlmCassette;
  const recordedTrace = (await readVerifiedRecording(
    fixtureDirectory,
    fixture,
    "trace"
  )) as ChatMessage[];
  const writeMessage = recordedTrace.find(
    (message) => message.role === "tool" && message.name === "write_file"
  );
  assert.ok(writeMessage?.role === "tool");
  const originalPath = object(JSON.parse(writeMessage.content)).path;
  assert.equal(typeof originalPath, "string");
  assert.ok(path.isAbsolute(originalPath as string));
  const originalWorkspace = path.dirname(path.dirname(originalPath as string));
  assert.ok(
    originalWorkspace.endsWith(
      "/orgs/live_provider_org/profiles/live_provider_profile"
    )
  );
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "atlas-recorded-file-flow-"))
  );
  const workspaceRoot = path.join(directory, "workspace");
  await mkdir(workspaceRoot);
  const exchanges = relocate(
    normalizeCassetteExchanges(cassette),
    originalWorkspace,
    workspaceRoot
  );
  const trace = relocate(recordedTrace, originalWorkspace, workspaceRoot);
  assert.ok(exchanges.length > 0);
  const first = exchanges[0]!;
  const captured = capturedInput(object(first.request.body), fixture.provider);
  const provenance = trace.find(
    (message) =>
      message.role === "assistant" && message.providerContentProvenance
  );
  const scope =
    provenance?.role === "assistant"
      ? provenance.providerContentProvenance
      : undefined;
  const endpoint = new URL(first.request.url);
  assert.equal(endpoint.username, "");
  assert.equal(endpoint.password, "");
  assert.equal(endpoint.search, "");
  const instance: ProviderInstance = {
    apiKey: "cassette-replay-key",
    baseUrl:
      fixture.provider === "gemini"
        ? undefined
        : `${endpoint.origin}${endpoint.pathname.replace(/\/chat\/completions$/, "")}`,
    createdAt: "2026-09-06T00:00:00.000Z",
    id: scope?.providerInstanceId ?? "recorded-provider",
    label: "Recorded provider",
    replayRevision: scope?.providerReplayRevision ?? "recorded-revision",
    type: fixture.provider,
  };
  const provider = createProviderForInstance(instance, fixture.model, {});
  assert.ok(provider);
  let replayIndex = 0;
  let guardedCalls = 0;
  let mismatch: unknown;
  const server = setupServer(
    http.all("*", async ({ request }) => {
      try {
        const exchange = exchanges[replayIndex];
        assert.ok(
          exchange,
          "Unexpected request after all recorded exchanges were consumed."
        );
        assert.equal(request.method, exchange.request.method);
        assert.equal(request.url, exchange.request.url);
        assert.deepEqual(await request.json(), exchange.request.body);
        assert.equal(exchange.response.encoding, "json");
        replayIndex += 1;
        return Response.json(exchange.response.body, {
          status: exchange.response.status,
        });
      } catch (error) {
        mismatch = error;
        return new Response("Cassette request mismatch", { status: 599 });
      }
    })
  );
  server.listen({ onUnhandledRequest: "error" });
  const executedCalls: string[] = [];
  try {
    for (const [index, message] of trace.entries()) {
      if (message.role !== "assistant") {
        continue;
      }
      const result = await provider.generateChat({
        messages: trace.slice(0, index),
        signal: AbortSignal.timeout(10_000),
        system: captured.system,
        tools: captured.tools,
      });
      if (mismatch) {
        throw mismatch;
      }
      assert.equal(result.content, message.content);
      assert.deepEqual(result.toolCalls ?? [], message.toolCalls ?? []);
      assert.deepEqual(
        result.assistantMessage.providerContent,
        message.providerContent
      );
      for (const call of result.toolCalls ?? []) {
        const tool = [writeFileTool, readFileTool].find(
          (candidate) => candidate.name === call.name
        ) as ToolDefinition | undefined;
        assert.ok(
          tool,
          "A recording attempted a tool outside the two-tool fixture scope."
        );
        const toolMessage = trace[index + 1];
        assert.ok(
          toolMessage?.role === "tool" && toolMessage.toolCallId === call.id
        );
        const actual = await executeProtectedTool(tool, call.arguments, {
          beforeToolCall: async () => {
            guardedCalls += 1;
          },
          orgId: "replay_org",
          orgRole: "member",
          profileId: "replay_profile",
          userId: "replay_user",
          workspaceRoot,
        });
        assert.ok(actual.success);
        assert.deepEqual(
          withoutGeneratedArtifactMetadata({
            ...object(actual.data),
            ...(actual.artifacts?.length
              ? { artifacts: actual.artifacts }
              : {}),
          }),
          withoutGeneratedArtifactMetadata(JSON.parse(toolMessage.content))
        );
        const actualPath = object(actual.data).path;
        assert.equal(typeof actualPath, "string");
        assert.ok(isWithin(workspaceRoot, actualPath as string));
        executedCalls.push(call.name);
      }
    }
    assert.deepEqual(executedCalls, ["write_file", "read_file"]);
    assert.equal(replayIndex, exchanges.length);
    assert.equal(guardedCalls, 2);
    const bytes = await readFile(
      path.join(workspaceRoot, "artifacts/provider-proof.txt")
    );
    const readMessage = trace.find(
      (message) => message.role === "tool" && message.name === "read_file"
    );
    assert.ok(readMessage?.role === "tool");
    assert.equal(
      bytes.toString(),
      object(JSON.parse(readMessage.content)).content
    );
    const last = trace.at(-1);
    assert.ok(
      last?.role === "assistant" && last.content.includes(bytes.toString())
    );
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(fileSha256, fixture.fileSha256);
    return {
      fileSha256,
      guardedCalls,
      httpExchanges: replayIndex,
    };
  } finally {
    server.close();
    await rm(directory, { force: true, recursive: true });
  }
}
