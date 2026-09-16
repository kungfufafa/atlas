import { createAgentHarness } from "@atlas/agent";
import type { ChatMessage, ProviderClient } from "@atlas/core";
import { composeSoulSystemPrompt } from "@atlas/core";
import { createOpenCodeGoProvider } from "../../apps/server/src/providers/opencode-go";
import { buildChatSystemPrompt } from "../../packages/agent/src/chat-prompt";
import { appendRuntimeProfileRules } from "../../packages/db/src/constants";
import {
  DEFAULT_HARNESS_EVAL_MODEL,
  loadOpenCodeGoEvalEnv,
  type OpenCodeGoEvalEnv,
} from "./env";
import {
  EVAL_SCENARIOS,
  type EvalScenario,
  type ScenarioScore,
  scoreScenario,
} from "./scenarios";
import {
  createEvalToolState,
  createEvalTools,
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
  id: string;
  passed: boolean;
  replyPreview: string;
  score: number;
  toolCalls: string[];
}

export interface HarnessEvalReport {
  generatedAt: string;
  model: string;
  path: string;
  scenarios: ScenarioResult[];
  summary: {
    failed: number;
    meanScore: number;
    passed: number;
    transportOk: boolean;
  };
}

export interface RunHarnessEvalOptions {
  env?: OpenCodeGoEvalEnv;
  model?: string;
  promptOnly?: boolean;
  scenarioIds?: string[];
}

export function evalBasePrompt(scenario: EvalScenario): string {
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
    { includeMemory: true }
  );
  return appendRuntimeProfileRules(false, soul);
}

export function assembleEvalSystemPrompt(scenario: EvalScenario): string {
  const tools = createEvalTools(createEvalToolState(), {
    includeDecoy: scenario.includeDecoyTool,
  });
  return buildChatSystemPrompt(tools, {
    basePrompt: evalBasePrompt(scenario),
    channel: scenario.channel,
    enableToolLoop: true,
    soul: Boolean(scenario.soulIdentity || scenario.soulMemory),
    userContext: scenario.userContext,
  });
}

export async function runHarnessEval(
  options: RunHarnessEvalOptions = {}
): Promise<HarnessEvalReport> {
  const env = options.env ?? loadOpenCodeGoEvalEnv();
  const model = options.model ?? env.model ?? DEFAULT_HARNESS_EVAL_MODEL;
  const scenarios = EVAL_SCENARIOS.filter((scenario) =>
    options.scenarioIds?.length
      ? options.scenarioIds.includes(scenario.id)
      : true
  );

  let provider: ProviderClient | undefined;
  if (!options.promptOnly) {
    provider = createOpenCodeGoProvider({
      apiKey: env.apiKey,
      model: `opencode-go/${model}`,
      providerInstanceId: "harness-eval",
    });
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(
      await runScenario(scenario, {
        promptOnly: options.promptOnly === true,
        provider,
      })
    );
  }

  const passed = results.filter((result) => result.passed).length;
  const meanScore =
    results.reduce((sum, result) => sum + result.score, 0) /
    Math.max(results.length, 1);
  const transport = results.find((result) => result.id === "session_transport");

  return {
    generatedAt: new Date().toISOString(),
    model,
    path: options.promptOnly
      ? "prompt-assembly-only (no live provider)"
      : HARNESS_EVAL_PATH,
    scenarios: results,
    summary: {
      failed: results.length - passed,
      meanScore: Number(meanScore.toFixed(3)),
      passed,
      transportOk: transport ? transport.passed : false,
    },
  };
}

async function runScenario(
  scenario: EvalScenario,
  options: { promptOnly: boolean; provider?: ProviderClient }
): Promise<ScenarioResult> {
  const started = Date.now();
  const systemPrompt = assembleEvalSystemPrompt(scenario);
  const state = createEvalToolState();
  const tools = createEvalTools(state, {
    includeDecoy: scenario.includeDecoyTool,
  });

  if (options.promptOnly) {
    const promptScore = scorePromptOnly(scenario, systemPrompt);
    return {
      checks: promptScore.checks,
      dimension: scenario.dimension,
      durationMs: Date.now() - started,
      id: scenario.id,
      passed: promptScore.passed,
      replyPreview: "",
      score: promptScore.score,
      toolCalls: [],
    };
  }

  if (!options.provider) {
    throw new Error("Provider is required for live eval.");
  }

  const harness = createAgentHarness({ provider: options.provider, tools });
  const session = harness.createChatSession({
    channel: scenario.channel ?? "cli",
    enableToolLoop: true,
    soul: Boolean(scenario.soulIdentity || scenario.soulMemory),
    systemPrompt: evalBasePrompt(scenario),
    toolContext: { sessionId: `atlas-eval-${scenario.id}` },
    tools,
    userContext: scenario.userContext,
  });

  let reply = "";
  let error: string | undefined;
  try {
    reply = await session.send(scenario.prompt);
    for (const followUp of scenario.extraUserTurns ?? []) {
      reply = await session.send(followUp);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const history: readonly ChatMessage[] = session.getHistory();
  const scored = scoreScenario({
    error,
    history,
    reply,
    scenario,
    state,
    systemPrompt,
  });

  return {
    checks: scored.checks,
    dimension: scenario.dimension,
    durationMs: Date.now() - started,
    ...(scored.error ? { error: scored.error } : error ? { error } : {}),
    id: scenario.id,
    passed: scored.passed,
    replyPreview: reply.slice(0, 240),
    score: Number(scored.score.toFixed(3)),
    toolCalls: state.calls.map((call) => call.name),
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
    return {
      checks,
      passed: checks.prompt_has_whatsapp_rules,
      score: checks.prompt_has_whatsapp_rules ? 1 : 0,
    };
  }
  if (scenario.id === "memory_recall") {
    const checks = {
      prompt_has_coffee: systemPrompt.includes(USER_COFFEE),
      prompt_has_nickname: systemPrompt.includes(USER_NICKNAME),
    };
    const passed = Object.values(checks).every(Boolean);
    return { checks, passed, score: passed ? 1 : 0 };
  }
  return {
    checks: { skipped_live: true },
    passed: true,
    score: 0,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const promptOnly = argv.includes("--prompt-only");
  const outIndex = argv.indexOf("--out");
  const modelIndex = argv.indexOf("--model");
  const scenarioIds = argv.flatMap((arg, index) =>
    arg === "--scenario" && argv[index + 1] ? [argv[index + 1]!] : []
  );
  const report = await runHarnessEval({
    model: modelIndex >= 0 ? argv[modelIndex + 1] : undefined,
    promptOnly,
    scenarioIds: scenarioIds.length > 0 ? scenarioIds : undefined,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (outIndex >= 0 && argv[outIndex + 1]) {
    await Bun.write(argv[outIndex + 1]!, json);
  }
  if (report.summary.failed > 0 && !promptOnly) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
