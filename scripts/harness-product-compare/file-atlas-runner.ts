import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BUILTIN_TOOL_IDS,
  type ChatMessage,
  type CustomModelEntry,
  getProfileSoulDir,
  type ProviderInstance,
  PYTHON_EXECUTE_TOOL_ID,
  runWithUserConfigDir,
  type ToolCall,
  type UserConfig,
} from "@atlas/core";
import {
  createSqliteDatabase,
  type DatabaseAdapter,
  ensureBuiltinToolDefinitions,
  ensurePythonExecuteToolDefinition,
} from "@atlas/db";
import { AgentService } from "../../apps/server/src/services/agent-service";
import { LlmUsageTracker } from "../../apps/server/src/services/llm-usage-tracker";
import { SessionTitleService } from "../../apps/server/src/services/session-title-service";

export const PREPARED_FILE_PYTHON =
  "/Users/apriansyahrs/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const FILE_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "file_stat",
  "search_files",
  "create_directory",
] as const;
const SOURCE_ROOTS = new Set(["input", "app"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BUDGET = {
  maxGeneratedTokens: 12_000,
  maxOutputTokens: 4096,
  maxProviderRequests: 24,
  timeoutMs: 300_000,
};
type Status = "completed" | "failed" | "budget_exceeded";

export interface FileAtlasRequest {
  budget: typeof MAX_BUDGET;
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
  proxyBaseUrl: string;
  pythonPath: string;
  runId: string;
  sourceDirectory: string;
  stateRoot?: string;
  taskTurns: string[];
  thinking?: { enabled: boolean; effort?: string };
}

interface FileEntry {
  bytes: number;
  path: string;
  sha256: string;
}

interface NativeEvent {
  arguments: unknown;
  callId: string;
  name: string;
  observedAt: string;
  result: unknown;
  sessionId: string;
  turnIndex: number;
}

interface TurnResult {
  elapsedMs: number;
  error?: string;
  finalText: string;
  index: number;
  input: string;
  review?: unknown;
  status: Status;
  title?: unknown;
}

export interface FileAtlasResult {
  artifacts: Array<{ callId: string; native: unknown; turnIndex: number }>;
  elapsedMs: number;
  error?: string;
  evidence: Record<string, unknown>;
  finalText: string;
  framework: "atlas";
  model: string;
  nativeEvents: NativeEvent[];
  nativeStateRoot?: string;
  profileArtifacts?: unknown;
  runId: string;
  sessions: Array<{
    history: readonly ChatMessage[];
    id: string;
    initialHistoryCount: number;
    persistedMessages: unknown;
    turns: TurnResult[];
  }>;
  sourceCopies: FileEntry[];
  status: Status;
  workspaceFiles: FileEntry[];
  workspaceRoot?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a nonempty string.`);
  }
  return value;
}

export function parseFileAtlasRequest(value: unknown): FileAtlasRequest {
  if (
    !record(value) ||
    ["expected", "oracle", "history", "fixtures"].some((key) => key in value)
  ) {
    throw new Error(
      "Use a request object without expected answers, oracle data or prior history."
    );
  }
  const model = textField(value.model, "model");
  const url = new URL(textField(value.proxyBaseUrl, "proxyBaseUrl"));
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
      "proxyBaseUrl must be a credential-free loopback HTTP origin."
    );
  }
  const metadata = value.modelMetadata;
  if (
    !(
      record(metadata) &&
      record(metadata.entry) &&
      record(metadata.evidence) &&
      metadata.entry.id === model &&
      metadata.evidence.model === model
    )
  ) {
    throw new Error(
      "Exact-model metadata and matching source evidence are required."
    );
  }
  for (const key of ["endpoint", "observedAt", "source"]) {
    textField(metadata.evidence[key], `modelMetadata.evidence.${key}`);
  }
  if (!record(value.budget)) {
    throw new Error("A shared trajectory budget is required.");
  }
  for (const [key, maximum] of Object.entries(MAX_BUDGET)) {
    const amount = value.budget[key];
    if (
      typeof amount !== "number" ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > maximum
    ) {
      throw new Error(`${key} must be a positive integer at most ${maximum}.`);
    }
  }
  if (
    !(
      Array.isArray(value.taskTurns) &&
      value.taskTurns.length > 0 &&
      value.taskTurns.every((turn) => typeof turn === "string" && turn.trim())
    )
  ) {
    throw new Error("taskTurns must contain the sequential user turns.");
  }
  const pythonPath = textField(value.pythonPath, "pythonPath");
  if (pythonPath !== PREPARED_FILE_PYTHON) {
    throw new Error(
      "Only the explicitly prepared Python interpreter is admitted in this track."
    );
  }
  if (!(value.taskTurns[0] as string).includes(pythonPath)) {
    throw new Error(
      "The initial task turn must contain the shared prepared-interpreter fact supplied to both harnesses."
    );
  }
  if (
    value.thinking !== undefined &&
    !(
      record(value.thinking) &&
      typeof value.thinking.enabled === "boolean" &&
      (value.thinking.effort === undefined ||
        typeof value.thinking.effort === "string")
    )
  ) {
    throw new Error(
      "thinking must declare enabled and an optional effort string."
    );
  }
  return {
    budget: value.budget as FileAtlasRequest["budget"],
    model,
    modelMetadata: metadata as FileAtlasRequest["modelMetadata"],
    proxyBaseUrl: url.origin,
    pythonPath,
    runId: textField(value.runId, "runId"),
    sourceDirectory: textField(value.sourceDirectory, "sourceDirectory"),
    ...(value.stateRoot === undefined
      ? {}
      : { stateRoot: textField(value.stateRoot, "stateRoot") }),
    taskTurns: value.taskTurns as string[],
    thinking: value.thinking as FileAtlasRequest["thinking"],
  };
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  );
}

async function scanFiles(
  root: string,
  strictSources: boolean
): Promise<FileEntry[]> {
  const found: FileEntry[] = [];
  let bytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      if (strictSources && !SOURCE_ROOTS.has(rel.split(sep)[0] ?? "")) {
        throw new Error(
          "Fixture source may contain only input/ and app/ trees, with no oracle or Soul state."
        );
      }
      if (entry.isSymbolicLink()) {
        if (strictSources) {
          throw new Error("Fixture source symlinks are not permitted.");
        }
        // Record no bytes from links: an escaping link must not make the trusted
        // observer read a canary, oracle, sibling state or host file.
        continue;
      }
      if (!contains(root, await realpath(path))) {
        throw new Error("Observed file path escaped its declared root.");
      }
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const info = await stat(path);
        if (info.nlink !== 1) {
          throw new Error(
            "Hard-linked files are not admitted as source or artifact evidence."
          );
        }
        if (
          info.size > 20_000_000 ||
          bytes + info.size > 60_000_000 ||
          found.length >= 1000
        ) {
          throw new Error(
            "Workspace inspection exceeded the fixed file/count/byte bounds."
          );
        }
        const content = await readFile(path);
        bytes += content.length;
        found.push({
          bytes: content.length,
          path: rel,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } else {
        throw new Error(
          "Special files are not valid fixture/artifact evidence."
        );
      }
    }
  }
  await walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function copySources(
  source: string,
  workspace: string
): Promise<FileEntry[]> {
  const entries = await scanFiles(source, true);
  if (!entries.length) {
    throw new Error(
      "The source fixture must contain at least one regular input file."
    );
  }
  for (const file of entries) {
    const target = join(workspace, file.path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await copyFile(join(source, file.path), target);
    // Private originals are read-only. Native workspace copies match Hermes's
    // regular-file preparation so in-place edits do not depend on the adapter.
    await chmod(target, 0o644);
    const copied = await readFile(target);
    if (createHash("sha256").update(copied).digest("hex") !== file.sha256) {
      throw new Error("Source bytes changed while copying the fixture.");
    }
  }
  return entries;
}

async function seed(db: DatabaseAdapter, request: FileAtlasRequest) {
  const orgId = "file_study_org";
  const profileId = "file_study_profile";
  const userId = "file_study_user";
  const now = new Date().toISOString();
  const provider: ProviderInstance = {
    apiKey: "benchmark-local",
    baseUrl: `${request.proxyBaseUrl}/runs/${encodeURIComponent(request.runId)}/v1`,
    createdAt: now,
    customModels: [request.modelMetadata.entry],
    id: "file_study_provider",
    label: "Native file study proxy",
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
    name: "Native file study",
    slug: orgId,
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "native-file@atlas.invalid",
    id: userId,
    name: "Synthetic operator",
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
  await ensureBuiltinToolDefinitions(db);
  await ensurePythonExecuteToolDefinition(db);
  for (const name of FILE_TOOLS) {
    await db.assignToolToProfile(profileId, BUILTIN_TOOL_IDS[name]);
  }
  await db.assignToolToProfile(profileId, PYTHON_EXECUTE_TOOL_ID);
  return {
    actor: {
      isPlatformAdmin: false as const,
      orgRole: "member" as const,
      userId,
    },
    orgId,
    profileId,
  };
}

function toolValue(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function capture(
  result: FileAtlasResult,
  history: readonly ChatMessage[],
  sessionId: string,
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
    const entry = calls.get(message.toolCallId);
    if (!entry) {
      continue;
    }
    const ids = observed.get(entry.assistant) ?? new Set<string>();
    if (ids.has(entry.call.id)) {
      continue;
    }
    const value = toolValue(message.content);
    result.nativeEvents.push({
      arguments: structuredClone(entry.call.arguments),
      callId: entry.call.id,
      name: entry.call.name,
      observedAt: new Date().toISOString(),
      result: value,
      sessionId,
      turnIndex,
    });
    if (record(value) && Array.isArray(value.artifacts)) {
      for (const artifact of value.artifacts) {
        result.artifacts.push({
          callId: entry.call.id,
          native: structuredClone(artifact),
          turnIndex,
        });
      }
    }
    ids.add(entry.call.id);
    observed.set(entry.assistant, ids);
  }
}

function deadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolveValue, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolveValue(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
    if (signal.aborted) {
      abort();
    }
  });
}

let running = false;

/** Sequential, process-local fixture adapter; callers launch each live run in its own process. */
export async function runAtlasFile(
  input: FileAtlasRequest
): Promise<FileAtlasResult> {
  const request = parseFileAtlasRequest(input);
  if (running) {
    throw new Error(
      "Native file runs require separate processes or sequential invocation."
    );
  }
  running = true;
  const originalTemporaryRoot = tmpdir();
  const priorEnvironment = { ...process.env };
  for (const name of Object.keys(process.env)) {
    delete process.env[name];
  }
  Object.assign(process.env, {
    ATLAS_PROCESS_NETWORK: "deny",
    ATLAS_PYTHON_PATH: request.pythonPath,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TZ: "UTC",
  });
  const started = performance.now();
  const signal = AbortSignal.timeout(request.budget.timeoutMs);
  const result: FileAtlasResult = {
    artifacts: [],
    elapsedMs: 0,
    evidence: {
      artifactScope:
        "Native tool artifact receipts, profile artifact listing, preserved bytes and model final text. Nonstreaming invocation does not exercise streaming artifact-created UI callbacks or download/upload transport.",
      assignedNativeTools: [...FILE_TOOLS, "python_execute"],
      budgetAuthority:
        "One root model-only proxy runId covers all turns and native auxiliary calls; the runner uses one total deadline.",
      environment:
        "Scrubbed runner environment; required native process sandbox with ATLAS_PROCESS_NETWORK=deny; supported exact ATLAS_PYTHON_PATH. No outer sandbox that conflicts with Atlas's required inner policy.",
      metadata: request.modelMetadata,
      preparedPythonPath: request.pythonPath,
      promptScope:
        "Normal AgentService profile/Soul/default work rules and intrinsic state tools. Only fixture source bytes are copied; no expected answer, replacement tool, benchmark skill or hidden interpreter hint is injected. Task prompts supplied identically to both harnesses contain the interpreter fact.",
      sourceScope:
        "Explicit input/ and app/ regular-file source trees; no symlinks, hardlinks, oracle files, skills or preexisting state.",
      toolScope:
        "Native filesystem plus python_execute only, alongside intrinsic org-memory/todo/question tools. No bash, network fetch, custom JavaScript, generic tool search, Office tools or converters assigned.",
    },
    finalText: "",
    framework: "atlas",
    model: request.model,
    nativeEvents: [],
    runId: request.runId,
    sessions: [],
    sourceCopies: [],
    status: "failed",
    workspaceFiles: [],
  };
  try {
    const source = await realpath(request.sourceDirectory);
    const parent = await realpath(request.stateRoot ?? originalTemporaryRoot);
    const roots = [
      await realpath(originalTemporaryRoot),
      await realpath("/private/tmp"),
    ];
    if (!roots.some((root) => contains(root, parent))) {
      throw new Error(
        "stateRoot must be an existing temporary directory parent."
      );
    }
    await stat(request.pythonPath);
    const directory = await realpath(
      await mkdtemp(join(parent, "atlas-native-file-"))
    );
    result.nativeStateRoot = directory;
    await runWithUserConfigDir(directory, async () => {
      const sqlite = await createSqliteDatabase(
        join(directory, "file-study.sqlite")
      );
      const tracker = await LlmUsageTracker.create();
      try {
        const identity = await seed(sqlite.adapter, request);
        const service = new AgentService(null, null, sqlite.adapter, tracker);
        await service.ensureSoulScaffolded(identity.orgId);
        const workspace = getProfileSoulDir(identity.orgId, identity.profileId);
        result.workspaceRoot = workspace;
        result.sourceCopies = await copySources(source, workspace);
        const id = await service.createSession(
          identity.orgId,
          "web",
          identity.profileId,
          identity.actor.userId,
          identity.actor
        );
        const session = await service.resolveSession(
          identity.orgId,
          id,
          identity.actor
        );
        if (!session) {
          throw new Error("Native authorized session could not be resolved.");
        }
        const entry: FileAtlasResult["sessions"][number] = {
          history: [],
          id,
          initialHistoryCount: session.getHistory().length,
          persistedMessages: [],
          turns: [],
        };
        result.sessions.push(entry);
        if (entry.initialHistoryCount !== 0) {
          throw new Error("Fresh native session was not empty.");
        }
        const observed = new WeakMap<ChatMessage, Set<string>>();
        const title = new SessionTitleService(sqlite.adapter, (orgId) =>
          service.getUserConfigForOrg(orgId)
        );
        try {
          for (const [index, userTurn] of request.taskTurns.entries()) {
            signal.throwIfAborted();
            const turnStart = performance.now();
            const turn: TurnResult = {
              elapsedMs: 0,
              finalText: "",
              index,
              input: userTurn,
              status: "failed",
            };
            entry.turns.push(turn);
            const checkpoint = async () =>
              capture(result, session.getHistory(), id, index, observed);
            try {
              turn.finalText = await session.send(userTurn, {
                onToolCheckpoint: checkpoint,
                signal,
              });
              result.finalText = turn.finalText;
              signal.throwIfAborted();
              try {
                await deadline(title.generateSessionTitle(id), signal);
                turn.title = (await sqlite.adapter.getSession(id))?.title;
              } catch (error) {
                turn.title = { error: String(error) };
              }
              signal.throwIfAborted();
              turn.review = await deadline(
                service
                  .getSkillPostTurnReviewService()
                  .runPostTurnSkillReview(id),
                signal
              );
              turn.status = "completed";
            } catch (error) {
              turn.error = String(error);
              turn.status = signal.aborted ? "budget_exceeded" : "failed";
              throw error;
            } finally {
              turn.elapsedMs = performance.now() - turnStart;
              await checkpoint();
            }
          }
          signal.throwIfAborted();
          result.status = "completed";
        } finally {
          entry.history = structuredClone(session.getHistory());
          entry.persistedMessages =
            await sqlite.adapter.listMessagesForSession(id);
          result.workspaceFiles = await scanFiles(workspace, false);
          result.profileArtifacts = await service.listProfileArtifacts(
            identity.orgId,
            identity.profileId
          );
        }
      } finally {
        result.evidence.observedUsage = tracker.getStats();
        sqlite.close();
      }
    });
  } catch (error) {
    result.error = String(error);
    result.status = signal.aborted ? "budget_exceeded" : "failed";
  } finally {
    result.elapsedMs = performance.now() - started;
    for (const name of Object.keys(process.env)) {
      delete process.env[name];
    }
    Object.assign(process.env, priorEnvironment);
    running = false;
  }
  return result;
}

if (import.meta.main) {
  console.log = (...values) => console.error(...values);
  console.info = (...values) => console.error(...values);
  console.debug = (...values) => console.error(...values);
  try {
    const file = process.argv[2];
    const request = JSON.parse(
      file ? await readFile(file, "utf8") : await Bun.stdin.text()
    );
    const result = await runAtlasFile(parseFileAtlasRequest(request));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "completed" ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: String(error), framework: "atlas", phase: "request", status: "failed" })}\n`
    );
    process.exitCode = 1;
  }
}
