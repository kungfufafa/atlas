import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const DEFAULT_HARNESS_EVAL_MODEL = "kimi-k2.7-code";

export interface OpenCodeGoEvalEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = ENV_LINE.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!key) {
      continue;
    }
    values[key] = unquote(match[2] ?? "");
  }
  return values;
}

export function applyEnvFile(
  contents: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const parsed = parseEnvFile(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (!env[key]) {
      env[key] = value;
    }
  }
  return parsed;
}

export function loadOpenCodeGoEvalEnv(
  env: NodeJS.ProcessEnv = process.env
): OpenCodeGoEvalEnv {
  const envPath =
    env.OPENCODE_GO_ENV_FILE?.trim() || join(homedir(), ".opencode-go.env");
  if (existsSync(envPath)) {
    applyEnvFile(readFileSync(envPath, "utf8"), env);
  }

  const apiKey = env.OPENCODE_GO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENCODE_GO_API_KEY is required (set it in the environment or $HOME/.opencode-go.env)."
    );
  }

  return {
    apiKey,
    baseUrl: env.OPENCODE_GO_BASE_URL?.trim() || DEFAULT_OPENCODE_GO_BASE_URL,
    model: env.HARNESS_EVAL_MODEL?.trim() || DEFAULT_HARNESS_EVAL_MODEL,
  };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
