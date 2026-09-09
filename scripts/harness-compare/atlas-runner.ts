import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentChatSession } from "@atlas/agent";
import {
  type ChatMessage,
  type CustomModelEntry,
  getCustomToolsDir,
  getProfileSoulDir,
  type JsonSchema,
  type ProviderInstance,
  runWithUserConfigDir,
  type ToolCall,
  type UserConfig,
} from "@atlas/core";
import { createSqliteDatabase, type DatabaseAdapter } from "@atlas/db";
import { AgentService } from "../../apps/server/src/services/agent-service";
import { LlmUsageTracker } from "../../apps/server/src/services/llm-usage-tracker";
import type { HarnessToolEvent, TaskObservation } from "./types";

type StreamHandlers = Parameters<AgentChatSession["sendStream"]>[1];

/**
 * Production AgentService comparison adapter. The parent owns task fixtures,
 * tool execution, provider credentials, wire capture and shared resource limits.
 * This adapter never receives an expected answer or a provider credential.
 *
 * CLI: bun scripts/harness-compare/atlas-runner.ts <request.json>
 * With no path, read one JSON request from stdin. Emit one JSON result on stdout;
 * preserve the disposable SQLite/profile directory for inspection, even on error.
 */
export interface AtlasComparisonRequest {
  model: string;
  modelMetadata: {
    entry: CustomModelEntry;
    evidence: {
      endpoint: string;
      model: string;
      observedAt: string;
      source: string;
    };
  };
  runId: string;
  serverBaseUrl: string;
  stream?: boolean;
  thinking?: { effort?: string; enabled: boolean };
  timeoutMs?: number;
  turns: string[];
}

interface SharedToolSchema {
  description: string;
  name: string;
  parallelSafe: boolean;
  parameters: JsonSchema;
}

interface CapturedToolEvent extends HarnessToolEvent {
  callId: string;
  completedAt?: string;
  observedAt: string;
  startedAt?: string;
  turnIndex: number;
}

interface TurnResult {
  elapsedMs: number;
  error?: RecordedError;
  finalText: string;
  index: number;
  input: string;
  status: NonNullable<TaskObservation["terminalStatus"]>;
}

interface RecordedError {
  code?: string;
  message: string;
  name: string;
  status?: number;
}

export interface AtlasComparisonResult {
  checkpoints: Array<{
    at: string;
    history: readonly ChatMessage[];
    turnIndex: number;
  }>;
  contextUsage: ReturnType<AgentChatSession["getContextUsage"]>;
  elapsedMs: number;
  error?: RecordedError;
  evidence: {
    assignedSharedTools: SharedToolSchema[];
    boundary: string;
    intrinsicTools: string;
    modelMetadata: AtlasComparisonRequest["modelMetadata"];
    mode: "send" | "stream";
    optionalIntegrations: string;
    promptComposition: string;
    providerBaseUrl: string;
    thinking: { effort?: string; enabled: boolean };
    terminalStatusScope: string;
    toolIsolation: string;
    unsandboxedCustomToolsOptIn: boolean;
  };
  finalText: string;
  framework: "atlas";
  history: readonly ChatMessage[];
  isolatedConfigDir?: string;
  model: string;
  persistedMessages: Awaited<
    ReturnType<DatabaseAdapter["listMessagesForSession"]>
  >;
  runId: string;
  sessionId?: string;
  status: NonNullable<TaskObservation["terminalStatus"]>;
  streamEvents: Array<{ at: string; event: unknown; turnIndex: number }>;
  toolEvents: CapturedToolEvent[];
  turnResults: TurnResult[];
  usage: ReturnType<LlmUsageTracker["getStats"]> | null;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Agreed properties of the shared synthetic tool backend, not inferred provider
// capabilities. The backend's OpenAI schema format has no parallelSafe field.
const SHARED_READ_TOOLS = new Set([
  "read_file",
  "list_files",
  "calculate",
  "fetch_document",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function requireLocalBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !LOCAL_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "serverBaseUrl must be a credential-free loopback HTTP origin."
    );
  }
  return url.origin;
}

