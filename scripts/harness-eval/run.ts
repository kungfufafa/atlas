import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createAgentHarness } from "@atlas/agent";
import {
  type ChatMessage,
  composeSoulSystemPrompt,
  type GenerateChatInput,
  type ProviderClient,
} from "@atlas/core";
import { createOpenCodeGoProvider } from "../../apps/server/src/providers/opencode-go";
import { buildChatSystemPrompt } from "../../packages/agent/src/chat-prompt";
import { appendRuntimeProfileRules } from "../../packages/db/src/constants";
import {
  DEFAULT_HARNESS_EVAL_MODEL,
  loadOpenCodeGoEvalEnv,
  type OpenCodeGoEvalEnv,
} from "./env";
import { HARNESS_EVAL_USAGE, parseHarnessEvalArgs } from "./flags";
import {
  type AblationCellSummary,
  type AblationMatrixSummary,
  buildMatrixConfigs,
  computeAllowlistDeltas,
  DEFAULT_MATRIX_OUT_DIR,
  matrixCellFilename,
  renderAblationMarkdown,
  summarizeReport,
} from "./matrix";
import {
  EVAL_SCENARIOS,
  type EvalScenario,
  LEARNING_SCENARIO_IDS,
  memoryFactsForScenario,
  type ScenarioScore,
  scenarioToolOptions,
  scoreScenario,
} from "./scenarios";
import { createInHarnessSkillStore } from "./skill-store";
import {
  ARCHIVE_BADGE,
  CHAT_DOSSIER,
  createEvalToolState,
  createEvalTools,
  OVERFLOW_CODE,
  USER_COFFEE,
  USER_NICKNAME,
} from "./tools";

export const HARNESS_EVAL_PATH =
  "createAgentHarness.createChatSession.send (buildChatSystemPrompt + generateReply + executeToolCall)";

export interface ScenarioResult {
  checks: Record<string, boolean>;
  dimension: string;
  durationMs: number;
  error?: string;
  gradedScore: number;
  id: string;
  passed: boolean;
  replyPreview: string;
  score: number;
  toolCalls: string[];
  toolPrecision: number;
  toolRecall: number;
}

export interface HarnessEvalAblation {
  allowlist: boolean;
  memoryRetrieval: boolean;
  nativeSchemas: boolean;
  skillLearning: boolean;
  workRules: boolean;
}

export interface HarnessEvalReport {
  ablation: HarnessEvalAblation;
  generatedAt: string;
  model: string;
  path: string;
  scenarios: ScenarioResult[];
  summary: {
    failed: number;
    meanGradedScore: number;
    meanScore: number;
    meanToolPrecision: number;
    meanToolRecall: number;
    passed: number;
    transportOk: boolean;
  };
}

export interface RunHarnessEvalOptions {
  allowlist?: boolean;
  env?: OpenCodeGoEvalEnv;
  memoryRetrieval?: boolean;
  model?: string;
  nativeSchemas?: boolean;
  promptOnly?: boolean;
  scenarioIds?: string[];
  skillLearning?: boolean;
  workRules?: boolean;
}

export interface EvalPromptOptions {
  allowlist?: boolean;
  memoryRetrieval?: boolean;
  workRules?: boolean;
}

const ABLATION_QUESTION =
  "Does the iteration-2 assigned-tool allowlist reduce tool hallucination when work-rules are OFF and/or on a weaker model?";

export function evalBasePrompt(
  scenario: EvalScenario,
  options: EvalPromptOptions = {}
): string {
  const memoryRetrieval = options.memoryRetrieval !== false;
  const soul = composeSoulSystemPrompt(
    {
      directory: "eval",
      files: {
        ...(scenario.soulIdentity ? { soul: scenario.soulIdentity } : {}),
        ...(scenario.soulMemory ? { memory: scenario.soulMemory } : {}),
      },
      loaded: [
        ...(scenario.soulIdentity ? ["soul"] : []),
        ...(scenario.soulMemory ? ["memory"] : []),
      ],
    },
    {
      includeMemory: true,
      memoryByteCap: memoryRetrieval ? scenario.memoryByteCap : null,
    }
  );
  const workRules = options.workRules !== false;
  return workRules ? appendRuntimeProfileRules(false, soul) : soul;
}

export function assembleEvalSystemPrompt(
  scenario: EvalScenario,
  options: EvalPromptOptions = {}
): string {
  const tools = createEvalTools(
    createEvalToolState(),
    scenarioToolOptions(scenario, options.memoryRetrieval !== false)
  );
  return buildChatSystemPrompt(tools, {
    basePrompt: evalBasePrompt(scenario, options),
    channel: scenario.channel,
    enableToolLoop: true,
    includeAssignedToolsAllowlist: options.allowlist !== false,
    soul: Boolean(scenario.soulIdentity || scenario.soulMemory),
    userContext: scenario.userContext,
  });
}

