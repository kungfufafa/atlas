import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  BUILTIN_TOOL_IDS,
  type ChatMessage,
  getGlobalSkillsDir,
  getProfileSoulDir,
  type ProviderInstance,
  readBundledSkillMarkdown,
  runWithUserConfigDir,
  type ToolCall,
  type UserConfig,
} from "@atlas/core";
import {
  createSqliteDatabase,
  type DatabaseAdapter,
  ensureBuiltinToolDefinitions,
} from "@atlas/db";
import { AgentService } from "../../apps/server/src/services/agent-service";
import { LlmUsageTracker } from "../../apps/server/src/services/llm-usage-tracker";
import { SessionTitleService } from "../../apps/server/src/services/session-title-service";
import { SkillProposalService } from "../../apps/server/src/services/skill-proposal-service";
import { SkillSuggestionService } from "../../apps/server/src/services/skill-suggestion-service";
import { SkillsService } from "../../apps/server/src/services/skills-service";
import {
  MEMORY_BUDGET,
  type MemoryNativeEvent,
  type MemoryRunRequest,
  type MemoryRunResult,
  type MemorySessionResult,
} from "./memory-types";

// Actual builtins, not benchmark implementations of native memory operations.
const MEMORY_TOOLS = [
  "memory_write",
  "memory_search",
  "memory_list",
  "memory_update",
  "memory_delete",
  "search_chats",
  "get_conversation",
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "create_directory",
  "search_files",
  "file_stat",
] as const;
const MEMORY_SKILLS = [
  "update-profile-memory",
  "archive-profile-memory",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a nonempty string.`);
  }
  return value;
}

function turns(value: unknown, name: string): string[] {
  if (
    !(
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === "string" && item.trim())
    )
  ) {
    throw new Error(`${name} must contain nonempty user turns.`);
  }
  return value as string[];
}

export function parseMemoryRequest(value: unknown): MemoryRunRequest {
  if (!isRecord(value)) {
    throw new Error("Memory request must be an object.");
  }
  if ("expected" in value || "fixtures" in value || "history" in value) {
    throw new Error(
      "Evaluator facts, fixture memory and prior history cannot enter the runner."
    );
  }
  const model = requiredString(value.model, "model");
  const url = new URL(requiredString(value.proxyBaseUrl, "proxyBaseUrl"));
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
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
  if (
    value.condition !== "native-default" &&
    value.condition !== "explicit-memory"
  ) {
    throw new Error("Unknown memory condition.");
  }
  const metadata = value.modelMetadata;
  if (
    !(
      isRecord(metadata) &&
      isRecord(metadata.entry) &&
      isRecord(metadata.evidence) &&
      metadata.entry.id === model &&
      metadata.evidence.model === model
    )
  ) {
    throw new Error(
      "Atlas requires exact-model metadata and evidence matching the model ID."
    );
  }
  for (const key of ["endpoint", "observedAt", "source"] as const) {
    requiredString(metadata.evidence[key], `modelMetadata.evidence.${key}`);
  }
  const budget = value.budget;
  if (!isRecord(budget)) {
    throw new Error("An explicit shared trajectory budget is required.");
  }
  for (const [key, maximum] of Object.entries(MEMORY_BUDGET)) {
    const limit = budget[key];
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > maximum
    ) {
      throw new Error(
        `${key} must be a positive integer no greater than ${maximum}.`
      );
    }
  }
  if (
    value.coldControl !== undefined &&
    typeof value.coldControl !== "boolean"
  ) {
    throw new Error("coldControl must be boolean.");
  }
  const identity = value.recallIdentity ?? "same-owner";
  if (
    identity !== "same-owner" &&
    identity !== "different-user" &&
    identity !== "different-organization"
  ) {
    throw new Error("Unknown recall identity.");
  }
  if (
    value.thinking !== undefined &&
    !(
      isRecord(value.thinking) &&
      typeof value.thinking.enabled === "boolean" &&
      (value.thinking.effort === undefined ||
        typeof value.thinking.effort === "string")
    )
  ) {
    throw new Error(
      "thinking must specify enabled and an optional effort string."
    );
  }
  return {
    budget: budget as MemoryRunRequest["budget"],
    coldControl: value.coldControl as boolean | undefined,
    condition: value.condition,
    model,
    modelMetadata: metadata as MemoryRunRequest["modelMetadata"],
    proxyBaseUrl: url.origin,
    recallIdentity: identity,
    recallTurns: turns(value.recallTurns, "recallTurns"),
    runId: requiredString(value.runId, "runId"),
    ...(value.stateRoot === undefined
      ? {}
      : { stateRoot: requiredString(value.stateRoot, "stateRoot") }),
    thinking: value.thinking as MemoryRunRequest["thinking"],
    trainingTurns: turns(value.trainingTurns, "trainingTurns"),
  };
}

interface Identity {
  actor: { isPlatformAdmin: false; orgRole: "member"; userId: string };
  orgId: string;
  profileId: string;
}

function identityFor(
  phase: MemorySessionResult["phase"],
  request: MemoryRunRequest
): Identity {
  const newOrg =
    phase === "recall" && request.recallIdentity === "different-organization";
  const newUser = phase === "recall" && request.recallIdentity !== "same-owner";
  return {
    actor: {
      isPlatformAdmin: false,
      orgRole: "member",
      userId: newUser ? "memory_user_b" : "memory_user_a",
    },
    orgId: newOrg ? "memory_org_b" : "memory_org_a",
    profileId: newOrg ? "memory_profile_b" : "memory_profile_a",
  };
}

async function seedIdentity(
  db: DatabaseAdapter,
  request: MemoryRunRequest,
  identity: Identity
): Promise<void> {
  const now = new Date().toISOString();
  const provider: ProviderInstance = {
    apiKey: "benchmark-local",
    baseUrl: `${request.proxyBaseUrl}/runs/${encodeURIComponent(request.runId)}/v1`,
    createdAt: now,
    customModels: request.modelMetadata ? [request.modelMetadata.entry] : [],
    id: "memory_comparison_provider",
    label: "Memory comparison proxy",
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
  if (!(await db.getOrganizationById(identity.orgId))) {
    await db.upsertOrganization({
      createdAt: now,
      id: identity.orgId,
      name: "Memory study",
      slug: identity.orgId,
      updatedAt: now,
    });
    await db.upsertOrgAiConfig({
      config,
      orgId: identity.orgId,
      updatedAt: now,
    });
  }
  if (!(await db.getUserById(identity.actor.userId))) {
    await db.createUser({
      createdAt: now,
      email: `${identity.actor.userId}@atlas.invalid`,
      id: identity.actor.userId,
      name: "Memory study operator",
      passwordHash: "unused",
      updatedAt: now,
    });
  }
  await db.upsertOrgMember({
    createdAt: now,
    orgId: identity.orgId,
    role: "member",
    userId: identity.actor.userId,
  });
  if (!(await db.getProfile(identity.profileId))) {
    await db.upsertProfile({
      createdAt: now,
      id: identity.profileId,
      isDefault: true,
      isSuper: false,
      model: `${provider.id}::${request.model}`,
      name: "Atlas",
      orgId: identity.orgId,
      systemPrompt: "",
      updatedAt: now,
    });
  }
  await ensureBuiltinToolDefinitions(db);
  for (const name of MEMORY_TOOLS) {
    await db.assignToolToProfile(identity.profileId, BUILTIN_TOOL_IDS[name]);
  }
}

async function nativeService(
  db: DatabaseAdapter,
  tracker: LlmUsageTracker,
  identity: Identity
): Promise<AgentService> {
  for (const name of MEMORY_SKILLS) {
    const destination = join(getGlobalSkillsDir(), name);
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, "SKILL.md"),
      await readBundledSkillMarkdown(name)
    );
  }
  const skills = new SkillsService(db);
  await skills.syncDiscoveredSkills(identity.orgId);
  for (const name of MEMORY_SKILLS) {
    const skill = await db.getSkillByName(name);
    if (!skill) {
      throw new Error(`Native bundled memory skill is unavailable: ${name}.`);
    }
    await db.assignSkillToProfile(identity.profileId, skill.id);
  }
  const service = new AgentService(null, null, db, tracker);
  const proposals = new SkillProposalService(db, skills);
  service.setSkillsService(skills);
  service.setSkillProposalService(proposals);
  service.setSkillSuggestionService(
    new SkillSuggestionService(db, skills, proposals)
  );
  await service.ensureSoulScaffolded(identity.orgId);
  return service;
}

async function snapshot(
  db: DatabaseAdapter,
  identity: Identity
): Promise<unknown> {
  const root = getProfileSoulDir(identity.orgId, identity.profileId);
  const files: Record<
    string,
    { content?: string; sha256: string; bytes: number }
  > = {};
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const bytes = await readFile(fullPath);
        files[relative(root, fullPath)] = {
          bytes: bytes.length,
          ...(bytes.length <= 262_144
            ? { content: bytes.toString("utf8") }
            : {}),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
    }
  }
  await walk(root);
  return {
    files,
    identity,
    memories: await db.listMemories(
      identity.orgId,
      undefined,
      undefined,
      10_000
    ),
    orgMemoryProposals: await db.listOrgMemoryProposals(identity.orgId),
    skills: await db.listSkillsForProfile(identity.profileId),
  };
}

function parseToolResult(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function withinDeadline<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
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
  });
}

function captureReceipts(
  history: readonly ChatMessage[],
  session: MemorySessionResult,
  turnIndex: number,
  observed: WeakMap<ChatMessage, Set<string>>,
  events: MemoryNativeEvent[]
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
    events.push({
      arguments: structuredClone(entry.call.arguments),
      callId: entry.call.id,
      name: entry.call.name,
      observedAt: new Date().toISOString(),
      phase: session.phase,
      result: parseToolResult(message.content),
      sessionId: session.id,
      turnIndex,
    });
    ids.add(entry.call.id);
    observed.set(entry.assistant, ids);
  }
}

async function runSession(
  request: MemoryRunRequest,
  phase: MemorySessionResult["phase"],
  nativeStateRoot: string,
  result: MemoryRunResult,
  tracker: LlmUsageTracker,
  signal: AbortSignal
): Promise<void> {
  await runWithUserConfigDir(nativeStateRoot, async () => {
    const sqlite = await createSqliteDatabase(
      join(nativeStateRoot, "memory-study.sqlite")
    );
    try {
      const identity = identityFor(phase, request);
      await seedIdentity(sqlite.adapter, request, identity);
      const service = await nativeService(sqlite.adapter, tracker, identity);
      const titleService = new SessionTitleService(sqlite.adapter, (orgId) =>
        service.getUserConfigForOrg(orgId)
      );
      result.snapshots.push({
        label: `${phase}:before`,
        nativeStateRoot,
        state: await snapshot(sqlite.adapter, identity),
      });
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
        throw new Error("Native Atlas session could not be resolved.");
      }
      const record: MemorySessionResult = {
        id,
        initialHistoryCount: session.getHistory().length,
        nativeStateRoot,
        phase,
        turns: [],
      };
      result.sessions.push(record);
      if (record.initialHistoryCount !== 0) {
        throw new Error("New session contained previous conversation history.");
      }
      const observed = new WeakMap<ChatMessage, Set<string>>();
      const inputs =
        phase === "training" ? request.trainingTurns : request.recallTurns;
      try {
        for (const [index, input] of inputs.entries()) {
          signal.throwIfAborted();
          const started = performance.now();
          const turn = {
            elapsedMs: 0,
            finalText: "",
            index,
            input,
            status: "failed" as const,
          };
          const capture = async () =>
            captureReceipts(
              session.getHistory(),
              record,
              index,
              observed,
              result.nativeEvents
            );
          try {
            const finalText = await session.send(input, {
              onToolCheckpoint: capture,
              signal,
            });
            turn.finalText = finalText;
            if (phase === "recall") {
              result.finalText = finalText;
            }
            signal.throwIfAborted();
            let title: unknown;
            try {
              await withinDeadline(
                titleService.generateSessionTitle(id),
                signal
              );
              title = { value: (await sqlite.adapter.getSession(id))?.title };
            } catch (error) {
              title = { error: String(error) };
            }
            signal.throwIfAborted();
            // Same production hook as the interactive route, awaited to reach a
            // stable session boundary. Native default flag stays disabled.
            const review = await withinDeadline(
              service
                .getSkillPostTurnReviewService()
                .runPostTurnSkillReview(id),
              signal
            );
            record.turns.push({
              ...turn,
              elapsedMs: performance.now() - started,
              finalText,
              review,
              status: "completed",
              title,
            });
            if (phase === "recall") {
              result.finalText = finalText;
            }
          } catch (error) {
            record.turns.push({
              ...turn,
              elapsedMs: performance.now() - started,
              error: String(error),
              status: signal.aborted ? "budget_exceeded" : "failed",
            });
            throw error;
          } finally {
            await capture();
          }
        }
      } finally {
        record.finalHistory = structuredClone(session.getHistory());
        record.persistedMessages =
          await sqlite.adapter.listMessagesForSession(id);
        result.snapshots.push({
          label: `${phase}:after`,
          nativeStateRoot,
          state: await snapshot(sqlite.adapter, identity),
        });
      }
    } finally {
      sqlite.close();
    }
  });
}

async function freshRunDirectory(parent?: string): Promise<string> {
  const temporaryRoot = await realpath(tmpdir());
  const requested = resolve(parent ?? temporaryRoot);
  const canonical = await realpath(requested);
  const allowedRoots = [temporaryRoot, await realpath("/private/tmp")];
  if (
    !allowedRoots.some(
      (root) => canonical === root || canonical.startsWith(`${root}${sep}`)
    )
  ) {
    throw new Error(
      "Memory runner stateRoot must be a temporary directory parent."
    );
  }
  return realpath(await mkdtemp(join(canonical, "atlas-native-memory-")));
}

export async function runAtlasMemory(
  input: MemoryRunRequest
): Promise<MemoryRunResult> {
  const request = parseMemoryRequest(input);
  const started = performance.now();
  const signal = AbortSignal.timeout(request.budget.timeoutMs);
  const result: MemoryRunResult = {
    condition: request.condition,
    elapsedMs: 0,
    evidence: {
      assignedNativeTools: MEMORY_TOOLS,
      assignedNeutralSkills: MEMORY_SKILLS,
      backgroundReview:
        "Actual production post-turn skill review hook awaited after every successful user turn; native default false, no override.",
      budgetAuthority:
        "Root proxy enforces one runId across both sessions and auxiliary calls. Runner enforces one elapsed deadline.",
      coldControl: request.coldControl ?? false,
      identityControl: request.recallIdentity,
      identityScope:
        "Different-user uses a distinct DB user in the same profile: profile MEMORY.md is shared by design; user-scoped DB memory must be distinguished. Different-organization uses a distinct org and profile in the same SQLite database.",
      metadata: request.modelMetadata,
      omittedRoutes:
        "HTTP/auth transport, UI, channels and skill creation/review opt-in are outside this memory track.",
      productionPath:
        "Unmodified AgentService, authorization, profile prompt, native tools, bundled memory skills, file-backed SQLite. New service and reopened SQLite for B; no prior messages passed to B.",
      promptScope:
        "No seeded learned facts. Default Soul scaffold and two unmodified bundled memory skills are fixed context, not learned memory.",
      providerBaseUrl: `${request.proxyBaseUrl}/runs/${encodeURIComponent(request.runId)}/v1`,
      titleGeneration:
        "Actual SessionTitleService.generateSessionTitle invoked and awaited after each successful turn, matching the production route hook. Only the first eligible turn per session calls a provider; proxy ledger includes auxiliary usage that the AgentService tracker omits.",
      toolScope:
        "Focused native memory, conversation retrieval and guarded profile file capabilities plus production intrinsic org-memory/todo/question tools; not the entire installed product tool catalog.",
    },
    finalText: "",
    framework: "atlas",
    model: request.model,
    nativeEvents: [],
    runId: request.runId,
    sessions: [],
    snapshots: [],
    status: "failed",
  };
  const tracker = await LlmUsageTracker.create();
  try {
    const directory = await freshRunDirectory(request.stateRoot);
    const trainingRoot = join(directory, "training-state");
    await mkdir(trainingRoot);
    await runSession(
      request,
      "training",
      trainingRoot,
      result,
      tracker,
      signal
    );
    signal.throwIfAborted();
    const recallRoot = request.coldControl
      ? join(directory, "cold-recall-state")
      : trainingRoot;
    await mkdir(recallRoot, { recursive: true });
    await runSession(request, "recall", recallRoot, result, tracker, signal);
    signal.throwIfAborted();
    result.status = "completed";
  } catch (error) {
    result.error =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    result.status = signal.aborted ? "budget_exceeded" : "failed";
  }
  result.evidence.observedUsage = tracker.getStats();
  result.elapsedMs = performance.now() - started;
  return result;
}

if (import.meta.main) {
  console.log = (...values) => console.error(...values);
  console.info = (...values) => console.error(...values);
  console.debug = (...values) => console.error(...values);
  try {
    const file = process.argv[2];
    const input = JSON.parse(
      file ? await readFile(file, "utf8") : await Bun.stdin.text()
    );
    const result = await runAtlasMemory(parseMemoryRequest(input));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "completed" ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: String(error), framework: "atlas", phase: "request", status: "failed" })}\n`
    );
    process.exitCode = 1;
  }
}