export function parseAtlasComparisonRequest(
  value: unknown
): AtlasComparisonRequest {
  if (!isRecord(value)) {
    throw new Error("The Atlas runner request must be a JSON object.");
  }
  const model = requiredString(value.model, "model");
  const runId = requiredString(value.runId, "runId");
  const serverBaseUrl = requireLocalBaseUrl(
    requiredString(value.serverBaseUrl, "serverBaseUrl")
  );
  if (
    !(
      Array.isArray(value.turns) &&
      value.turns.length &&
      value.turns.every((turn) => typeof turn === "string" && turn.trim())
    )
  ) {
    throw new Error("turns must contain every user message in sequence.");
  }
  const metadata = value.modelMetadata;
  if (
    !(
      isRecord(metadata) &&
      isRecord(metadata.entry) &&
      isRecord(metadata.evidence)
    )
  ) {
    throw new Error("Exact-model metadata and its evidence are required.");
  }
  const evidence = metadata.evidence;
  if (metadata.entry.id !== model || evidence.model !== model) {
    throw new Error(
      "Metadata, evidence and selected model IDs must match exactly."
    );
  }
  const endpoint = requiredString(
    evidence.endpoint,
    "metadata evidence endpoint"
  );
  const endpointUrl = new URL(endpoint);
  if (
    !["http:", "https:"].includes(endpointUrl.protocol) ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash
  ) {
    throw new Error(
      "Metadata evidence must identify a credential-free HTTP endpoint."
    );
  }
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error("timeoutMs must be a positive finite number.");
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    throw new Error("stream must be a boolean when supplied.");
  }
  const thinking = value.thinking;
  if (
    thinking !== undefined &&
    (!isRecord(thinking) ||
      typeof thinking.enabled !== "boolean" ||
      (thinking.effort !== undefined && typeof thinking.effort !== "string"))
  ) {
    throw new Error(
      "thinking must contain enabled and an optional native effort."
    );
  }
  return {
    model,
    modelMetadata: {
      entry: metadata.entry as unknown as CustomModelEntry,
      evidence: {
        endpoint,
        model,
        observedAt: requiredString(
          evidence.observedAt,
          "metadata evidence observedAt"
        ),
        source: requiredString(evidence.source, "metadata evidence source"),
      },
    },
    runId,
    serverBaseUrl,
    stream: value.stream as boolean | undefined,
    thinking: thinking as AtlasComparisonRequest["thinking"],
    timeoutMs,
    turns: value.turns as string[],
  };
}

function readToolSchemas(value: unknown): SharedToolSchema[] {
  const schemas = isRecord(value) ? value.tools : value;
  if (!(Array.isArray(schemas) && schemas.length)) {
    throw new Error("The shared tool schema endpoint returned no tools.");
  }
  const names = new Set<string>();
  return schemas.map((item) => {
    const outer = isRecord(item) ? item : {};
    const schema = isRecord(outer.function) ? outer.function : outer;
    const name = requiredString(schema.name, "tool name");
    if (!TOOL_NAME_PATTERN.test(name) || names.has(name)) {
      throw new Error("Shared tool names must be valid and unique.");
    }
    names.add(name);
    if (!isRecord(schema.parameters)) {
      throw new Error(`The shared tool ${name} has no JSON parameters schema.`);
    }
    return {
      description: requiredString(
        schema.description,
        `description for ${name}`
      ),
      name,
      parallelSafe: SHARED_READ_TOOLS.has(name),
      parameters: schema.parameters as JsonSchema,
    };
  });
}

function recordedError(error: unknown): RecordedError {
  const record = isRecord(error) ? error : {};
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
    ...(typeof record.status === "number" ? { status: record.status } : {}),
  };
}

function toolResultFailed(value: unknown): boolean {
  return (
    isRecord(value) &&
    Boolean(
      value.error ||
        value.success === false ||
        value.ok === false ||
        value.isError === true
    )
  );
}