export function omitNativeToolSchemas(
  provider: ProviderClient
): ProviderClient {
  const stripTools = (input: GenerateChatInput): GenerateChatInput => ({
    ...input,
    tools: undefined,
  });
  return {
    generateChat(input) {
      return provider.generateChat(stripTools(input));
    },
    generateText(input) {
      return provider.generateText(input);
    },
    name: provider.name,
    streamChat(input, handlers) {
      return provider.streamChat(stripTools(input), handlers);
    },
    ...(provider.managesContext === undefined
      ? {}
      : { managesContext: provider.managesContext }),
  };
}

export async function runHarnessEval(
  options: RunHarnessEvalOptions = {}
): Promise<HarnessEvalReport> {
  const env = options.env ?? loadOpenCodeGoEvalEnv();
  const model = options.model ?? env.model ?? DEFAULT_HARNESS_EVAL_MODEL;
  const workRules = options.workRules !== false;
  const allowlist = options.allowlist !== false;
  const nativeSchemas = options.nativeSchemas !== false;
  const memoryRetrieval = options.memoryRetrieval !== false;
  const skillLearning = options.skillLearning === true;
  const ablation: HarnessEvalAblation = {
    allowlist,
    memoryRetrieval,
    nativeSchemas,
    skillLearning,
    workRules,
  };
  const scenarios = EVAL_SCENARIOS.filter((scenario) =>
    options.scenarioIds?.length
      ? options.scenarioIds.includes(scenario.id)
      : true
  );

  let provider: ProviderClient | undefined;
  if (!options.promptOnly) {
    const live = createOpenCodeGoProvider({
      apiKey: env.apiKey,
      model: `opencode-go/${model}`,
      providerInstanceId: "harness-eval",
    });
    provider = nativeSchemas ? live : omitNativeToolSchemas(live);
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(
      await runScenario(scenario, {
        allowlist,
        memoryRetrieval,
        promptOnly: options.promptOnly === true,
        provider,
        skillLearning,
        workRules,
      })
    );
  }

  const passed = results.filter((result) => result.passed).length;
  const meanScore =
    results.reduce((sum, result) => sum + result.score, 0) /
    Math.max(results.length, 1);
  const meanGradedScore =
    results.reduce((sum, result) => sum + result.gradedScore, 0) /
    Math.max(results.length, 1);
  const meanToolPrecision =
    results.reduce((sum, result) => sum + result.toolPrecision, 0) /
    Math.max(results.length, 1);
  const meanToolRecall =
    results.reduce((sum, result) => sum + result.toolRecall, 0) /
    Math.max(results.length, 1);
  const transport = results.find((result) => result.id === "session_transport");

  return {
    ablation,
    generatedAt: new Date().toISOString(),
    model,
    path: options.promptOnly
      ? "prompt-assembly-only (no live provider)"
      : HARNESS_EVAL_PATH,
    scenarios: results,
    summary: {
      failed: results.length - passed,
      meanGradedScore: Number(meanGradedScore.toFixed(3)),
      meanScore: Number(meanScore.toFixed(3)),
      meanToolPrecision: Number(meanToolPrecision.toFixed(3)),
      meanToolRecall: Number(meanToolRecall.toFixed(3)),
      passed,
      transportOk: transport ? transport.passed : false,
    },
  };
}

