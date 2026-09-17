import { DEFAULT_HARNESS_EVAL_MODEL } from "./env";

export const DEFAULT_STRONG_EVAL_MODEL = DEFAULT_HARNESS_EVAL_MODEL;
export const DEFAULT_WEAK_EVAL_MODEL = "deepseek-flash";

export const HARNESS_EVAL_USAGE = `Usage: bun run scripts/harness-eval/run.ts [options]

Live OpenCode Go eval of createAgentHarness.createChatSession.send
(buildChatSystemPrompt + generateReply + executeToolCall).

Ablation flags (independently togglable; defaults match iteration-2 product path):

  --model <id>              Model id (default: ${DEFAULT_HARNESS_EVAL_MODEL} or HARNESS_EVAL_MODEL)
  --work-rules              Append DEFAULT_AGENT_WORK_RULES via appendRuntimeProfileRules (default)
  --no-work-rules           Omit runtime work rules, including "do not invent tools"
  --allowlist               Include the # Assigned tools prompt section (default)
  --no-allowlist            Omit that roster; native schemas and the tool loop stay on
  --memory-retrieval        Bound MEMORY.md and attach memory_search/search_chats (default)
  --no-memory-retrieval     Dump MEMORY.md wholesale and omit memory retrieval tools (iter3 baseline)
  --memory-summarization    LLM-summarize omitted MEMORY.md facts when over cap (default)
  --no-memory-summarization Extractive recency only (iter5 summary-off baseline)
  --archive-index           Index profile memory-archive/ into memory_search (default)
  --no-archive-index        Skip archive files (iter5 archive-off baseline)
  --skill-learning          Run the post-turn skill learning loop (eval ON)
  --no-skill-learning       Disable that loop (default; product default is off)
  --native-schemas          Send native tool schemas to the provider (default)
  --no-native-schemas       Strip tools from provider generateChat/streamChat (eval-only wrap)
  --scenario <id>           Run one scenario (repeatable)
  --prompt-only             Score prompt assembly without a live provider
  --out <path>              Write the JSON report to this path
  --matrix                  Run allowlist × work-rules × {strong, weak} (native schemas on)
  --strong-model <id>       Strong model for --matrix (default: ${DEFAULT_STRONG_EVAL_MODEL})
  --weak-model <id>         Weak/flash model for --matrix (default: ${DEFAULT_WEAK_EVAL_MODEL})
  --out-dir <dir>           Directory for matrix JSON + markdown
  --help                    Print this help

Environment:
  OPENCODE_GO_API_KEY, OPENCODE_GO_BASE_URL, OPENCODE_GO_ENV_FILE
  HARNESS_EVAL_MODEL
  HARNESS_EVAL_WORK_RULES=0|1       (default 1)
  HARNESS_EVAL_ALLOWLIST=0|1        (default 1)
  HARNESS_EVAL_MEMORY_RETRIEVAL=0|1 (default 1)
  HARNESS_EVAL_MEMORY_SUMMARIZATION=0|1 (default 1)
  HARNESS_EVAL_ARCHIVE_INDEX=0|1    (default 1)
  HARNESS_EVAL_SKILL_LEARNING=0|1   (default 0)
  HARNESS_EVAL_NATIVE_SCHEMAS=0|1   (default 1)
  HARNESS_EVAL_STRONG_MODEL
  HARNESS_EVAL_WEAK_MODEL

Native-schema-off is an eval diagnostic: Atlas executeToolCall only runs
provider-emitted toolCalls, so stripping schemas typically prevents tool use
entirely. The published ablation matrix keeps native schemas ON.
`;

export interface HarnessEvalCliOptions {
  allowlist: boolean;
  archiveIndex: boolean;
  help: boolean;
  matrix: boolean;
  memoryRetrieval: boolean;
  memorySummarization: boolean;
  model?: string;
  nativeSchemas: boolean;
  out?: string;
  outDir?: string;
  promptOnly: boolean;
  scenarioIds?: string[];
  skillLearning: boolean;
  strongModel: string;
  weakModel: string;
  workRules: boolean;
}

export function parseBoolEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return false;
  }
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") {
    return true;
  }
  return fallback;
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseHarnessEvalArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): HarnessEvalCliOptions {
  const parsed: HarnessEvalCliOptions = {
    allowlist: parseBoolEnv(env, "HARNESS_EVAL_ALLOWLIST", true),
    archiveIndex: parseBoolEnv(env, "HARNESS_EVAL_ARCHIVE_INDEX", true),
    help: false,
    matrix: false,
    memoryRetrieval: parseBoolEnv(env, "HARNESS_EVAL_MEMORY_RETRIEVAL", true),
    memorySummarization: parseBoolEnv(
      env,
      "HARNESS_EVAL_MEMORY_SUMMARIZATION",
      true
    ),
    model: env.HARNESS_EVAL_MODEL?.trim() || undefined,
    nativeSchemas: parseBoolEnv(env, "HARNESS_EVAL_NATIVE_SCHEMAS", true),
    promptOnly: false,
    skillLearning: parseBoolEnv(env, "HARNESS_EVAL_SKILL_LEARNING", false),
    strongModel:
      env.HARNESS_EVAL_STRONG_MODEL?.trim() || DEFAULT_STRONG_EVAL_MODEL,
    weakModel: env.HARNESS_EVAL_WEAK_MODEL?.trim() || DEFAULT_WEAK_EVAL_MODEL,
    workRules: parseBoolEnv(env, "HARNESS_EVAL_WORK_RULES", true),
  };
  const scenarioIds: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--prompt-only":
        parsed.promptOnly = true;
        break;
      case "--matrix":
        parsed.matrix = true;
        break;
      case "--work-rules":
        parsed.workRules = true;
        break;
      case "--no-work-rules":
        parsed.workRules = false;
        break;
      case "--allowlist":
        parsed.allowlist = true;
        break;
      case "--no-allowlist":
        parsed.allowlist = false;
        break;
      case "--memory-retrieval":
        parsed.memoryRetrieval = true;
        break;
      case "--no-memory-retrieval":
        parsed.memoryRetrieval = false;
        break;
      case "--memory-summarization":
        parsed.memorySummarization = true;
        break;
      case "--no-memory-summarization":
        parsed.memorySummarization = false;
        break;
      case "--archive-index":
        parsed.archiveIndex = true;
        break;
      case "--no-archive-index":
        parsed.archiveIndex = false;
        break;
      case "--skill-learning":
        parsed.skillLearning = true;
        break;
      case "--no-skill-learning":
        parsed.skillLearning = false;
        break;
      case "--native-schemas":
        parsed.nativeSchemas = true;
        break;
      case "--no-native-schemas":
        parsed.nativeSchemas = false;
        break;
      case "--model":
        parsed.model = takeValue(argv, index, "--model");
        index += 1;
        break;
      case "--strong-model":
        parsed.strongModel = takeValue(argv, index, "--strong-model");
        index += 1;
        break;
      case "--weak-model":
        parsed.weakModel = takeValue(argv, index, "--weak-model");
        index += 1;
        break;
      case "--out":
        parsed.out = takeValue(argv, index, "--out");
        index += 1;
        break;
      case "--out-dir":
        parsed.outDir = takeValue(argv, index, "--out-dir");
        index += 1;
        break;
      case "--scenario":
        scenarioIds.push(takeValue(argv, index, "--scenario"));
        index += 1;
        break;
      default:
        break;
    }
  }

  if (scenarioIds.length > 0) {
    parsed.scenarioIds = scenarioIds;
  }
  return parsed;
}