function parseToolResult(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function seedSharedTools(
  db: DatabaseAdapter,
  orgId: string,
  profileId: string,
  request: AtlasComparisonRequest,
  schemas: SharedToolSchema[]
): Promise<void> {
  const toolsDir = getCustomToolsDir();
  await mkdir(toolsDir, { recursive: true });
  const now = new Date().toISOString();
  for (const [index, schema] of schemas.entries()) {
    const modulePath = `compare-${index}-${schema.name}.js`;
    const endpoint = `${request.serverBaseUrl}/runs/${encodeURIComponent(request.runId)}/tools/${encodeURIComponent(schema.name)}`;
    await writeFile(
      join(toolsDir, modulePath),
      [
        `export const parameters = ${JSON.stringify(schema.parameters)};`,
        `export const parallelSafe = ${JSON.stringify(schema.parallelSafe)};`,
        "export async function run(input) {",
        `  const response = await fetch(${JSON.stringify(endpoint)}, {`,
        '    method: "POST",',
        '    headers: { "Content-Type": "application/json" },',
        "    body: JSON.stringify(input)",
        "  });",
        "  const text = await response.text();",
        '  if (!response.ok) throw new Error(["Shared tool HTTP", response.status, text].join(" "));',
        "  return JSON.parse(text);",
        "}",
        "",
      ].join("\n")
    );
    const toolId = `compare_tool_${index}`;
    await db.upsertTool({
      createdAt: now,
      description: schema.description,
      handlerConfig: { modulePath },
      handlerType: "javascript",
      id: toolId,
      name: schema.name,
      orgId,
      updatedAt: now,
    });
    await db.assignToolToProfile(profileId, toolId);
  }
}

async function seedSession(
  request: AtlasComparisonRequest,
  db: DatabaseAdapter,
  schemas: SharedToolSchema[]
): Promise<{
  actor: { isPlatformAdmin: false; orgRole: "member"; userId: string };
  orgId: string;
  profileId: string;
}> {
  const orgId = "harness_compare_org";
  const profileId = "harness_compare_profile";
  const userId = "harness_compare_user";
  const now = new Date().toISOString();
  const provider: ProviderInstance = {
    apiKey: "benchmark-local",
    baseUrl: `${request.serverBaseUrl}/runs/${encodeURIComponent(request.runId)}/v1`,
    createdAt: now,
    customModels: [request.modelMetadata.entry],
    id: "harness_compare_provider",
    label: "Harness comparison proxy",
    type: "openai_compatible",
    wireApi: "chat",
  };
  const config: UserConfig = {
    defaultProviderId: provider.id,
    providers: [provider],
    thinkingEnabled: request.thinking?.enabled ?? false,
    ...(request.thinking?.effort
      ? { thinkingEffort: request.thinking.effort }
      : {}),
    timezone: "UTC",
  };
  await db.upsertOrganization({
    createdAt: now,
    id: orgId,
    name: "Comparison",
    slug: orgId,
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "comparison@atlas.invalid",
    id: userId,
    name: "Comparison operator",
    passwordHash: "unused",
    updatedAt: now,
  });
  await db.upsertOrgMember({ createdAt: now, orgId, role: "member", userId });
  await db.upsertOrgAiConfig({ config, orgId, updatedAt: now });
  await db.upsertProfile({
    createdAt: now,
    id: profileId,
    isDefault: true,
    isSuper: false,
    model: `${provider.id}::${request.model}`,
    name: "Atlas",
    orgId,
    systemPrompt: "",
    updatedAt: now,
  });
  await mkdir(getProfileSoulDir(orgId, profileId), { recursive: true });
  await seedSharedTools(db, orgId, profileId, request, schemas);
  return {
    actor: { isPlatformAdmin: false, orgRole: "member", userId },
    orgId,
    profileId,
  };
}

function captureStreamHandlers(
  result: AtlasComparisonResult,
  turnIndex: number
): StreamHandlers {
  const pending = new Map<string, CapturedToolEvent>();
  const capture = (event: unknown) => {
    result.streamEvents.push({
      at: new Date().toISOString(),
      event: structuredClone(event),
      turnIndex,
    });
  };
  return {
    onChunk: (text) => capture({ text, type: "chunk" }),
    onThinking: (text) => capture({ text, type: "thinking" }),
    onToolEnd: (event) => {
      capture({ ...event, type: "tool_end" });
      const observed = pending.get(event.toolCallId);
      if (observed) {
        observed.completedAt = new Date().toISOString();
        observed.result = structuredClone(event.result);
        observed.isError = toolResultFailed(event.result);
      }
    },
    onToolStart: (event) => {
      capture({ ...event, type: "tool_start" });
      const observed: CapturedToolEvent = {
        arguments: structuredClone(event.input),
        callId: event.toolCallId,
        name: event.tool,
        observedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        turnIndex,
      };
      pending.set(event.toolCallId, observed);
      result.toolEvents.push(observed);
    },
  };
}

function collectCheckpointReceipts(
  result: AtlasComparisonResult,
  history: readonly ChatMessage[],
  turnIndex: number,
  observed: WeakMap<ChatMessage, Set<string>>
): void {
  const calls = new Map<string, { assistant: ChatMessage; call: ToolCall }>();
  for (const message of history) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        calls.set(call.id, { assistant: message, call });
      }
    }
    if (message.role !== "tool") {
      continue;
    }
    const correlated = calls.get(message.toolCallId);
    if (!correlated) {
      continue;
    }
    const { assistant, call } = correlated;
    const completedIds = observed.get(assistant) ?? new Set<string>();
    if (completedIds.has(call.id)) {
      continue;
    }
    const value = parseToolResult(message.content);
    result.toolEvents.push({
      arguments: structuredClone(call.arguments),
      callId: call.id,
      isError: toolResultFailed(value),
      name: call.name,
      observedAt: new Date().toISOString(),
      result: value,
      turnIndex,
    });
    // Call IDs may be reused in later model responses. Track the original
    // assistant message identity so repeated effects remain separate receipts;
    // copy-on-write pruning of older tool output does not invent another event.
    completedIds.add(call.id);
    observed.set(assistant, completedIds);
  }
}