async function runScenario(
  scenario: EvalScenario,
  options: {
    allowlist: boolean;
    memoryRetrieval: boolean;
    promptOnly: boolean;
    provider?: ProviderClient;
    skillLearning: boolean;
    workRules: boolean;
  }
): Promise<ScenarioResult> {
  const started = Date.now();
  const promptOptions: EvalPromptOptions = {
    allowlist: options.allowlist,
    memoryRetrieval: options.memoryRetrieval,
    workRules: options.workRules,
  };
  const systemPrompt = assembleEvalSystemPrompt(scenario, promptOptions);
  const state = createEvalToolState(
    options.memoryRetrieval
      ? {
          chats: [...(scenario.chatTranscripts ?? [])],
          memories: memoryFactsForScenario(scenario),
        }
      : {}
  );
  const tools = createEvalTools(
    state,
    scenarioToolOptions(scenario, options.memoryRetrieval)
  );

  if (options.promptOnly) {
    const promptScore = scorePromptOnly(scenario, systemPrompt);
    return {
      checks: promptScore.checks,
      dimension: scenario.dimension,
      durationMs: Date.now() - started,
      gradedScore: promptScore.gradedScore,
      id: scenario.id,
      passed: promptScore.passed,
      replyPreview: "",
      score: promptScore.score,
      toolCalls: [],
      toolPrecision: promptScore.toolPrecision,
      toolRecall: promptScore.toolRecall,
    };
  }

  if (!options.provider) {
    throw new Error("Provider is required for live eval.");
  }

  const skillStore = createInHarnessSkillStore();
  const twoPhase = Boolean(scenario.phase2Prompt);
  const harness = createAgentHarness({
    provider: options.provider,
    tools,
  });
  const session = harness.createChatSession({
    channel: scenario.channel ?? "cli",
    enableToolLoop: true,
    includeAssignedToolsAllowlist: options.allowlist,
    skillLearning: {
      enabled: options.skillLearning,
      store: skillStore,
    },
    soul: Boolean(scenario.soulIdentity || scenario.soulMemory),
    systemPrompt: evalBasePrompt(scenario, promptOptions),
    toolContext: { sessionId: `atlas-eval-${scenario.id}` },
    tools,
    userContext: scenario.userContext,
  });

  let reply = "";
  let error: string | undefined;
  let phase1Calls: string[] = [];
  try {
    reply = await session.send(scenario.prompt);
    for (const followUp of scenario.extraUserTurns ?? []) {
      reply = await session.send(followUp);
    }
    phase1Calls = state.calls.map((call) => call.name);

    if (twoPhase && scenario.phase2Prompt) {
      const phase2State = createEvalToolState(
        options.memoryRetrieval
          ? {
              chats: [...(scenario.chatTranscripts ?? [])],
              memories: memoryFactsForScenario(scenario),
            }
          : {}
      );
      const phase2Tools = createEvalTools(
        phase2State,
        scenarioToolOptions(scenario, options.memoryRetrieval)
      );
      const phase2 = createAgentHarness({
        provider: options.provider,
        tools: phase2Tools,
      }).createChatSession({
        channel: scenario.channel ?? "cli",
        enableToolLoop: true,
        includeAssignedToolsAllowlist: options.allowlist,
        skillLearning: {
          enabled: false,
          store: skillStore,
        },
        soul: Boolean(scenario.soulIdentity || scenario.soulMemory),
        systemPrompt: evalBasePrompt(scenario, promptOptions),
        toolContext: { sessionId: `atlas-eval-${scenario.id}-phase2` },
        tools: phase2Tools,
        userContext: scenario.userContext,
      });
      reply = await phase2.send(scenario.phase2Prompt);
      const phase2History: readonly ChatMessage[] = phase2.getHistory();
      const scored = scoreScenario({
        error,
        history: phase2History,
        learnedSkills: skillStore.snapshot(),
        phase1Calls,
        reply,
        scenario,
        skillLearning: options.skillLearning,
        state: phase2State,
        systemPrompt,
      });
      return {
        checks: scored.checks,
        dimension: scenario.dimension,
        durationMs: Date.now() - started,
        ...(scored.error ? { error: scored.error } : error ? { error } : {}),
        gradedScore: scored.gradedScore,
        id: scenario.id,
        passed: scored.passed,
        replyPreview: reply.slice(0, 240),
        score: Number(scored.score.toFixed(3)),
        toolCalls: phase2State.calls.map((call) => call.name),
        toolPrecision: scored.toolPrecision,
        toolRecall: scored.toolRecall,
      };
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const history: readonly ChatMessage[] = session.getHistory();
  const scored = scoreScenario({
    error,
    history,
    learnedSkills: skillStore.snapshot(),
    phase1Calls,
    reply,
    scenario,
    skillLearning: options.skillLearning,
    state,
    systemPrompt,
  });

  return {
    checks: scored.checks,
    dimension: scenario.dimension,
    durationMs: Date.now() - started,
    ...(scored.error ? { error: scored.error } : error ? { error } : {}),
    gradedScore: scored.gradedScore,
    id: scenario.id,
    passed: scored.passed,
    replyPreview: reply.slice(0, 240),
    score: Number(scored.score.toFixed(3)),
    toolCalls: state.calls.map((call) => call.name),
    toolPrecision: scored.toolPrecision,
    toolRecall: scored.toolRecall,
  };
}

function scorePromptOnly(
  scenario: EvalScenario,
  systemPrompt: string
): ScenarioScore {
  if (scenario.id === "channel_whatsapp") {
    const checks = {
      prompt_has_whatsapp_rules: systemPrompt.includes(
        "WhatsApp only supports"
      ),
    };
    const passed = checks.prompt_has_whatsapp_rules;
    return {
      checks,
      gradedScore: passed ? 1 : 0,
      passed,
      score: passed ? 1 : 0,
      toolPrecision: 1,
      toolRecall: 1,
    };
  }
  if (scenario.id === "memory_recall") {
    const checks = {
      prompt_has_coffee: systemPrompt.includes(USER_COFFEE),
      prompt_has_nickname: systemPrompt.includes(USER_NICKNAME),
    };
    const passed = Object.values(checks).every(Boolean);
    return {
      checks,
      gradedScore: passed ? 1 : 0,
      passed,
      score: passed ? 1 : 0,
      toolPrecision: 1,
      toolRecall: 1,
    };
  }
  if (scenario.id === "memory_archive_needle") {
    const checks = {
      prompt_omits_archive_needle: !systemPrompt.includes(ARCHIVE_BADGE),
    };
    const passed = checks.prompt_omits_archive_needle;
    return {
      checks,
      gradedScore: passed ? 1 : 0,
      passed,
      score: passed ? 1 : 0,
      toolPrecision: 1,
      toolRecall: 1,
    };
  }
  if (scenario.id === "memory_search_chats") {
    const checks = {
      prompt_omits_dossier: !systemPrompt.includes(CHAT_DOSSIER),
    };
    const passed = checks.prompt_omits_dossier;
    return {
      checks,
      gradedScore: passed ? 1 : 0,
      passed,
      score: passed ? 1 : 0,
      toolPrecision: 1,
      toolRecall: 1,
    };
  }
  if (scenario.id === "memory_bounded_dump") {
    const checks = {
      prompt_omits_overflow_code: !systemPrompt.includes(OVERFLOW_CODE),
    };
    const passed = checks.prompt_omits_overflow_code;
    return {
      checks,
      gradedScore: passed ? 1 : 0,
      passed,
      score: passed ? 1 : 0,
      toolPrecision: 1,
      toolRecall: 1,
    };
  }
  if ((LEARNING_SCENARIO_IDS as readonly string[]).includes(scenario.id)) {
    return {
      checks: { skipped_live: true },
      gradedScore: 0,
      passed: true,
      score: 0,
      toolPrecision: 1,
      toolRecall: 1,
    };
  }
  return {
    checks: { skipped_live: true },
    gradedScore: 0,
    passed: true,
    score: 0,
    toolPrecision: 1,
    toolRecall: 1,
  };
}

export async function runAblationMatrix(input: {
  env?: OpenCodeGoEvalEnv;
  outDir?: string;
  scenarioIds?: string[];
  strongModel: string;
  weakModel: string;
}): Promise<AblationMatrixSummary> {
  const outDir = input.outDir ?? DEFAULT_MATRIX_OUT_DIR;
  await mkdir(outDir, { recursive: true });
  const configs = buildMatrixConfigs({
    strongModel: input.strongModel,
    weakModel: input.weakModel,
  });
  const cells: AblationCellSummary[] = [];

  for (const config of configs) {
    process.stderr.write(
      `matrix cell: ${config.modelClass} allowlist=${config.allowlist ? "on" : "off"} workRules=${config.workRules ? "on" : "off"} model=${config.model}\n`
    );
    const report = await runHarnessEval({
      allowlist: config.allowlist,
      env: input.env,
      model: config.model,
      nativeSchemas: config.nativeSchemas,
      scenarioIds: input.scenarioIds,
      workRules: config.workRules,
    });
    const reportPath = join(outDir, matrixCellFilename(config));
    await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    cells.push(summarizeReport(report, config, reportPath));
  }

  const summary: AblationMatrixSummary = {
    cells,
    deltas: computeAllowlistDeltas(cells),
    generatedAt: new Date().toISOString(),
    nativeSchemas: true,
    path: HARNESS_EVAL_PATH,
    question: ABLATION_QUESTION,
    strongModel: input.strongModel,
    weakModel: input.weakModel,
  };

  await Bun.write(
    join(outDir, "ablation-matrix.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  await Bun.write(
    join(outDir, "ablation-summary.md"),
    renderAblationMarkdown(summary)
  );
  return summary;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const flags = parseHarnessEvalArgs(argv);
  if (flags.help) {
    process.stdout.write(`${HARNESS_EVAL_USAGE}\n`);
    return;
  }

  if (flags.matrix) {
    const summary = await runAblationMatrix({
      outDir: flags.outDir,
      scenarioIds: flags.scenarioIds,
      strongModel: flags.strongModel,
      weakModel: flags.weakModel,
    });
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    process.stdout.write(json);
    if (flags.out) {
      await Bun.write(flags.out, json);
    }
    return;
  }

  const report = await runHarnessEval({
    allowlist: flags.allowlist,
    memoryRetrieval: flags.memoryRetrieval,
    model: flags.model,
    nativeSchemas: flags.nativeSchemas,
    promptOnly: flags.promptOnly,
    scenarioIds: flags.scenarioIds,
    skillLearning: flags.skillLearning,
    workRules: flags.workRules,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (flags.out) {
    await Bun.write(flags.out, json);
  }
  if (report.summary.failed > 0 && !flags.promptOnly) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