export async function runAtlasComparison(
  input: AtlasComparisonRequest
): Promise<AtlasComparisonResult> {
  const request = parseAtlasComparisonRequest(input);
  const started = performance.now();
  const result: AtlasComparisonResult = {
    checkpoints: [],
    contextUsage: null,
    elapsedMs: 0,
    evidence: {
      assignedSharedTools: [],
      boundary:
        "Production AgentService -> profile/session authorization and prompt composition -> provider adapter -> protected custom tools -> file-backed SQLite; model/tool transport via shared loopback service.",
      intrinsicTools:
        "Production todo, questionnaire and org-memory tools remain present. Assigned external task capabilities match the shared tool schema; this is not an identical-total-tool-catalog comparison.",
      mode: request.stream ? "stream" : "send",
      modelMetadata: request.modelMetadata,
      optionalIntegrations:
        "Fresh profile and organization; no historical memories, learned skills, MCP, Composio, automation workers, UI or channel transport are seeded.",
      promptComposition:
        "Normal AgentService profile/Soul/default work rules, chat prompt and per-turn context; no benchmark answer or replacement system prompt injected.",
      providerBaseUrl: `${request.serverBaseUrl}/runs/${encodeURIComponent(request.runId)}/v1`,
      terminalStatusScope:
        "Invocation completion only; the independent task oracle determines whether the user's requested outcome was achieved.",
      thinking: request.thinking ?? { enabled: false },
      toolIsolation:
        "Production JavaScript custom-tool loader and subprocess policy. Tool modules call only the configured shared loopback endpoint; no retrySafe override.",
      unsandboxedCustomToolsOptIn:
        process.env.ATLAS_ALLOW_UNSANDBOXED_CUSTOM_TOOLS === "1",
    },
    finalText: "",
    framework: "atlas",
    history: [],
    model: request.model,
    persistedMessages: [],
    runId: request.runId,
    status: "failed",
    streamEvents: [],
    toolEvents: [],
    turnResults: [],
    usage: null,
  };
  const observedToolMessages = new WeakMap<ChatMessage, Set<string>>();
  const signal = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const configDir = await realpath(
      await mkdtemp(join(tmpdir(), "atlas-harness-compare-"))
    );
    result.isolatedConfigDir = configDir;
    await runWithUserConfigDir(configDir, async () => {
      const response = await fetch(`${request.serverBaseUrl}/tool-schemas`, {
        signal,
      });
      if (!response.ok) {
        throw new Error(`Shared tool schemas HTTP ${response.status}.`);
      }
      const schemas = readToolSchemas(await response.json());
      result.evidence.assignedSharedTools = schemas;
      const sqlite = await createSqliteDatabase(
        join(configDir, "comparison.sqlite")
      );
      let session: AgentChatSession | null = null;
      try {
        const seeded = await seedSession(request, sqlite.adapter, schemas);
        signal.throwIfAborted();
        const tracker = await LlmUsageTracker.create();
        const service = new AgentService(null, null, sqlite.adapter, tracker);
        const sessionId = await service.createSession(
          seeded.orgId,
          "web",
          seeded.profileId,
          seeded.actor.userId,
          seeded.actor
        );
        result.sessionId = sessionId;
        session = await service.resolveSession(
          seeded.orgId,
          sessionId,
          seeded.actor
        );
        if (!session) {
          throw new Error(
            "The isolated production session could not be resolved."
          );
        }
        try {
          for (const [index, inputTurn] of request.turns.entries()) {
            const turnStart = performance.now();
            result.finalText = "";
            const checkpoint = async () => {
              if (!session) {
                return;
              }
              const history = session.getHistory();
              result.checkpoints.push({
                at: new Date().toISOString(),
                history: structuredClone(history),
                turnIndex: index,
              });
              if (!request.stream) {
                collectCheckpointReceipts(
                  result,
                  history,
                  index,
                  observedToolMessages
                );
              }
            };
            try {
              signal.throwIfAborted();
              const options = { onToolCheckpoint: checkpoint, signal };
              const finalText = request.stream
                ? await session.sendStream(
                    inputTurn,
                    captureStreamHandlers(result, index),
                    options
                  )
                : await session.send(inputTurn, options);
              result.finalText = finalText;
              result.turnResults.push({
                elapsedMs: performance.now() - turnStart,
                finalText,
                index,
                input: inputTurn,
                status: "completed",
              });
            } catch (error) {
              result.error = recordedError(error);
              result.status = signal.aborted ? "budget_exceeded" : "failed";
              result.turnResults.push({
                elapsedMs: performance.now() - turnStart,
                error: result.error,
                finalText: "",
                index,
                input: inputTurn,
                status: result.status,
              });
              throw error;
            } finally {
              await checkpoint();
            }
          }
          result.status = "completed";
        } finally {
          result.usage = tracker.getStats();
          result.contextUsage = session.getContextUsage();
          result.history = structuredClone(session.getHistory());
          result.persistedMessages =
            await sqlite.adapter.listMessagesForSession(sessionId);
        }
      } finally {
        sqlite.close();
      }
    });
  } catch (error) {
    result.error ??= recordedError(error);
    result.status = signal.aborted ? "budget_exceeded" : "failed";
  }
  result.elapsedMs = performance.now() - started;
  return result;
}

if (import.meta.main) {
  console.log = (...values) => console.error(...values);
  console.info = (...values) => console.error(...values);
  console.debug = (...values) => console.error(...values);
  try {
    const filename = process.argv[2];
    const text = filename
      ? await readFile(filename, "utf8")
      : await Bun.stdin.text();
    const request = parseAtlasComparisonRequest(JSON.parse(text));
    const result = await runAtlasComparison(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "completed" ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: recordedError(error), framework: "atlas", phase: "request", status: "failed" })}\n`
    );
    process.exitCode = 1;
  }
}
